/**
 * Shared shapes used across the hindsight plugin's modules.
 *
 * @module dsh-plugin-hindsight-advanced/types
 */

/** One recall hit, as surfaced to the model. */
export interface RecallHit {
  id: string
  text: string
  type?: string | null
  /** The source facts the bank returned behind this hit (observation
   *  provenance), in order; each carries the backing fact's id (the handle
   *  for invalidating it — the observation itself is derived and cannot be
   *  invalidated) and its text; absent when the server returned none. */
  sources?: { id: string; text: string }[]
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
