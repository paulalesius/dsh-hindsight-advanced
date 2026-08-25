/**
 * The automatic per-turn recall: on the first step of each turn the latest
 * user message is queried — and the bank's active standing directives are
 * listed — and both become a plugin-sourced snapshot message (the same
 * pattern `time-context` uses for the clock). Rules are rendered in their
 * own section, so a stored rule reaches the model every turn even when the
 * recall matches nothing.
 *
 * Assembly runs BEFORE the pre-step waterfall, so the memory cannot ride
 * the system prompt for its own turn; the snapshot instead rides the
 * pre-step decision, which the loop appends to the first step of each
 * turn right after the message that triggered the recall — so the
 * context row lands in the transcript below that message, newest at the
 * bottom, and never above it.
 *
 * The lookup is bounded: a stopped or slow server costs at most
 * `autoContextTimeoutMs` and the turn proceeds without memory. To keep a
 * slow bank off the critical path, the work is started AHEAD of the turn
 * that pays for it: when a turn stops (no live tool calls, no fresh
 * steering) a detached job runs the same recall + directive listing for
 * the turn's own message — while the user is reading or typing the next
 * one — and the next turn's first step consumes the cached result without
 * a bank call. The trade (the same one the Hermes integration ships as
 * its default): from the second turn on the snapshot targets the PREVIOUS
 * turn's message, not the current one — the current message is already in
 * the model context, and the memory layer is durable knowledge. The first
 * turn has no cache and takes the original bounded synchronous path, as
 * does any turn whose job failed. `prefetch: false` (config) turns the
 * job off entirely: every turn takes the synchronous path, and the
 * snapshot targets the CURRENT message — at the cost of the bank's
 * latency on the turn's first model call.
 *
 * The plugin only ever APPENDS a snapshot; it never replaces or erases a
 * previous turn's snapshot, so the model context accumulates one snapshot
 * per distinct turn (the durable log keeps every snapshot for replay and
 * audit). An identical recall re-commits no duplicate block (no churn) —
 * the turn instead gets a marker row naming the applied memories (one
 * compact line each), so the UI still shows exactly what memory was
 * applied that turn; an empty recall leaves the existing snapshots in
 * place.
 *
 * @module dsh-plugin-hindsight-advanced/autorecall
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

import type { Mount } from './bank.ts'
import { composeRecallQuery, findRetainedSnapshots, queryFromMessages, queryFromSession, renderRecall, renderSnapshot, renderUnchanged } from './snapshot.ts'
import type { DirectiveRule, RecallHit } from './types.ts'

/** The `agent/pre-step` event payload (the live-runtime event shape). */
export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

/** The `agent/turn-stopping` event payload: the turn is about to close. */
export interface TurnStoppingPayload {
  agent: Agent
  turn: number
  signal: AbortSignal
}

/** The `agent/disposed` event payload: the agent left the registry. */
export interface DisposedPayload {
  agent: Agent
}

/** What one recall listing produces — the payload a snapshot is built from. */
interface PrefetchedTurn {
  hits: RecallHit[]
  rules: DirectiveRule[]
}

/** One in-flight or finished prefetch: its controller and its result. */
interface Slot {
  controller: AbortController
  promise: Promise<PrefetchedTurn>
}

/** Hard lifetime for a detached prefetch job: the user may not return for
 *  a long while, and a stalled bank call must not live forever. Mirrors
 *  the Hermes integration's 120 s operation timeout (its cloud recall can
 *  take 30–40 s). */
const PREFETCH_JOB_TTL_MS = 120_000

/**
 * `promise` or a timeout rejection after `timeoutMs` — `onTimeout` fires
 * when the clock wins (the caller aborts the work).
 */
function raceAgainst<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout()
      reject(new Error('hindsight: prefetch not ready in time'))
    }, timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Build the auto-recall listeners for `mount` under the given plugin name:
 *
 * - `preStep` (registered with `{ prepend: true }`) — consumes the previous
 *   turn's cached prefetch if it is ready, else takes the original bounded
 *   synchronous path, and commits the snapshot onto the step-1 decision;
 * - `turnStopping` — starts the detached prefetch for the closing turn
 *   (only while `prefetch` is on);
 * - `disposed` — aborts and drops the session's slot.
 *
 * At most one live slot per session: created at turn-stopping, consumed or
 * discarded at the next step-1 pre-step.
 */
export function buildAutoRecall(
  mount: Mount,
  pluginName: string,
): { preStep: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>; turnStopping: (payload: TurnStoppingPayload) => void; disposed: (payload: DisposedPayload) => void } {
  const config = mount.config
  const slots = new Map<string, Slot>()

  function discardSlot(sessionId: string): void {
    const entry = slots.get(sessionId)
    if (entry !== undefined) {
      entry.controller.abort()
      slots.delete(sessionId)
    }
  }

  /** Start the detached prefetch for `session`'s just-closed turn. */
  function startPrefetch(session: Session): void {
    const previous = slots.get(session.id)
    if (previous !== undefined) {
      previous.controller.abort()
      slots.delete(session.id)
    }
    const controller = new AbortController()
    const ttl = setTimeout(() => controller.abort(), PREFETCH_JOB_TTL_MS)
    const entry: Slot = {
      controller,
      promise: (async (): Promise<PrefetchedTurn> => {
        // The turn's own message: the last HUMAN message on the durable log
        // (plugin-sourced rows — including this plugin's snapshots — are
        // user-role messages too and are not queries), composed with the
        // recent prior turns as its context (the anchor is on the log, so
        // its own turn counts toward recallContextTurns).
        const latest = queryFromSession(session)
        const query = composeRecallQuery(session, latest, config.recallContextTurns, true)
        // Both lookups run together, like the synchronous path: one result
        // or no result. The job has no turn to serve, so no per-turn
        // budget — only its controller (discards and the TTL) bounds it.
        const recallPromise = query.length > 0
          ? mount.recall(query, controller.signal, session)
          : Promise.resolve<RecallHit[]>([])
        const [hits, rules] = await Promise.all([
          recallPromise,
          mount.listDirectives(controller.signal, session),
        ])
        return { hits, rules }
      })(),
    }
    // A failed job deletes its own slot — if it is still the current one,
    // a later turn's job may have replaced it — so the next step-1 pre-step
    // falls back to a fresh bounded synchronous lookup. The catch also keeps
    // the rejection from ever surfacing unhandled.
    entry.promise.catch(() => {
      if (slots.get(session.id) === entry) slots.delete(session.id)
    })
    entry.promise.then(() => clearTimeout(ttl), () => clearTimeout(ttl))
    slots.set(session.id, entry)
  }

  /** Render hits + rules and commit them as the snapshot message; an
   *  unchanged recall commits the marker row instead of a duplicate
   *  block (no churn, but the turn still gets its visible row, naming
   *  the memories it applied). */
  function commitSnapshot(
    decision: PreStepDecision,
    session: Session,
    hits: RecallHit[],
    rules: DirectiveRule[],
  ): PreStepDecision {
    if (decision.kind !== 'enter') return decision
    if (hits.length === 0 && rules.length === 0) return decision
    const text = rules.length > 0 ? renderSnapshot(config.bank, hits, rules) : renderRecall(config.bank, hits)
    // Identical recall: the block is already on the surface and still in
    // the model context (with the prefetch, the job's query IS the
    // previous turn's message, so this is the COMMON case). Re-committing
    // it would be churn — but the turn still gets its row: the marker,
    // naming the applied memories one compact line each, so the UI shows
    // exactly what was applied here.
    const retained = findRetainedSnapshots(session, pluginName)
    const committed = retained.some(snapshot => snapshot.text === text) ? renderUnchanged(config.bank, hits, rules) : text
    const snapshot = createUserMessage({
      content: [{ type: 'text', text: committed }],
      source: { kind: 'plugin', plugin: pluginName, form: 'snapshot', sections: [{ name: pluginName, text: committed }] },
    })
    // The snapshot rides the pre-step decision, so the loop appends it to
    // this turn's step right after the triggering message. The plugin only
    // ever appends: every snapshot stays in the model context, and the
    // durable log keeps each one for replay and audit.
    return { kind: 'enter', messages: [...decision.messages, snapshot] }
  }

  const preStep = async ({ agent, messages, step, signal }: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    const session = agent.session
    if (decision.kind !== 'enter' || signal.aborted) {
      // A step that never enters must not leave the previous turn's slot
      // stranded for a later turn to consume stale.
      discardSlot(session.id)
      return decision
    }
    if (!config.autoContext || step !== 1) return decision
    // Subagent sessions share this mount through the parent preset, but their
    // task context is owned by the delegating prompt; surfacing bank memory
    // there only dilutes it.
    if (session.header?.origin === 'subagent') return decision
    // The previous turn's prefetch, if it is here: ready results are free,
    // in-flight ones get the same budget the synchronous path would have
    // spent, and a timeout means this turn proceeds without memory — the
    // same cost as today's slow-server case, minus the attempt that already
    // ran for free last turn.
    const entry = slots.get(session.id)
    if (entry !== undefined) {
      slots.delete(session.id)
      let prefetched: PrefetchedTurn | undefined
      try {
        prefetched = await raceAgainst(entry.promise, config.autoContextTimeoutMs, () => entry.controller.abort())
      } catch {
        return decision
      }
      return commitSnapshot(decision, session, prefetched?.hits ?? [], prefetched?.rules ?? [])
    }
    // No slot: the first turn, or the previous job failed (its failure
    // deleted the slot) — the original bounded synchronous path. The anchor
    // is not on the log yet (the pre-step fires before the turn's messages
    // are appended), so the log holds the prior turns only.
    const latest = queryFromMessages(messages)
    const query = composeRecallQuery(session, latest, config.recallContextTurns, false)
    // Both lookups ride ONE bounded budget: the shared controller aborts the
    // whole pair at autoContextTimeoutMs (sequential — the directives list
    // is cheap, and the shared timeout still bounds the total).
    let hits: RecallHit[] = []
    let rules: DirectiveRule[] = []
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.autoContextTimeoutMs)
      const onAbort = (): void => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const recallPromise = query.length > 0
          ? mount.recall(query, controller.signal, agent.session)
          : Promise.resolve<RecallHit[]>([])
        hits = await recallPromise
        rules = await mount.listDirectives(controller.signal, agent.session)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    } catch {
      return decision
    }
    return commitSnapshot(decision, session, hits, rules)
  }

  const turnStopping = ({ agent, signal }: TurnStoppingPayload): void => {
    const session = agent.session
    // `prefetch: false` — no job: the recall waits for the next message
    // (the synchronous path) instead of reading this turn ahead.
    if (signal.aborted || !config.autoContext || !config.prefetch) return
    if (session.header?.origin === 'subagent') return
    // Never awaited: the event is serial and the loop awaits it before the
    // turn boundary commits — the job runs detached, in the user's think
    // time, and the next step-1 pre-step consumes (or discards) it.
    startPrefetch(session)
  }

  const disposed = ({ agent }: DisposedPayload): void => {
    discardSlot(agent.session.id)
  }

  return { preStep, turnStopping, disposed }
}
