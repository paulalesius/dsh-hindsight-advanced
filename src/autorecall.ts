/**
 * The automatic per-turn recall: on the first step of each turn the
 * latest user message is queried and the hits become a plugin-sourced
 * snapshot message (the same pattern `time-context` uses for the clock).
 *
 * Assembly runs BEFORE the pre-step waterfall, so the memory cannot ride
 * the system prompt for its own turn; the snapshot is instead appended to
 * the first step of each turn. The lookup is bounded: a stopped or slow
 * server costs at most `autoContextTimeoutMs` and the turn proceeds
 * without memory.
 *
 * With `latestOnly` (the default) the snapshot is committed directly to
 * the session surface: each new one SHADOWS the previous one (the same
 * surface-replace mechanism compaction uses), so the model context carries
 * exactly one memory message — the latest recall — while the durable log
 * keeps every snapshot for replay and audit. An empty recall leaves the
 * last snapshot in place; an unchanged one is not re-committed.
 *
 * @module dsh-plugin-hindsight/autorecall
 */

import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

import type { Mount } from './bank.ts'
import { findRetainedSnapshot, queryFromMessages, renderRecall } from './snapshot.ts'
import type { RecallHit } from './types.ts'

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
    if (query.length === 0) return decision
    let hits: RecallHit[]
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.autoContextTimeoutMs)
      const onAbort = (): void => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        hits = await mount.recall(query, controller.signal, agent.session)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    } catch {
      return decision
    }
    if (hits.length === 0) return decision
    const text = renderRecall(config.bank, hits)
    const snapshot = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: pluginName, form: 'snapshot', sections: [{ name: pluginName, text }] },
    })
    if (config.latestOnly) {
      const retained = findRetainedSnapshot(agent.session, pluginName)
      // Identical recall: the last snapshot is still accurate — no churn.
      if (retained !== undefined && retained.text === text) return decision
      // Commit the snapshot to the model-visible surface: a plain append for
      // the first one, a positional REPLACE for every later one, so each new
      // snapshot shadows the previous (preserve-thinking). The durable log
      // keeps every snapshot either way.
      const intent = retained === undefined
        ? { surfaceOp: 'append' as const }
        : {
            surfaceOp: { op: 'replace' as const, start: retained.seq, end: retained.seq },
            sourceEventSeqs: [retained.seq],
          }
      try {
        agent.session.append('user/message', snapshot, intent)
        return decision
      } catch {
        // The retained snapshot left the surface between lookup and commit
        // (e.g. a concurrent compaction): try a plain append instead.
        try {
          agent.session.append('user/message', snapshot, { surfaceOp: 'append' })
          return decision
        } catch {
          // The session rejects appends (e.g. already closed): degrade to
          // letting the loop append the snapshot through the decision.
        }
      }
    }
    // Cumulative mode: let the loop append one snapshot per turn.
    return { kind: 'enter', messages: [...decision.messages, snapshot] }
  }
}
