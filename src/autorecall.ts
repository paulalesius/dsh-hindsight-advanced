/**
 * The automatic per-turn recall: on the first step of each turn the
 * latest user message is queried — and the bank's active standing
 * directives are listed — and both become a plugin-sourced snapshot
 * message (the same pattern `time-context` uses for the clock). Rules
 * are rendered in their own section, so a stored rule reaches the model
 * every turn even when the recall matches nothing.
 *
 * Assembly runs BEFORE the pre-step waterfall, so the memory cannot ride
 * the system prompt for its own turn; the snapshot instead rides the
 * pre-step decision, which the loop appends to the first step of each
 * turn right after the message that triggered the recall — so the
 * context row lands in the transcript below that message, newest at the
 * bottom, and never above it. The lookup is bounded: a stopped or slow
 * server costs at most `autoContextTimeoutMs` and the turn proceeds
 * without memory.
 *
 * The plugin only ever APPENDS a snapshot; it never replaces or erases a
 * previous turn's snapshot, so the model context accumulates one snapshot
 * per distinct turn (the durable log keeps every snapshot for replay and
 * audit). An identical recall is not re-committed (no churn); an empty
 * recall leaves the existing snapshots in place.
 *
 * @module dsh-plugin-hindsight/autorecall
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

import type { Mount } from './bank.ts'
import { findRetainedSnapshot, queryFromMessages, renderRecall, renderSnapshot } from './snapshot.ts'
import type { DirectiveRule, RecallHit } from './types.ts'

/** The `agent/pre-step` event payload (the live-runtime event shape). */
export interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

/**
 * Build the pre-step listener for `mount` under the given plugin name.
 * The returned function is registered with `{ prepend: true }` so it runs
 * before the rest of the waterfall.
 */
export function buildAutoRecall(
  mount: Mount,
  pluginName: string,
): (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision> {
  const config = mount.config

  return async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    if (!config.autoContext || step !== 1) return decision
    // Subagent sessions share this mount through the parent preset, but their
    // task context is owned by the delegating prompt; surfacing bank memory
    // there only dilutes it.
    if (agent.session.header?.origin === 'subagent') return decision
    const query = queryFromMessages(messages)
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
    if (hits.length === 0 && rules.length === 0) return decision
    const text = rules.length > 0 ? renderSnapshot(config.bank, hits, rules) : renderRecall(config.bank, hits)
    // Identical recall: the last snapshot is still accurate and already in
    // the model context — no churn, no new row.
    const retained = findRetainedSnapshot(agent.session, pluginName)
    if (retained !== undefined && retained.text === text) return decision
    const snapshot = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: pluginName, form: 'snapshot', sections: [{ name: pluginName, text }] },
    })
    // The snapshot rides the pre-step decision, so the loop appends it to
    // this turn's step right after the triggering message. The plugin only
    // ever appends: every snapshot stays in the model context, and the
    // durable log keeps each one for replay and audit.
    return { kind: 'enter', messages: [...decision.messages, snapshot] }
  }
}
