/**
 * The mount's configuration: the Standard-Schema v1 validator for the row's
 * `config` block and the resolved shape it produces.
 *
 * @module dsh-plugin-hindsight-advanced/config
 */

import { MEMORY_SCOPES, type MemoryScope } from './tiers.ts'

/** Resolved and validated plugin configuration: one mount, one bank. */
export interface ResolvedConfig {
  /** Hindsight bank id (case-sensitive). */
  bank: string
  /** Hindsight REST base URL, trailing slashes stripped. */
  baseUrl: string
  /** Optional API key, sent as a Bearer token; `undefined` sends no auth header. */
  apiKey?: string
  /** Optional credential REFERENCE (a POSIX identifier such as `HINDSIGHT_API_KEY`);
   *  the VALUE is resolved per call through the credentials seam (which layers
   *  process env, `$DSH_HOME/.credentials.yaml`, and `.env` files) — never stored
   *  here. Mutually exclusive with the literal `apiKey`. */
  apiKeyRef?: string
  /** The per-turn automatic recall is active. */
  autoContext: boolean
  /** `true` (default): the recall starts AHEAD of the turn that pays for
   *  it (the `agent/turn-stopping` job), so from the second turn on the
   *  snapshot targets the PREVIOUS turn's message. `false`: no job starts;
   *  every turn takes the bounded synchronous path, whose query is the
   *  message that just arrived (the turn waits on the server for it). */
  prefetch: boolean
  /** How many recent turns the automatic recall composes into its query
   *  (the reference Hindsight integrations' `recallContextTurns`): `1` =
   *  the anchor message only (the current turn's message on the
   *  synchronous path, the previous turn's message on the prefetch);
   *  `N` = the `N - 1` most recent PRIOR human turns above it, rendered
   *  as a `Prior context:` block (their user messages and the assistant
   *  replies between them), the whole thing capped at the query bound with
   *  the anchor kept whole and the oldest context dropping first. */
  recallContextTurns: number
  /** `true`: a LATER step of a running turn (a step claim without a human
   *  message) recalls when the previous step's committed assistant message
   *  carries visible `text` blocks: the step takes the bounded synchronous
   *  path anchored on that text, and its row is labeled `recall:text -
   *  <ms>ms`. Default `false`: a non-human step claim recalls nothing (the
   *  pre-step stays intervention-only). */
  recallAfterText: boolean
  /** `true`: the same mid-step recall, anchored on the previous step's
   *  `reasoning` blocks (its thinking) instead of its visible text (row
   *  label `recall:think - <ms>ms`). Default `false`. With BOTH keys on, a
   *  step that carries both kinds gets ONE recall on one composed anchor
   *  (row label `recall:think+text - <ms>ms`): never two lookups. A
   *  steering claim always wins the precedence over either anchor (the
   *  intervention path). */
  recallAfterReasoning: boolean
  /** `true`: at a LATER step of a running turn, the previous step's
   *  committed tool calls are matched against the bank's `experience`-type
   *  memories (past failure lessons) and the best matches are committed as
   *  a `form: 'notice'` row (no label - just its summary). The branch
   *  runs only when the mid-step anchor branch (the `recallAfterText` /
   *  `recallAfterReasoning` keys) did not attempt a recall of its own: one
   *  bounded recall pass per step. A steering claim wins the precedence
   *  over the branch; lessons already surfaced this turn are never repeated.
   *  Default `false`. Gated by `autoContext` like the other automatic
   *  branches. */
  actionLessons: boolean
  /** Cap on the number of lessons rendered on one action-lesson row (the
   *  bank's recall may return more; the surplus is dropped before render).
   *  Default 10. */
  actionLessonCandidates: number
  /** `true`: the pre-execution lesson gate. Before a call to a tool named
   *  in `lessonGateTools` is executed, a bounded recall restricted to the
   *  bank's `experience`-type memories (the failure lessons) anchors on
   *  the PENDING call itself (the same anchor shape as the
   *  `actionLessons` pass: `bash: <command>` for bash, `name key=value`
   *  for scalar args). A hit whose match score (the reranker's normalized
   *  score when the bank computed one, else the combined score) is at or
   *  above `lessonGateMinScore` DENIES the call before the tool body
   *  runs: the harness materializes `Error: <reason>` as the tool result
   *  and the rendered lessons travel in the reason, so the model learns
   *  from the recall before the action acts. The gate is a separate
   *  surface, not a mode of `actionLessons`: it returns a decision,
   *  commits nothing to the session, and is never per-turn de-duplicated
   *  (a repeated denial re-carries the lessons - the denial is the
   *  model's only feedback channel). Subagent sessions are skipped (total
   *  silence); only the `lessonGateTools` names pay the lookup; a
   *  timeout, an aborted call, or a bank failure delegates to `next()`
   *  (allow) - no bank, no gate. Gated by `autoContext` like every
   *  automatic branch. Default `false`. */
  lessonGate: boolean
  /** The minimum match score (the reranker's normalized score when the
   *  bank computed one, else the combined score) at which the
   *  pre-execution lesson gate denies a gated call: a hit under the
   *  threshold allows the call, and a hit without any score is under it.
   *  A finite number in `[0, 1]`. Default `0.3`. */
  lessonGateMinScore: number
  /** The tool names the pre-execution lesson gate covers: only calls named
   *  here pay the bounded lookup before execution. Default
   *  `['bash', 'run_code']` (the side-effect-capable executors). */
  lessonGateTools: string[]
  /** `true`: right after a SUCCESSFUL context compaction (the
   *  `compaction/end` session event without an `error`), the bank is
   *  queried for the last HUMAN message on the durable log - the same
   *  anchor and `recallContextTurns` composition as the turn-stop
   *  prefetch - and the snapshot is committed DIRECTLY to the surface
   *  (row label `recall:compact - <ms>ms`): the compaction fires outside
   *  the pre-step decision points (turn boundary, mid-step under
   *  pressure, request retry), so there is no decision to ride. The
   *  lookup is detached (the event is fire-and-forget) and bounded by
   *  `recallCompactTimeoutMs`; a timeout or failure discards the snapshot
   *  silently. An identical recall commits nothing (the unchanged-marker
   *  row under the `recallPreserve: true` default), and under
   *  `recallPreserve: false` a refresh retires the previous full card in
   *  place like any other snapshot. Subagent sessions are skipped.
   *  Default `false`. Gated by `autoContext` like the other automatic
   *  branches. */
  recallAfterCompaction: boolean
  /** `true` (default): the model surface is append-only for the snapshots —
   *  every committed recall stays in the model context. `false`: the
   *  surface carries only the LATEST snapshot — each new one replaces the
   *  previously retained one (the session surface's `replace` op, priced
   *  through the shadow-price `compaction/prune` metering event) while the
   *  durable log keeps every snapshot for replay and audit. Naming matches
   *  the llama-server `--no-reasoning-preserve` flag: with it off, the
   *  server keeps each turn's reasoning only for that turn. */
  recallPreserve: boolean
  /** `true`: retain acknowledges fast and runs fact extraction in the
   *  background; `false` (default): the retain call waits for the bank to
   *  process the memory before returning. */
  retainAsync: boolean
  /** Token budget for recall responses. */
  maxRecallTokens: number
  /** Bound, in milliseconds, for the automatic recall lookup. */
  autoContextTimeoutMs: number
  /** Bound, in milliseconds, for the POST-COMPACTION automatic recall
   *  lookup (`recallAfterCompaction`). The post-compaction query is the
   *  full multi-turn composition (the anchor under a `Prior context:`
   *  block, capped at 1000 chars), which the bank serves slower than the
   *  single-message queries of the loop-blocking paths - so the detached
   *  lookup rides its own bound instead of sharing
   *  `autoContextTimeoutMs` (under the shared bound it times out
   *  deterministically and the snapshot is silently discarded). The path
   *  is fire-and-forget, so the larger default never reaches the agent
   *  loop. */
  recallCompactTimeoutMs: number
  /** The visibility tier `retain` uses when the model omits the `scope`
   *  parameter (see the tier model in `tiers.ts`). */
  retainScope: MemoryScope
  /** Optional Hindsight per-bank config overrides (e.g. `retain_mission`),
   *  forwarded verbatim as the server's `updates` in a one-time config
   *  PATCH that lands before the first memory operation. */
  bankConfig?: Record<string, string>
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8888'
const DEFAULT_MAX_RECALL_TOKENS = 4096
const DEFAULT_AUTO_CONTEXT_TIMEOUT_MS = 2500
/** The default bound for the detached post-compaction recall lookup
 *  (the query is the full multi-turn composition, which the bank serves
 *  slower than the loop-blocking paths' single-message queries; the path
 *  never blocks the agent loop, so the bound stays larger). */
const DEFAULT_RECALL_COMPACT_TIMEOUT_MS = 8000
/** How many recent turns the automatic recall composes into its query
 *  (the reference Hindsight integrations' default is 1; the plugin's is 5
 *  — the `Prior context:` block is the query's first-class part). */
const DEFAULT_RECALL_CONTEXT_TURNS = 5
/** How many action-lesson hits the lesson row renders by default (the
 *  client-side cap applied before render; see {@link ResolvedConfig.actionLessonCandidates}). */
const DEFAULT_ACTION_LESSON_CANDIDATES = 10
/** The default minimum match score at which the pre-execution lesson gate
 *  denies a call: observed weak matches carry 0.000, so the default sits
 *  above noise while a genuine match passes. */
const DEFAULT_LESSON_GATE_MIN_SCORE = 0.3
/** The default tool names the pre-execution lesson gate covers: the
 *  side-effect-capable executors, so only those calls pay the bounded
 *  lookup on the hot path. */
const DEFAULT_LESSON_GATE_TOOLS = ['bash', 'run_code']
/** Credential-reference grammar (a POSIX shell identifier), matching the
 *  credentials seam's own `CredentialRef` so an invalid name is a config
 *  issue rather than a per-call resolution surprise. */
const API_KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

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

/** Read one score flag (a finite number in [0, 1]), collecting an issue on misuse. */
function scoreFlag(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  issues: ConfigIssue[],
): number {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push({ message: `${key} must be a number between 0 and 1`, path: [key] })
    return fallback
  }
  return value
}

/** Read one tool-name list flag, collecting an issue on misuse. */
function toolListFlag(
  record: Record<string, unknown>,
  key: string,
  fallback: readonly string[],
  issues: ConfigIssue[],
): string[] {
  const value = record[key]
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.trim().length === 0)) {
    issues.push({ message: `${key} must be an array of non-empty tool names`, path: [key] })
    return [...fallback]
  }
  return value.map(entry => String(entry).trim())
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

      let apiKeyRef: string | undefined
      if (record.apiKeyRef !== undefined) {
        if (typeof record.apiKeyRef !== 'string' || !API_KEY_REF_PATTERN.test(record.apiKeyRef)) {
          issues.push({
            message: 'apiKeyRef must be a POSIX identifier (e.g. HINDSIGHT_API_KEY)',
            path: ['apiKeyRef'],
          })
        } else {
          apiKeyRef = record.apiKeyRef
        }
      }
      if (record.apiKey !== undefined && record.apiKeyRef !== undefined) {
        issues.push({
          message: 'set apiKey OR apiKeyRef, not both',
          path: ['apiKey', 'apiKeyRef'],
        })
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
        ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
        ...(bankConfig !== undefined ? { bankConfig } : {}),
        autoContext: boolFlag(record, 'autoContext', true, issues),
        prefetch: boolFlag(record, 'prefetch', true, issues),
        recallContextTurns: intFlag(record, 'recallContextTurns', DEFAULT_RECALL_CONTEXT_TURNS, issues),
        recallAfterText: boolFlag(record, 'recallAfterText', false, issues),
        recallAfterReasoning: boolFlag(record, 'recallAfterReasoning', false, issues),
        actionLessons: boolFlag(record, 'actionLessons', false, issues),
        actionLessonCandidates: intFlag(record, 'actionLessonCandidates', DEFAULT_ACTION_LESSON_CANDIDATES, issues),
        lessonGate: boolFlag(record, 'lessonGate', false, issues),
        lessonGateMinScore: scoreFlag(record, 'lessonGateMinScore', DEFAULT_LESSON_GATE_MIN_SCORE, issues),
        lessonGateTools: toolListFlag(record, 'lessonGateTools', DEFAULT_LESSON_GATE_TOOLS, issues),
        recallAfterCompaction: boolFlag(record, 'recallAfterCompaction', false, issues),
        recallPreserve: boolFlag(record, 'recallPreserve', true, issues),
        retainAsync: boolFlag(record, 'retainAsync', false, issues),
        maxRecallTokens: intFlag(record, 'maxRecallTokens', DEFAULT_MAX_RECALL_TOKENS, issues),
        autoContextTimeoutMs: intFlag(record, 'autoContextTimeoutMs', DEFAULT_AUTO_CONTEXT_TIMEOUT_MS, issues),
        recallCompactTimeoutMs: intFlag(record, 'recallCompactTimeoutMs', DEFAULT_RECALL_COMPACT_TIMEOUT_MS, issues),
        retainScope,
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}
