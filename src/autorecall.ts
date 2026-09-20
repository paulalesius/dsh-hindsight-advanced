/**
 * The automatic per-turn recall: on the first step of each turn the latest
 * user message is queried — and the bank's active standing directives are
 * listed — and both become a plugin-sourced snapshot message (the same
 * pattern `time-context` uses for the clock). Rules are rendered in their
 * own section, so a stored rule reaches the model every turn even when the
 * recall matches nothing.
 *
 * A HUMAN intervention claimed at a later step of a running turn (steering
 * delivered while the agent is mid-turn) is recalled the same way, on the
 * bounded synchronous path anchored on the intervention itself: the loop
 * delivers steering at the next step boundary and skips the turn-stopping
 * prefetch while a steer is still queued, so that step owns no cache and
 * waits on the server at most `autoContextTimeoutMs`.
 *
 * A step claim WITHOUT a human message (plugin-injected context alone) is
 * not an intent and recalls nothing by default; the `recallAfterText` and
 * `recallAfterReasoning` config keys (both default `false`) enable a
 * MID-STEP agent-output recall for such a step: it anchors on the previous
 * step's committed assistant message (its visible `text` and/or its
 * `reasoning` blocks, each kind capped, one composed anchor, one lookup),
 * runs the same bounded synchronous path, and commits the snapshot on that
 * step's decision with a kind-tagged row label (`recall:text - <ms>ms`,
 * `recall:think - <ms>ms`, `recall:think+text - <ms>ms`). A steering claim
 * always wins the precedence: the intervention anchors before the mid-step
 * anchor is consulted. The lookup targets the previous step by
 * (turn, step - 1) in the durable log (the loop has committed it before
 * the pre-step fires) and needs no state of its own. `recallPreserve:
 * false` retires across all snapshot kinds, trigger-agnostic: a mid-step
 * recall refreshes the latest card exactly like a turn recall does, and an
 * unchanged mid-step recall commits nothing.
 *
 * Assembly runs BEFORE the pre-step waterfall, so the memory cannot ride
 * the system prompt for its own turn; the snapshot instead rides the
 * pre-step decision, which the loop appends to the first step of each
 * turn right after the message that triggered the recall — so the
 * context row lands in the transcript below that message, newest at the
 * bottom, and never above it. Each snapshot's source carries a
 * per-message `label` (`recall - <ms>ms`, the lookup's wall clock) that
 * the collapsed context row displays in place of the plugin name; the
 * `plugin` field stays the attribution identity.
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
 * How the snapshot lands on the model surface depends on `recallPreserve`
 * (config, default `true` — the preserve-by-default half of the flag name,
 * matching the llama-server `--no-reasoning-preserve` semantics):
 *
 * - `recallPreserve: true` (default): the plugin only ever APPENDS a
 *   snapshot; it never replaces or erases a previous turn's snapshot, so the
 *   model context accumulates one snapshot per distinct turn (the durable
 *   log keeps every snapshot for replay and audit). The snapshot rides the
 *   pre-step decision, which the loop appends. An identical recall
 *   re-commits no duplicate block (no churn) — the turn instead gets a
 *   marker row naming the applied memories (one compact line each), so the
 *   UI still shows exactly what memory was applied that turn; an empty
 *   recall leaves the existing snapshots in place.
 *
 * - `recallPreserve: false`: the model surface carries only the LATEST
 *   full snapshot. When a new snapshot refreshes the context, the previous
 *   full card is replaced IN PLACE at its own turn (the session surface's
 *   `replace` op, landing at the old snapshot's position) by a TOMBSTONE — a
 *   tiny `form: 'notice'` one-line marker ("a snapshot was applied on this
 *   turn and was later refreshed; the current one is the newest below"),
 *   while the FULL new snapshot rides the pre-step decision as a fresh card
 *   appended at the triggering turn (the loop appends decision messages
 *   with a hardcoded `append` surface op, which is exactly where the new
 *   card wants to land). The surface then holds one tombstone per past
 *   recall turn — a visible, in-place record of WHERE each recall fired —
 *   plus exactly one full card, the latest, at its turn. Because the
 *   retire-and-replace happens before the decision, it is committed by a
 *   direct, synchronous `session.append` pair: the `compaction/prune`
 *   shadow-price metering record for the old card's full price immediately
 *   before the replacing `user/message` (the tombstone), exactly the
 *   adjacency the token meter's shadow-price fold requires — so the meter
 *   delta is the tombstone's few dozen tokens minus the retired card's full
 *   price. An identical recall commits nothing (the snapshot is already
 *   current, so there is no churn and the rows are left untouched). The
 *   durable log still keeps every snapshot for replay and audit; a failed
 *   replace degrades to the append-only path (tombstone skipped, the full
 *   snapshot simply rides the decision) so the turn never breaks.
 *
 * @module dsh-plugin-hindsight-advanced/autorecall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

import type { Mount } from './bank.ts'
import { composeRecallQuery, findRetainedSnapshots, midStepAnchor, previousStepAssistant, queryFromHumanMessages, queryFromMessages, queryFromSession, renderRecall, renderSnapshot, renderTombstone, renderUnchanged } from './snapshot.ts'
import type { MidStepKind } from './snapshot.ts'
import type { DirectiveRule, RecallHit } from './types.ts'

/**
 * The `recallPreserve: false` path prices its surface `replace` through the
 * shadow-price metering event `compaction/prune`. That event type is declared
 * by `@deepseek-ai/dsh-compaction`, which is a DSH-internal workspace package
 * and NOT resolvable from this userland plugin — so the base `SessionEventMap`
 * has no `compaction/prune` key and `session.append('compaction/prune', …)`
 * would not type-check. Re-declare the exact data shape here (type-only; the
 * runtime already accepts the event and folds it in the token meter).
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A shadow-price metering record: the next surface `replace` prices the
     *  range it shadows out of the running surface-token total. Log-only (not
     *  a surface event), so it carries no `SurfaceIntent`. */
    'compaction/prune': {
      /** Inclusive range of surface nodes whose price the replace retires. */
      shadowedRange: { start: SessionSeq; end: SessionSeq }
      /** The shadowed surface-node seqs (must equal the replace's range). */
      shadowedSeqs: SessionSeq[]
      /** Heuristic tokens of the shadowed range under the fixed estimator. */
      shadowedTokenCount: number
    }
  }
}

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
  /** Wall-clock ms of the recall + directive listing (the row's label). */
  durationMs: number
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
 *   synchronous path, and commits the snapshot onto the step-1 decision; a
 *   later step's HUMAN intervention anchors its own bounded synchronous
 *   lookup (the loop skips the prefetch while a steer is queued, so the
 *   step owns no cache) and commits the snapshot onto that step's
 *   decision; a later step's claim WITHOUT a human message anchors the
 *   mid-step agent-output recall on the previous step's committed
 *   assistant message when `recallAfterText` / `recallAfterReasoning` is
 *   on (kind-tagged row label), else passes through;
 * - `turnStopping` — starts the detached prefetch for the closing turn
 *   (only while `prefetch` is on);
 * - `disposed` — aborts and drops the session's slot.
 *
 * At most one live slot per session: created at turn-stopping, consumed or
 * discarded at the next step-1 pre-step. `ctx` is threaded through only for
 * the `recallPreserve: false` shadow-price: it is read with an untyped
 * `ctx.get('tokenMeter')` at commit time (the seam is optional, so a
 * composition without the token meter degrades to an unpriced replace).
 */
export function buildAutoRecall(
  mount: Mount,
  pluginName: string,
  ctx: Context,
): { preStep: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>; turnStopping: (payload: TurnStoppingPayload) => void; disposed: (payload: DisposedPayload) => void } {
  const config = mount.config
  const slots = new Map<string, Slot>()

  /**
   * The shadow-price (heuristic tokens) for the snapshot a `replace` retires,
   * read through the token meter. `undefined` when the composition has no
   * token meter (or the read fails): the replace then folds price-neutrally
   * and the meter overcounts until its next usage sample — a safe degrade,
   * never a turn failure.
   */
  function estimateSnapshotTokens(message: UserMessage): number | undefined {
    const meter = ctx.get('tokenMeter')
    if (meter === undefined || meter === null) return undefined
    try {
      const tokens = meter.estimateMessage(message)
      return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined
    } catch {
      return undefined
    }
  }

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
        const startedAt = Date.now()
        const recallPromise = query.length > 0
          ? mount.recall(query, controller.signal, session)
          : Promise.resolve<RecallHit[]>([])
        const [hits, rules] = await Promise.all([
          recallPromise,
          mount.listDirectives(controller.signal, session),
        ])
        return { hits, rules, durationMs: Date.now() - startedAt }
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

  /** Render hits + rules and commit them as the snapshot message.
   *
   *  `recallPreserve: true` (default): append-only — the snapshot rides
   *  the pre-step decision (the loop appends it); an identical recall
   *  commits the marker row instead of a duplicate block (no churn, but
   *  the turn still gets its visible row, naming the memories it applied).
   *
   *  `recallPreserve: false`: the model surface carries only the LATEST
   *  full snapshot — one card per past recall turn's TOMBSTONE (a
   *  `form: 'notice'` one-liner installed in place of the retired card, so
   *  each recall turn keeps a visible, in-place marker) plus the single
   *  current card at its own turn. The retirement is a direct,
   *  synchronous `session.append` pair — the shadow-price
   *  `compaction/prune` (log-only) immediately BEFORE the replacing
   *  `user/message`, the exact adjacency the token meter's shadow-price
   *  fold requires — so the replace is priced as the tiny tombstone minus
   *  the retired card's full price; the FULL new snapshot then rides the
   *  pre-step decision, which the loop appends after this turn's message.
   *  An identical recall commits nothing (the snapshot is already
   *  current). The durable log keeps every snapshot regardless. A failed
   *  retirement degrades to the append-only path (the old card stays, the
   *  new one rides the decision) so the turn never breaks; an orphaned
   *  `compaction/prune` from a failed replace is harmless on replay (its
   *  claim is dropped by the next event). */
  function commitSnapshot(
    decision: PreStepDecision,
    session: Session,
    hits: RecallHit[],
    rules: DirectiveRule[],
    durationMs: number,
    kind?: MidStepKind,
  ): PreStepDecision {
    if (decision.kind !== 'enter') return decision
    if (hits.length === 0 && rules.length === 0) return decision
    const text = rules.length > 0 ? renderSnapshot(config.bank, hits, rules) : renderRecall(config.bank, hits)
    const retained = findRetainedSnapshots(session, pluginName)
    const label = kind === undefined ? `recall - ${durationMs}ms` : `recall:${kind} - ${durationMs}ms`

    if (!config.recallPreserve) {
      const latest = retained[0]
      // Identical recall: the newest full snapshot already carries this
      // text on the surface (a tombstone never matches a rendered recall).
      // Retiring it would be churn — and it is already current. Leave the
      // rows untouched.
      if (latest !== undefined && latest.text === text) return decision
      const snapshot = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: pluginName, form: 'snapshot', label, sections: [{ name: pluginName, text }] },
      })
      try {
        if (latest !== undefined) {
          // Retire the previous full snapshot IN PLACE at its own turn and
          // install a TOMBSTONE in its slot (a `form: 'notice'` one-liner —
          // the UI renders it as a collapsed row, so every past recall turn
          // keeps a visible marker of where it recalled without the card's
          // thousands of tokens), while the FULL new snapshot rides the
          // pre-step decision below: the loop appends decision messages
          // with a hardcoded `append` op, landing it as a fresh card right
          // after this turn's message. `startSeq` / `endSeq` target the
          // old card's single surface node (the replace lands at that
          // node's position), and `sourceEventSeqs` names the shadowed
          // node (the surface enforces this). The shadow price — the old
          // card's heuristic tokens — rides the log-only
          // `compaction/prune` appended immediately before, so the token
          // meter folds the replace as the tiny tombstone minus the
          // shadowed range.
          const seq = latest.seq
          const price = estimateSnapshotTokens(latest.message)
          const tombstone = renderTombstone(config.bank)
          const marker = createUserMessage({
            content: [{ type: 'text', text: tombstone.text }],
            source: { kind: 'plugin', plugin: pluginName, form: 'notice', summary: boundContextSummary(tombstone.summary) },
          })
          if (price !== undefined) {
            session.append('compaction/prune', {
              shadowedRange: { start: seq, end: seq },
              shadowedSeqs: [seq],
              shadowedTokenCount: price,
            })
          }
          session.append('user/message', marker, {
            surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
          })
          return { kind: 'enter', messages: [...decision.messages, snapshot] }
        }
        // No prior full snapshot (the first turn): append it plainly,
        // committed directly — the card lands on the surface before the
        // triggering message, never riding the decision.
        session.append('user/message', snapshot, { surfaceOp: 'append' })
        return decision
      } catch {
        // The direct retirement failed (a seq no longer on the surface, a
        // rejected append, …). Degrade to the append-only path below so the
        // turn never breaks: the old card stays on the surface, and the new
        // full snapshot simply rides the decision. An orphaned
        // `compaction/prune` from the failed replace is harmless: its
        // shadow-price claim is dropped by the next event, so the meter
        // stays consistent.
      }
    }

    // Append-only — the default mode, and the degrade for a failed replace.
    // The snapshot rides the pre-step decision, so the loop appends it to
    // this turn's step right after the triggering message. An identical
    // recall commits the marker row instead of a duplicate block (no
    // churn, but the turn still gets its row naming the memories it
    // applied).
    const committed = retained.some(snapshot => snapshot.text === text) ? renderUnchanged(config.bank, hits, rules) : text
    const appended = createUserMessage({
      content: [{ type: 'text', text: committed }],
      source: { kind: 'plugin', plugin: pluginName, form: 'snapshot', label, sections: [{ name: pluginName, text: committed }] },
    })
    return { kind: 'enter', messages: [...decision.messages, appended] }
  }

  /**
   * The bounded synchronous recall + directive pair on `query`, shared by
   * the turn / intervention / mid-step paths: one result or no result (a
   * timeout, abort, or failure means the step proceeds without memory:
   * `null`, and the base decision passes through untouched). Both lookups
   * ride ONE bounded budget: the shared controller aborts the whole pair
   * at `autoContextTimeoutMs` (sequential: the directives list is cheap,
   * and the shared timeout still bounds the total), and the step's signal
   * aborts the pair early when the turn dies mid-lookup.
   */
  function syncRecall(session: Session, query: string, signal: AbortSignal): Promise<PrefetchedTurn | null> {
    return (async (): Promise<PrefetchedTurn | null> => {
      const startedAt = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.autoContextTimeoutMs)
      const onAbort = (): void => controller.abort()
      if (!signal.aborted) signal.addEventListener('abort', onAbort, { once: true })
      try {
        const recallPromise = query.length > 0
          ? mount.recall(query, controller.signal, session)
          : Promise.resolve<RecallHit[]>([])
        const hits = await recallPromise
        const rules = await mount.listDirectives(controller.signal, session)
        return { hits, rules, durationMs: Date.now() - startedAt }
      } catch {
        return null
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    })()
  }

  const preStep = async ({ agent, messages, turn, step, signal }: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const decision = await next()
    const session = agent.session
    if (decision.kind !== 'enter' || signal.aborted) {
      // A step that never enters must not leave the previous turn's slot
      // stranded for a later turn to consume stale.
      discardSlot(session.id)
      return decision
    }
    if (!config.autoContext) return decision
    // Subagent sessions share this mount through the parent preset, but their
    // task context is owned by the delegating prompt; surfacing bank memory
    // there only dilutes it.
    if (session.header?.origin === 'subagent') return decision
    // A later step of a running turn claims the steering delivered at its
    // boundary (an intervention): recall it on the bounded synchronous path
    // anchored on the intervention itself (the loop skips the
    // turn-stopping prefetch while a steer is queued, so the step owns no
    // cache). A steering claim always wins the precedence over a mid-step
    // agent-output anchor (below): a human message in the claim means the
    // step is already anchored on the steer.
    const intervention = step > 1 ? queryFromHumanMessages(messages) : ''
    if (step > 1 && intervention.length === 0) {
      // A claim without a human message (plugin-injected context alone) is
      // not an intent and recalls nothing by default. The mid-step
      // agent-output recall (recallAfterText / recallAfterReasoning, both
      // default off) anchors it on the PREVIOUS step's committed assistant
      // message instead: the loop has already committed that event to the
      // durable log, so it is found by (turn, step - 1).
      if (config.recallAfterText || config.recallAfterReasoning) {
        const previous = previousStepAssistant(session, turn, step)
        if (previous !== undefined) {
          const anchored = midStepAnchor(previous.message, config.recallAfterText, config.recallAfterReasoning)
          if (anchored !== null) {
            // The anchor's turn is on the log (the current turn's human line
            // stays in the context: the step recalls against the thing it is
            // responding to), and the anchor's own line is dropped by seq (it
            // is the query's tail, not its context).
            const query = composeRecallQuery(session, anchored.anchor, config.recallContextTurns, true, previous.seq)
            const result = await syncRecall(session, query, signal)
            if (result !== null) return commitSnapshot(decision, session, result.hits, result.rules, result.durationMs, anchored.kind)
          }
        }
      }
      return decision
    }
    // The previous turn's prefetch, if it is here: ready results are free,
    // in-flight ones get the same budget the synchronous path would have
    // spent, and a timeout means this turn proceeds without memory — the
    // same cost as today's slow-server case, minus the attempt that already
    // ran for free last turn. A slot is always consumed or discarded at
    // step 1, so this branch is unreachable at a later step (an
    // intervention can never consume a stale prefetch).
    const entry = slots.get(session.id)
    if (entry !== undefined) {
      slots.delete(session.id)
      let prefetched: PrefetchedTurn | undefined
      try {
        prefetched = await raceAgainst(entry.promise, config.autoContextTimeoutMs, () => entry.controller.abort())
      } catch {
        return decision
      }
      return commitSnapshot(decision, session, prefetched?.hits ?? [], prefetched?.rules ?? [], prefetched?.durationMs ?? 0)
    }
    // No slot: the first turn, the previous job failed (its failure deleted
    // the slot), or an intervention step (whose anchor is the claimed steer
    // itself): the original bounded synchronous path. The anchor is not on
    // the log yet (the pre-step fires before the step's messages are
    // appended), so the log holds the prior turns only: for an
    // intervention, that includes the running turn's earlier steps, which
    // compose as the context the steer refines.
    const latest = step > 1 ? intervention : queryFromMessages(messages)
    const query = composeRecallQuery(session, latest, config.recallContextTurns, false)
    // The bounded synchronous path (shared with the mid-step branch above):
    // a timed-out, aborted, or failed pair returns without a snapshot, so a
    // committed label is always real bank latency.
    const result = await syncRecall(session, query, signal)
    if (result === null) return decision
    return commitSnapshot(decision, session, result.hits, result.rules, result.durationMs)
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
