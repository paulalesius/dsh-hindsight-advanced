/**
 * Shared shapes used across the hindsight plugin's modules.
 *
 * @module dsh-plugin-hindsight/types
 */

/** One recall hit, as surfaced to the model. */
export interface RecallHit {
  id: string
  text: string
  type?: string | null
}

/** One active directive — a standing rule stored in a bank — as the mount
 *  sees it. */
export interface DirectiveRule {
  id: string
  name: string
  content: string
  priority: number
}

/** Options for a targeted recall. */
export interface RecallOptions {
  /** Restrict to fact types. */
  types?: readonly string[]
  /** Response token budget; the mount's `maxRecallTokens` when omitted. */
  maxTokens?: number
}
