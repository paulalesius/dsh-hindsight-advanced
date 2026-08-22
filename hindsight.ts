/**
 * Hindsight long-term memory for a dsh profile — userland, per-preset.
 *
 * This file is a plain in-process plugin: one dependency-light ESM module that
 * each PRESET that wants memory mounts with its own row in its own
 * `agent.cordis.yml`, carrying its own `bank`. The plugin is preset-agnostic —
 * it never reads the session's `agentPreset`; a different bank per preset is
 * expressed by mounting the row in different presets with different configs:
 *
 *   # ~/.dsh/.agent-presets/standard/agent.cordis.yml
 *   - id: hindsight
 *     name: ./hindsight.ts
 *     config:
 *       bank: hermes
 *
 *   # ~/.dsh/.agent-presets/code/agent.cordis.yml
 *   - id: hindsight
 *     name: ./hindsight.ts
 *     config:
 *       bank: dsh-code
 *
 * Presets without the row get no `hindsight` tool at all — there is no
 * unmapped/inert state to configure. A session gets the tool, the automatic
 * recall, and the bank of whichever preset it was created from; subagents
 * inherit the parent preset's composition and therefore the same mount.
 *
 * What each mount gives its preset's agents:
 *
 * - a `hindsight` tool with three actions:
 *   - `retain` — store a durable memory. WHAT and WHEN gets stored is decided
 *     by the model from the tool description (durable facts, preferences,
 *     decisions and their rationale; never ephemera or raw code). WHERE it
 *     lands is the visibility tier: the model's `scope` parameter (or the
 *     mount's `retainScope` default) picks `global`, `preset`, or `session`
 *     (see the tier model below). Stored synchronously by default (the call
 *     waits for the bank to process it); `retainAsync: true` acknowledges
 *     fast and runs fact extraction in the background instead.
 *   - `recall` — a targeted semantic search over the mount's bank, scoped
 *     to the session's three visible tiers (below).
 *   - `reflect` — a synthesized answer grounded in the bank's facts, with
 *     the same tier scoping as recall.
 * - automatic recall: on the first step of each turn the latest user message
 *   is queried and the hits become a plugin-sourced snapshot message
 *   (the same pattern `time-context` uses for the clock). The lookup is
 *   bounded and subagent sessions are skipped, so a slow or stopped
 *   Hindsight server never blocks a turn.
 *
 *   With `latestOnly` (default `true`) exactly one snapshot is ever visible
 *   to the model: each turn's snapshot is appended to the session surface by
 *   REPLACING the mount's previous snapshot, so the model context carries
 *   only the latest recall (the `preserve-thinking` pattern), while the
 *   durable log keeps every snapshot for replay and audit. An empty recall
 *   leaves the last snapshot in place. `latestOnly: false` restores the
 *   cumulative behavior (one appended message per turn).
 *
 * Visibility tiers (the plugin's tag model — the model never sees tags):
 * the plugin tags every stored memory with at most ONE tier's tag, and the
 * item's tag set is its scope:
 *
 * - `global`  — no tags. Untagged memories live in the bank's global scope
 *   and are visible to every session of the bank.
 * - `preset`  — tag `preset:<id>` (the session's agent preset; `preset:none`
 *   when the session has no preset). Shared by the sessions of that preset.
 * - `session` — tag `session:<id>`. Visible to that session only (including
 *   its resume — the id survives resume). A subagent's session tier leans
 *   at the PARENT that delegated its task (the child id is short-lived and
 *   would orphan its memories), so a subagent's session-tier retains are
 *   visible to the parent.
 *
 * A recall (tool or automatic) issued by a session sends
 * `[session:<own id>, preset:<own preset>]` under the server's default
 * `any` matching, which selects exactly: its own session tier, its preset
 * tier, and every untagged (global) memory — and no memory tagged for
 * another session or another preset. Banks remain the outer isolation
 * boundary: separate banks (separate mounts) for separate memory surfaces.
 *
 * Config (the row's `config` block):
 * - `bank` — REQUIRED. Hindsight bank id (case-sensitive; the server
 *   auto-creates a bank on first use).
 * - `baseUrl` — Hindsight REST base; default `http://127.0.0.1:8888`.
 * - `apiKey` — optional; sent as `Authorization: Bearer <key>` on every call.
 * - `autoContext` — default `true`; `false` disables the per-turn recall
 *   (the tool stays available).
 * - `latestOnly` — default `true`; the model sees only the LATEST automatic
 *   snapshot (each new one replaces the previous on the model-visible
 *   surface). `false` keeps every turn's snapshot in context (cumulative).
 * - `retainAsync` — default `false` (synchronous: the retain call waits for
 *   the bank to process the memory); `true` acknowledges fast and runs fact
 *   extraction in the background.
 * - `maxRecallTokens` — recall response budget; default `1024`.
 * - `autoContextTimeoutMs` — bound for the automatic lookup; default `2500`.
 * - `retainScope` — the visibility tier `retain` uses when the model omits
 *   the `scope` parameter: `global` | `preset` | `session`; default
 *   `preset`. Recall and reflect always see all three tiers the session
 *   can claim (its own, its preset's, and the global one).
 * - `bankConfig` — optional; a flat map of Hindsight per-bank config
 *   overrides, forwarded verbatim as the server's `updates` — e.g.
 *   `retain_mission`, the "what to retain" policy the server injects into
 *   its fact-extraction prompt. The bank is server-side state, so the
 *   declaration is applied as a one-time PATCH, lazily before the first
 *   memory operation (a failed apply never blocks that operation, and the
 *   next operation retries the sync).
 *
 * The plugin provides no service of its own (it registers into the tools
 * registry and listens on `agent/pre-step`), so its preset row needs no
 * isolate realm — the same as the preset's other tool rows.
 *
 * @module dsh-plugin-hindsight
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

/** Cordis plugin name for loader diagnostics. */
export const name = 'hindsight'

/** Services the plugin requires: tool registration only. */
export const inject = ['tools']

/** Resolved and validated plugin configuration: one mount, one bank. */
interface ResolvedConfig {
  /** Hindsight bank id (case-sensitive). */
  bank: string
  /** Hindsight REST base URL, trailing slashes stripped. */
  baseUrl: string
  /** Optional API key, sent as a Bearer token; `undefined` sends no auth header. */
  apiKey?: string
  /** The per-turn automatic recall is active. */
  autoContext: boolean
  /** `true` (default): the model-visible context carries only the LATEST
   *  automatic snapshot — each new one shadows the previous one on the
   *  session surface (the preserve-thinking pattern). `false`: every
   *  turn's snapshot accumulates in the context. */
  latestOnly: boolean
  /** `true`: retain acknowledges fast and runs fact extraction in the
   *  background; `false` (default): the retain call waits for the bank to
   *  process the memory before returning. */
  retainAsync: boolean
  /** Token budget for recall responses. */
  maxRecallTokens: number
  /** Bound, in milliseconds, for the automatic recall lookup. */
  autoContextTimeoutMs: number
  /** The visibility tier `retain` uses when the model omits the `scope`
   *  parameter (see the tier model in the module doc). */
  retainScope: MemoryScope
  /** Optional Hindsight per-bank config overrides (e.g. `retain_mission`),
   *  forwarded verbatim as the server's `updates` in a one-time config
   *  PATCH that lands before the first memory operation. */
  bankConfig?: Record<string, string>
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8888'
const DEFAULT_MAX_RECALL_TOKENS = 1024
const DEFAULT_AUTO_CONTEXT_TIMEOUT_MS = 2500
/** Bound for the recall query drawn from the user message. */
const MAX_QUERY_CHARS = 1000
/** Bound for detail text embedded in surfaced errors. */
const MAX_ERROR_DETAIL_CHARS = 300

/** The visibility tiers a stored memory can live in (see module doc). */
const MEMORY_SCOPES = ['global', 'preset', 'session'] as const
type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * The session id that owns `session`'s session tier. A subagent leans at
 * the parent that delegated its task: a `session:<child id>` tier would be
 * short-lived and invisible to the parent (orphaned memories), so the child
 * participates in the parent's session tier instead. Plain sessions and
 * forks own their own tier.
 */
function sessionTierId(session: Session): string {
  const header = session.header
  if (header?.origin === 'subagent' && header.parentSession !== undefined) {
    return String(header.parentSession)
  }
  return String(session.id)
}

/**
 * The tag set for a memory stored with the given scope. An item's tag set
 * IS its scope — it carries at most one tier's tag: `global` is the
 * ABSENCE of tags (the bank's global scope), `preset` tags the session's
 * agent preset (`preset:none` when the session has no preset), `session`
 * tags the session id that owns the session tier.
 */
function scopeTags(session: Session, scope: MemoryScope): string[] {
  if (scope === 'global') return []
  if (scope === 'preset') return [`preset:${session.header?.agentPreset ?? 'none'}`]
  return [`session:${sessionTierId(session)}`]
}

/**
 * The tag set for a recall/reflect issued by `session`: its session tier
 * (the parent's when the session is a subagent) plus its preset tier. Under
 * the server's `any` matching that selects exactly the session's own
 * memories, its preset's shared memories, and every untagged (global)
 * memory — and no memory tagged for another session or another preset.
 */
function recallTags(session: Session): string[] {
  return [
    `session:${sessionTierId(session)}`,
    `preset:${session.header?.agentPreset ?? 'none'}`,
  ]
}

interface ConfigIssue {
  message: string
  path?: string[]
}

type ConfigResult = { value: ResolvedConfig } | { issues: readonly ConfigIssue[] }

/** Read one boolean flag from a record, collecting an issue on a non-boolean. */
function boolFlag(
  record: Record<string, unknown>,
  key: string,
  fallback: boolean,
  issues: ConfigIssue[],
): boolean {
  const value = record[key]
  if (value === undefined) return fallback
  if (value !== true && value !== false) {
    issues.push({ message: `${key} must be a boolean`, path: [key] })
    return fallback
  }
  return value
}

/** Read one positive-integer flag from a record, collecting an issue on misuse. */
function intFlag(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  issues: ConfigIssue[],
): number {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    issues.push({ message: `${key} must be a positive integer`, path: [key] })
    return fallback
  }
  return value
}

/**
 * Standard-schema v1 validator for the row's `config`.
 *
 * Hand-rolled on purpose: the deploy location is a preset directory, where
 * Node's upward `node_modules` walk does not reach `@deepseek-ai/schemastery`;
 * a minimal validator keeps the file self-contained while still surfacing
 * issues through Cordis's `ValidationError`.
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly validate: (input: unknown) => ConfigResult
  }
} = {
  '~standard': {
    version: 1,
    validate(input: unknown): ConfigResult {
      const issues: ConfigIssue[] = []
      if (input !== null && typeof input !== 'object') {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const record = (input ?? {}) as Record<string, unknown>

      let bank: string | undefined
      if (record.bank !== undefined) {
        if (typeof record.bank !== 'string' || record.bank.trim().length === 0) {
          issues.push({ message: 'bank must be a non-empty string', path: ['bank'] })
        } else {
          bank = record.bank.trim()
        }
      }
      if (bank === undefined) {
        issues.push({ message: 'bank is required', path: ['bank'] })
      }

      let baseUrl = DEFAULT_BASE_URL
      if (record.baseUrl !== undefined) {
        if (typeof record.baseUrl !== 'string' || record.baseUrl.trim().length === 0) {
          issues.push({ message: 'baseUrl must be a non-empty string', path: ['baseUrl'] })
        } else {
          baseUrl = record.baseUrl.trim().replace(/\/+$/, '')
        }
      }

      let apiKey: string | undefined
      if (record.apiKey !== undefined) {
        if (typeof record.apiKey !== 'string' || record.apiKey.trim().length === 0) {
          issues.push({ message: 'apiKey must be a non-empty string', path: ['apiKey'] })
        } else {
          apiKey = record.apiKey.trim()
        }
      }

      let bankConfig: Record<string, string> | undefined
      if (record.bankConfig !== undefined) {
        const raw = record.bankConfig
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          issues.push({ message: 'bankConfig must be a flat object of string values', path: ['bankConfig'] })
        } else {
          const overrides: Record<string, string> = {}
          for (const [key, entry] of Object.entries(raw)) {
            if (typeof entry !== 'string') {
              issues.push({ message: `bankConfig.${key} must be a string`, path: ['bankConfig', key] })
              continue
            }
            overrides[key] = entry
          }
          bankConfig = Object.keys(overrides).length > 0 ? overrides : undefined
        }
      }

      let retainScope: MemoryScope = 'preset'
      if (record.retainScope !== undefined) {
        if (typeof record.retainScope !== 'string' || !(MEMORY_SCOPES as readonly string[]).includes(record.retainScope)) {
          issues.push({ message: "retainScope must be one of 'global', 'preset', 'session'", path: ['retainScope'] })
        } else {
          retainScope = record.retainScope as MemoryScope
        }
      }

      const value: ResolvedConfig = {
        bank: bank ?? '',
        baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(bankConfig !== undefined ? { bankConfig } : {}),
        autoContext: boolFlag(record, 'autoContext', true, issues),
        latestOnly: boolFlag(record, 'latestOnly', true, issues),
        retainAsync: boolFlag(record, 'retainAsync', false, issues),
        maxRecallTokens: intFlag(record, 'maxRecallTokens', DEFAULT_MAX_RECALL_TOKENS, issues),
        autoContextTimeoutMs: intFlag(record, 'autoContextTimeoutMs', DEFAULT_AUTO_CONTEXT_TIMEOUT_MS, issues),
        retainScope,
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}

/** One recall hit, as surfaced to the model. */
interface RecallHit {
  id: string
  text: string
  type?: string | null
}

/**
 * Register the hindsight tool and the automatic per-turn recall for the
 * lifetime of `ctx`. The bank is fixed by `config` for every session this
 * mount reaches.
 * @param ctx - plugin context; registrations unwind with it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  /** The mount's bank. */
  const bankPath = `/v1/default/banks/${encodeURIComponent(config.bank)}`

  /** Wrap a transport failure in the plugin's clean, bounded error shape. */
  function failure(path: string, error: unknown): Error {
    const reason = error instanceof Error ? error.message : String(error)
    return new Error(`hindsight: ${path} failed: ${reason.slice(0, MAX_ERROR_DETAIL_CHARS)}`)
  }

  /** One bounded REST call against the Hindsight server. Every failure —
   *  connect, read, status — surfaces as the same clean, bounded error. */
  async function request(
    path: string,
    body: unknown,
    signal: AbortSignal,
    method: 'POST' | 'PATCH' = 'POST',
  ): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await fetch(config.baseUrl + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey !== undefined ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      throw failure(path, error)
    }
    let text: string
    try {
      text = await res.text()
    } catch (error) {
      throw failure(path, error)
    }
    if (!res.ok) {
      let detail = text
      try {
        detail = JSON.stringify(JSON.parse(text))
      } catch {
        // not JSON; keep the raw body
      }
      throw new Error(`hindsight: ${path} returned HTTP ${res.status}: ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`)
    }
    let data: unknown
    try {
      data = text.length > 0 ? JSON.parse(text) : {}
    } catch {
      data = { error: text }
    }
    return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  }

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
      bankConfigPending = request(`${bankPath}/config`, { updates: bankConfigUpdates }, signal, 'PATCH')
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

  async function recall(
    query: string,
    signal: AbortSignal,
    session: Session | undefined,
    options?: { types?: readonly string[]; maxTokens?: number },
  ): Promise<RecallHit[]> {
    await syncBankConfig(signal)
    const body: Record<string, unknown> = {
      query,
      max_tokens: options?.maxTokens ?? config.maxRecallTokens,
    }
    if (options?.types !== undefined && options.types.length > 0) body.types = [...options.types]
    withTierFilter(body, session)
    const data = await request(`${bankPath}/memories/recall`, body, signal)
    const results = data.results
    if (!Array.isArray(results)) return []
    return results
      .filter((hit): hit is RecallHit =>
        typeof hit === 'object' && hit !== null
        && typeof (hit as RecallHit).id === 'string'
        && typeof (hit as RecallHit).text === 'string',
      )
  }

  async function retain(
    content: string,
    signal: AbortSignal,
    session: Session | undefined,
    scope: MemoryScope,
  ): Promise<void> {
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
    await request(`${bankPath}/memories`, body, signal)
  }

  async function reflect(
    query: string,
    signal: AbortSignal,
    session: Session | undefined,
  ): Promise<string> {
    await syncBankConfig(signal)
    const body: Record<string, unknown> = { query }
    withTierFilter(body, session)
    const data = await request(`${bankPath}/reflect`, body, signal)
    return typeof data.text === 'string' && data.text.length > 0 ? data.text : 'the bank returned an empty answer'
  }

  /** Render hits as the model-facing memory text. */
  function renderRecall(hits: RecallHit[]): string {
    const lines = [`Relevant memories from the Hindsight bank "${config.bank}":`]
    for (const hit of hits) {
      const type = typeof hit.type === 'string' && hit.type.length > 0 ? ` (${hit.type})` : ''
      lines.push(`- ${hit.text.trim()}${type}`)
    }
    return lines.join('\n')
  }

  /** The latest user-visible text among the step's claimed messages, as a recall query. */
  function queryFromMessages(messages: readonly UserMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message === undefined || !Array.isArray(message.content)) continue
      const text = message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(' ')
        .trim()
      if (text.length > 0) return text.slice(0, MAX_QUERY_CHARS)
    }
    return ''
  }

  /** The plain text of a snapshot message; `''` when it is not one text block. */
  function snapshotText(message: UserMessage): string {
    if (message.content.length !== 1) return ''
    const [block] = message.content
    return block?.type === 'text' ? block.text : ''
  }

  /**
   * This mount's most recent snapshot message still on the model-visible
   * surface (not shadowed by compaction). Scans the durable log from the end:
   * snapshots are appended in time order, so the newest is the last match.
   */
  function findRetainedSnapshot(session: Session): { seq: number; text: string } | undefined {
    const onSurface = new Set(session.surface.nodes)
    const events = session.events
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined || event.type !== 'user/message') continue
      const source = event.data.source
      if (source.kind !== 'plugin' || source.plugin !== name) continue
      if (onSurface.has(event.seq)) return { seq: event.seq, text: snapshotText(event.data) }
    }
    return undefined
  }

  // ── automatic per-turn recall ─────────────────────────────────────────────
  //
  // Assembly runs BEFORE this waterfall, so the memory cannot ride the system
  // prompt for its own turn; the time-context pattern instead appends a
  // plugin-sourced user message to the first step of each turn. The lookup is
  // bounded: a stopped or slow server costs at most autoContextTimeoutMs and
  // the turn proceeds without memory.
  //
  // With `latestOnly` (the default) the snapshot is committed directly to the
  // session surface: each new one SHADOWS the previous one (the same
  // surface-replace mechanism compaction uses), so the model context carries
  // exactly one memory message — the latest recall — while the durable log
  // keeps every snapshot for replay and audit. An empty recall leaves the
  // last snapshot in place; an unchanged one is not re-committed.

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
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
        hits = await recall(query, controller.signal, agent.session)
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    } catch {
      return decision
    }
    if (hits.length === 0) return decision
    const text = renderRecall(hits)
    const snapshot = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
    })
    if (config.latestOnly) {
      const retained = findRetainedSnapshot(agent.session)
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
  }, { prepend: true })

  // ── the model-facing tool ─────────────────────────────────────────────────
  //
  // The description IS the retention policy: it tells the model what is
  // durable (and therefore worth a `retain`) and what is not.

  ctx.tools.register(defineTool({
    name: 'hindsight',
    description:
      `Long-term memory through a Hindsight bank: store durable memories, search them, or ask the bank a question.\n`
      + `\n`
      + `retain — store a memory that should survive this session. Call it whenever the conversation produces something durable and non-obvious: stable facts about the user (identity, role, preferences, constraints), facts about their environment or projects, decisions and their rationale, corrections and lessons learned. Write text as one or two concise, self-contained sentences that make sense without this conversation. Do NOT retain: ephemeral task state, raw code or file contents, anything already recorded in a file, one-off details, or unverified claims. If it is not clearly useful in a future session, do not retain it. The scope parameter chooses where the memory is visible: 'global' to every session of the bank, 'preset' to this agent preset's sessions, 'session' to this session only; omit it for the configured default.\n`
      + `\n`
      + `recall — targeted search over the memories this session can see (its own, its preset's, and the bank's global ones). Relevant memories are also surfaced automatically at the start of each turn; call this only when the surfaced memories do not cover what you need.\n`
      + `\n`
      + `reflect — ask the bank a question and get a synthesized answer grounded in its facts. Use it when the answer must combine several memories, e.g. "what do we know about X?".\n`
      + `\n`
      + `If the Hindsight server is unreachable the call fails with an error: continue the work without the memory and do not retry it repeatedly.`,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['retain', 'recall', 'reflect'],
        description: 'The operation to perform.',
      },
      text: {
        type: 'string',
        description: 'The memory to store, as one or two concise, self-contained sentences. Required for retain.',
      },
      scope: {
        type: 'string',
        enum: ['global', 'preset', 'session'],
        description:
          'Retain only. The visibility tier the memory lands in: '
          + "'global' is visible to every session of the bank, 'preset' to this agent preset's sessions, "
          + "'session' to this session only. Omit to use the configured default.",
      },
      query: {
        type: 'string',
        description: 'The question or topic. Required for recall and reflect.',
      },
      types: {
        type: 'array',
        description: 'Recall only. Restrict the search to these fact types.',
        items: { type: 'string', enum: ['world', 'experience', 'observation'] },
      },
      max_tokens: {
        type: 'number',
        description: 'Recall only. Token budget for the response; defaults to the configured budget.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          bank: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { action?: unknown; bank?: unknown; text?: unknown }
        return [{ type: 'text', text: `${String(result.action ?? 'hindsight')} on bank "${String(result.bank ?? '?')}"\n${String(result.text ?? '')}` }]
      },
    },
    execute: async (args, exec) => {
      switch (args.action) {
        case 'retain': {
          const content = (args.text ?? '').trim()
          if (content.length === 0) throw new Error('hindsight: text is required for retain')
          await retain(content, exec.signal, exec.agent?.session, args.scope ?? config.retainScope)
          return {
            action: 'retain',
            bank: config.bank,
            text: config.retainAsync
              ? 'stored for background extraction; it becomes searchable once the bank processes it'
              : 'stored and processed by the bank; it is searchable now',
          }
        }
        case 'recall': {
          const query = (args.query ?? '').trim()
          if (query.length === 0) throw new Error('hindsight: query is required for recall')
          const hits = await recall(query, exec.signal, exec.agent?.session, {
            types: args.types,
            maxTokens: args.max_tokens,
          })
          return hits.length === 0
            ? { action: 'recall', bank: config.bank, text: 'no memories matched' }
            : { action: 'recall', bank: config.bank, text: renderRecall(hits) }
        }
        case 'reflect': {
          const query = (args.query ?? '').trim()
          if (query.length === 0) throw new Error('hindsight: query is required for reflect')
          const answer = await reflect(query, exec.signal, exec.agent?.session)
          return { action: 'reflect', bank: config.bank, text: answer }
        }
        default:
          throw new Error(`hindsight: unknown action ${String(args.action)}`)
      }
    },
  }))
}
