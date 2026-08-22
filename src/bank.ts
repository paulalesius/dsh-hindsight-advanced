/**
 * One mount: a fixed bank plus its memory operations (retain / recall /
 * reflect) and the lazy one-time sync of the declared bank config.
 *
 * `createMount` is the plugin's per-mount factory: it owns the mount's
 * mutable state (the bank-config sync) in a closure, so every module
 * around it deals in a plain, unit-testable `Mount` value. New Hindsight
 * operations (mental models, directives, consolidation, …) become new
 * methods on the mount here.
 *
 * @module dsh-plugin-hindsight/bank
 */

import type { Session } from '@deepseek-ai/dsh-session'

import { request } from './client.ts'
import type { ResolvedConfig } from './config.ts'
import { recallTags, scopeTags, type MemoryScope } from './tiers.ts'
import type { RecallHit, RecallOptions } from './types.ts'

/** One mounted bank and the operations against it. */
export interface Mount {
  /** The mount's validated configuration. */
  config: ResolvedConfig
  /** The mount's bank, as a REST path relative to the base URL. */
  bankPath: string
  /** Targeted semantic search over the mount's bank, scoped to `session`'s
   *  visible tiers (`undefined` session: the whole bank). */
  recall(
    query: string,
    signal: AbortSignal,
    session: Session | undefined,
    options?: RecallOptions,
  ): Promise<RecallHit[]>
  /** Store a durable memory tagged with `session`'s tier for `scope`
   *  (`undefined` session: the global tier, visible everywhere). */
  retain(content: string, signal: AbortSignal, session: Session | undefined, scope: MemoryScope): Promise<void>
  /** A synthesized answer grounded in the bank's facts, with the same tier
   *  scoping as recall. */
  reflect(query: string, signal: AbortSignal, session: Session | undefined): Promise<string>
}

/** Build the operations for one mount, owning its per-mount state. */
export function createMount(config: ResolvedConfig): Mount {
  /** The mount's bank. */
  const bankPath = `/v1/default/banks/${encodeURIComponent(config.bank)}`

  // ── bank config sync ──────────────────────────────────────────────────────
  //
  // The declared bank config is DURABLE server state, so it is applied once,
  // lazily before the first memory operation of this mount — not at mount
  // time (the server may be down, and the mount must not care) and not per
  // operation. A failed attempt is simply retried from the next operation.
  // The PATCH rides the calling operation's own signal, so it adds no time
  // budget of its own, and it never throws: a failed sync leaves the memory
  // operation to fail (or succeed) on its own terms.
  const bankConfigUpdates = config.bankConfig
  let bankConfigSynced = bankConfigUpdates === undefined
  let bankConfigPending: Promise<void> | undefined
  function syncBankConfig(signal: AbortSignal): Promise<void> {
    if (bankConfigSynced || bankConfigUpdates === undefined) return Promise.resolve()
    if (bankConfigPending === undefined) {
      bankConfigPending = request(config, `${bankPath}/config`, { updates: bankConfigUpdates }, signal, 'PATCH')
        .then(() => { bankConfigSynced = true })
        .catch(() => { bankConfigPending = undefined })
    }
    return bankConfigPending
  }

  /**
   * Apply the session's tier visibility filter to a recall/reflect body:
   * the session's own tier plus its preset tier, `any`-matched, which
   * selects exactly those two tiers plus every untagged (global) memory.
   * No session (should not happen in the agent loop; tests may lack one)
   * means no filter — the whole bank is visible.
   */
  function withTierFilter(body: Record<string, unknown>, session: Session | undefined): void {
    if (session === undefined) return
    body.tags = recallTags(session)
    body.tags_match = 'any'
  }

  return {
    config,
    bankPath,

    async recall(query, signal, session, options): Promise<RecallHit[]> {
      await syncBankConfig(signal)
      const body: Record<string, unknown> = {
        query,
        max_tokens: options?.maxTokens ?? config.maxRecallTokens,
      }
      if (options?.types !== undefined && options.types.length > 0) body.types = [...options.types]
      withTierFilter(body, session)
      const data = await request(config, `${bankPath}/memories/recall`, body, signal)
      const results = data.results
      if (!Array.isArray(results)) return []
      return results
        .filter((hit): hit is RecallHit =>
          typeof hit === 'object' && hit !== null
          && typeof (hit as RecallHit).id === 'string'
          && typeof (hit as RecallHit).text === 'string',
        )
    },

    async retain(content, signal, session, scope): Promise<void> {
      // `async: true` acknowledges fast and runs the bank's fact extraction in
      // the background; the default (synchronous) waits for the bank to process
      // the memory before returning, so the next recall already sees it.
      await syncBankConfig(signal)
      // The item's tag set IS its scope — at most one tier's tag. Without a
      // session to derive the tier from, the memory lands in the global scope
      // (visible everywhere) rather than a tier nobody could recall.
      const tags = session === undefined ? [] : scopeTags(session, scope)
      const item: Record<string, unknown> = { content }
      if (tags.length > 0) item.tags = tags
      const body: Record<string, unknown> = { items: [item] }
      if (config.retainAsync) body.async = true
      await request(config, `${bankPath}/memories`, body, signal)
    },

    async reflect(query, signal, session): Promise<string> {
      await syncBankConfig(signal)
      const body: Record<string, unknown> = { query }
      withTierFilter(body, session)
      const data = await request(config, `${bankPath}/reflect`, body, signal)
      return typeof data.text === 'string' && data.text.length > 0 ? data.text : 'the bank returned an empty answer'
    },
  }
}
