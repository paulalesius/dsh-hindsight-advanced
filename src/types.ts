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

/** The per-stage ranking scores the bank attaches to a recall result
 *  (`scores`): the combined score that ordered the results (reranker plus
 *  the bank's recency / temporal / proof boosts), and the per-stage
 *  components when the bank computed them. */
export interface RecallScores {
  /** The combined ranking score. Always present on a scored result. */
  final: number
  /** The normalized 0-1 cross-encoder score, when a rerank ran. */
  reranker?: number | null
  /** The vector-similarity score, when the bank returned one. */
  semantic?: number | null
  /** The keyword-overlap score, when the bank returned one. */
  keyword?: number | null
}

/** One lesson recall hit: an `experience`-type memory (a past failure
 *  lesson) whose bank ranking scores were preserved, so the surfaced row
 *  can show how strongly the lesson matched the action. */
export interface LessonHit extends RecallHit {
  /** The bank's per-stage ranking scores for this hit. */
  score?: RecallScores
}

/** One active directive — a standing rule stored in a bank — as the mount
 *  sees it. */
export interface DirectiveRule {
  id: string
  name: string
  content: string
  priority: number
}

/** One stored memory unit read by id: its text and type, plus — for an
 *  observation — the source facts it derives from (the backing facts' ids,
 *  the handles for invalidating them — the observation itself is derived
 *  and cannot be invalidated). */
export interface MemoryUnit {
  id: string
  text: string
  type?: string | null
  /** The source facts the bank folded in behind this unit (observation
   *  provenance), in order; absent when the server returned none. */
  sources?: { id: string; text: string }[]
}

/** Options for a targeted recall. */
export interface RecallOptions {
  /** Restrict to fact types. */
  types?: readonly string[]
  /** Response token budget; the mount's `maxRecallTokens` when omitted. */
  maxTokens?: number
}
