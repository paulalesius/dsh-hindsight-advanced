/**
 * The mount's configuration: the Standard-Schema v1 validator for the row's
 * `config` block and the resolved shape it produces.
 *
 * @module dsh-plugin-hindsight/config
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
  /** The per-turn automatic recall is active. */
  autoContext: boolean
  /** `true`: retain acknowledges fast and runs fact extraction in the
   *  background; `false` (default): the retain call waits for the bank to
   *  process the memory before returning. */
  retainAsync: boolean
  /** Token budget for recall responses. */
  maxRecallTokens: number
  /** Bound, in milliseconds, for the automatic recall lookup. */
  autoContextTimeoutMs: number
  /** The visibility tier `retain` uses when the model omits the `scope`
   *  parameter (see the tier model in `tiers.ts`). */
  retainScope: MemoryScope
  /** Optional Hindsight per-bank config overrides (e.g. `retain_mission`),
   *  forwarded verbatim as the server's `updates` in a one-time config
   *  PATCH that lands before the first memory operation. */
  bankConfig?: Record<string, string>
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8888'
const DEFAULT_MAX_RECALL_TOKENS = 1024
const DEFAULT_AUTO_CONTEXT_TIMEOUT_MS = 2500

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
        retainAsync: boolFlag(record, 'retainAsync', false, issues),
        maxRecallTokens: intFlag(record, 'maxRecallTokens', DEFAULT_MAX_RECALL_TOKENS, issues),
        autoContextTimeoutMs: intFlag(record, 'autoContextTimeoutMs', DEFAULT_AUTO_CONTEXT_TIMEOUT_MS, issues),
        retainScope,
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}
