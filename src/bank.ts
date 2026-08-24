/**
 * One mount: a fixed bank plus its memory operations (retain / recall /
 * reflect / invalidate) and the lazy one-time sync of the declared bank
 * config.
 *
 * `createMount` is the plugin's per-mount factory: it owns the mount's
 * mutable state (the bank-config sync) in a closure, so every module
 * around it deals in a plain, unit-testable `Mount` value. New Hindsight
 * operations (mental models, directives, consolidation, …) become new
 * methods on the mount here.
 *
 * @module dsh-plugin-hindsight-advanced/bank
 */

import type { Session } from '@deepseek-ai/dsh-session'

import { request } from './client.ts'
import type { ResolvedConfig } from './config.ts'
import { recallTags, scopeTags, type MemoryScope } from './tiers.ts'
import type { DirectiveRule, RecallHit, RecallOptions } from './types.ts'

/** The response token budget for source-fact provenance on recall. The
 *  enrichment is post-selection (it cannot change which facts are recalled);
 *  the budget only bounds how many backing facts are returned for the hits
 *  that were. */
const SOURCE_FACTS_TOKENS = 512

/** One mounted bank and the operations against it. */
export interface Mount {
  /** The mount's validated configuration. */
  config: ResolvedConfig
  /** The mount's bank, as a REST path relative to the base URL. */
  bankPath: string
  /** Targeted semantic search over the mount's bank, scoped to `session`'s
   *  visible tiers (`undefined` session: the whole bank). Hits carry the
   *  bank's source-fact provenance (observation backing facts) when the
   *  server returned it. */
  recall(
    query: string,
    signal: AbortSignal,
    session: Session | undefined,
    options?: RecallOptions,
  ): Promise<RecallHit[]>
  /** Store a durable memory tagged with `session`'s tier for `scope`
   *  (`undefined` session: the global tier, visible everywhere). `timestamp`,
   *  when the caller knows when the content OCCURRED (an ISO 8601 date or
   *  `'unset'` for timeless content), is forwarded verbatim; omitted, the
   *  bank stamps the storage time. */
  retain(
    content: string,
    signal: AbortSignal,
    session: Session | undefined,
    scope: MemoryScope,
    timestamp?: string,
  ): Promise<void>
  /** A synthesized answer grounded in the bank's facts, with the same tier
   *  scoping as recall. */
  reflect(query: string, signal: AbortSignal, session: Session | undefined): Promise<string>
  /** The bank's active standing directives (rules) for `session`'s visible
   *  tiers (`undefined` session: every active directive), priority-ordered
   *  (highest first). */
  listDirectives(signal: AbortSignal, session: Session | undefined): Promise<DirectiveRule[]>
  /** Store a standing directive named `name`, tagged with `session`'s tier
   *  for `scope` (`undefined` session: the global tier). */
  retainDirective(
    name: string,
    content: string,
    signal: AbortSignal,
    session: Session | undefined,
    scope: MemoryScope,
  ): Promise<void>
  /** Soft-retire a stored memory by its id (the handle recall results and
   *  the snapshot render as `id:<uuid>`): the bank excludes it from recall
   *  and consolidation, prunes its derived observations and links, and moves
   *  it to the archive. Reversible server-side; `reason` is recorded with the
   *  invalidation. No session: the act is on an id the bank already surfaced
   *  to this session, not a tier-scoped query. */
  invalidate(memoryId: string, reason: string, signal: AbortSignal): Promise<void>
}

/**
 * Build the operations for one mount, owning its per-mount state.
 * @param resolveApiKey - resolves the CURRENT authorization value per call
 *  (a literal key, or a credential reference resolved through the seam);
 *  `undefined` sends no auth header. Resolution is per operation, never
 *  cached across them, so a rotated credential reaches the next operation.
 */
export function createMount(
  config: ResolvedConfig,
  resolveApiKey: () => Promise<string | undefined> = async () => undefined,
): Mount {
  /** The mount's bank. */
  const bankPath = `/v1/default/banks/${encodeURIComponent(config.bank)}`

  /** One request bound to the mount's current authorization value. */
  const call = async (
    path: string,
    body: unknown,
    signal: AbortSignal,
    method: 'POST' | 'PATCH' | 'GET' = 'POST',
  ): Promise<Record<string, unknown>> =>
    request(config, path, body, signal, method, await resolveApiKey())

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
      bankConfigPending = call(`${bankPath}/config`, { updates: bankConfigUpdates }, signal, 'PATCH')
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
      // Consolidation mode: recall all three layers and let every observation
      // supersede the raw facts it was consolidated from, so the bank's
      // deduplicated beliefs appear once (not as fact + observation pairs) and
      // the freed slots backfill with next-best facts. When the model restricts
      // `types` explicitly, that wins — `prefer_observations` then no-ops
      // server-side (it only acts when an observation and a raw type are both
      // requested) and stays sent harmlessly.
      const body: Record<string, unknown> = {
        query,
        max_tokens: options?.maxTokens ?? config.maxRecallTokens,
        types: options?.types !== undefined && options.types.length > 0
          ? [...options.types]
          : ['world', 'experience', 'observation'],
        prefer_observations: true,
        // Source-fact provenance: a budgeted POST-selection enrichment — it
        // cannot change which facts are selected or in what order, only add
        // the backing facts behind observation hits, which the renderer
        // surfaces under those hits.
        include: { source_facts: { max_tokens: SOURCE_FACTS_TOKENS } },
      }
      withTierFilter(body, session)
      const data = await call(`${bankPath}/memories/recall`, body, signal)
      const results = data.results
      if (!Array.isArray(results)) return []
      const sourceFacts: Record<string, unknown> =
        typeof data.source_facts === 'object' && data.source_facts !== null
          ? data.source_facts as Record<string, unknown>
          : {}
      /** A raw recall hit as returned by the server: the surfaced shape,
       *  plus the provenance field the map below resolves away. */
      type RawHit = RecallHit & { source_fact_ids?: unknown }
      return results
        .filter((hit): hit is RawHit =>
          typeof hit === 'object' && hit !== null
          && typeof (hit as RecallHit).id === 'string'
          && typeof (hit as RecallHit).text === 'string',
        )
        .map((hit): RecallHit => {
          // Resolve the hit's source-fact ids to their text (order kept,
          // missing entries skipped); absent for hits the server did not
          // back with source facts.
          const ids = Array.isArray(hit.source_fact_ids) ? hit.source_fact_ids : []
          const sources: string[] = []
          for (const id of ids) {
            if (typeof id !== 'string') continue
            const fact = sourceFacts[id]
            if (typeof fact !== 'object' || fact === null) continue
            const text = (fact as RecallHit).text
            if (typeof text === 'string' && text.trim().length > 0) sources.push(text.trim())
          }
          return sources.length > 0 ? { ...hit, sources } : hit
        })
    },

    async retain(content, signal, session, scope, timestamp): Promise<void> {
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
      // An explicit occurrence time (ISO 8601, or 'unset' for timeless
      // content) tells the bank when the content HAPPENED, not just when it
      // was stored; omitted, the bank stamps the storage time, so the field
      // is only sent when the caller actually knows a better one.
      if (timestamp !== undefined && timestamp.length > 0) item.timestamp = timestamp
      const body: Record<string, unknown> = { items: [item] }
      if (config.retainAsync) body.async = true
      await call(`${bankPath}/memories`, body, signal)
    },

    async reflect(query, signal, session): Promise<string> {
      await syncBankConfig(signal)
      const body: Record<string, unknown> = { query }
      withTierFilter(body, session)
      const data = await call(`${bankPath}/reflect`, body, signal)
      return typeof data.text === 'string' && data.text.length > 0 ? data.text : 'the bank returned an empty answer'
    },

    async listDirectives(signal, session): Promise<DirectiveRule[]> {
      await syncBankConfig(signal)
      let path = `${bankPath}/directives?active_only=true`
      // The same tier filter as recall: the server includes every untagged
      // (global) directive in every mode, so the two tier tags select exactly
      // the session's own tier, its preset tier, and the global ones.
      if (session !== undefined) {
        const tags = recallTags(session).map(encodeURIComponent).join(',')
        path += `&tags=${tags}&tags_match=any`
      }
      const data = await call(path, {}, signal, 'GET')
      const items = data.items
      if (!Array.isArray(items)) return []
      return items
        .filter((rule): rule is DirectiveRule =>
          typeof rule === 'object' && rule !== null
          && typeof (rule as DirectiveRule).id === 'string'
          && typeof (rule as DirectiveRule).name === 'string'
          && typeof (rule as DirectiveRule).content === 'string'
          && typeof (rule as DirectiveRule).priority === 'number',
        )
        .sort((a, b) => b.priority - a.priority)
    },

    async retainDirective(name, content, signal, session, scope): Promise<void> {
      await syncBankConfig(signal)
      // Like retain: the directive's tag set IS its scope — at most one
      // tier's tag; no session means the global tier.
      const tags = session === undefined ? [] : scopeTags(session, scope)
      const body: Record<string, unknown> = { name, content, is_active: true }
      if (tags.length > 0) body.tags = tags
      await call(`${bankPath}/directives`, body, signal)
    },

    async invalidate(memoryId, reason, signal): Promise<void> {
      // A curation act on an id the bank already surfaced (a recall result,
      // a snapshot line). Soft by construction: the bank archives the memory
      // with its reason rather than deleting it, and can restore it
      // (state: 'valid') — so a wrong call is recoverable and auditable.
      await syncBankConfig(signal)
      const body: Record<string, unknown> = { state: 'invalidated' }
      if (reason.length > 0) body.reason = reason
      await call(`${bankPath}/memories/${encodeURIComponent(memoryId)}`, body, signal, 'PATCH')
    },
  }
}
