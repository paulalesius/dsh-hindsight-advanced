/**
 * The visibility tier model — the plugin's tag model; the model never sees
 * tags.
 *
 * The plugin tags every stored memory with at most ONE tier's tag, and the
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
 * another session or another preset.
 *
 * @module dsh-plugin-hindsight/tiers
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** The visibility tiers a stored memory can live in. */
export const MEMORY_SCOPES = ['global', 'preset', 'session'] as const

/** One of the visibility tiers. */
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

/**
 * The session id that owns `session`'s session tier. A subagent leans at
 * the parent that delegated its task: a `session:<child id>` tier would be
 * short-lived and invisible to the parent (orphaned memories), so the child
 * participates in the parent's session tier instead. Plain sessions and
 * forks own their own tier.
 */
export function sessionTierId(session: Session): string {
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
export function scopeTags(session: Session, scope: MemoryScope): string[] {
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
export function recallTags(session: Session): string[] {
  return [
    `session:${sessionTierId(session)}`,
    `preset:${session.header?.agentPreset ?? 'none'}`,
  ]
}
