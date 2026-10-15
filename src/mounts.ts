/**
 * Cross-mount coordination for dual mounting (a profile-wide host row and a
 * preset row of this plugin reaching the same session): the most specific
 * mount owns the session's automatic recall.
 *
 * Both mounts see a preset's sessions: the host mount's listeners are
 * registered unscoped (they admit every agent of the profile), and the
 * preset mount's listeners are registered under that preset's standing
 * scope (they cover exactly its sessions). Without coordination both
 * mounts auto-recall for the same session, and the session's surface
 * carries two full snapshots per turn - one per bank - on top of the
 * repeats the host mount's mid-step and post-compaction passes add.
 *
 * The rule: when the session's agent preset has its own mount of this
 * plugin, that mount is the session's OWNER, and every other mount
 * applicable to the session (the profile-wide rows) steps back from the
 * auto-recall surfaces for that session - no pre-step snapshot, no
 * turn-stop prefetch, no mid-step or post-compaction recall, no
 * failure-lesson pass, no lesson gate. A shadowed mount contributes only
 * its standing directives, which the owner merges into its own snapshot
 * as a separate per-bank section, so rules stored in a shadowed bank
 * (the user's profile-wide rules) still reach the session. When no preset
 * mount covers the session, every applicable mount is its own owner and
 * nothing is merged: the pre-coordination behavior (complementary
 * per-bank snapshots).
 *
 * The coordination state is a plain property on the shared ROOT context
 * (under a global symbol): every context in one runtime - the host rows'
 * and each preset's standing scope - inherits the same root, and neither
 * mount needs a root-realm service (a preset row cannot publish one) nor
 * module state (the two applies share no module identity). Records are
 * removed when the owning fiber unloads, so a superseded preset generation
 * stops shadowing its bank the moment it dies.
 *
 * @module dsh-plugin-hindsight-advanced/mounts
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'

import type { DirectiveRule } from './types.ts'

/** Registry key of a profile-wide (host-plane) mount. */
export const HOST_KEY: symbol = Symbol.for('dsh-plugin-hindsight-advanced.host-mount')

/** A mount's registration in the shared mount registry. */
export interface MountRecord {
  /** Registry key: HOST_KEY for a profile-wide row, the agent preset id for a preset row. */
  readonly key: string | symbol
  /** The bank this mount serves (names its merged directive section). */
  readonly bank: string
  /** The mount's standing directive listing, tier-scoped to the session. */
  listDirectives: (signal: AbortSignal, session: Session) => Promise<DirectiveRule[]>
}

/** The root-context property key of the shared mount registry. */
const K_MOUNTS = Symbol.for('dsh-plugin-hindsight-advanced.mounts')

/** The shared mount registry on this runtime's root context. */
function registryOf(ctx: Context): Map<string | symbol, MountRecord[]> {
  const root = ctx.root as unknown as Record<PropertyKey, Map<string | symbol, MountRecord[]> | undefined>
  const existing = root[K_MOUNTS]
  if (existing !== undefined) return existing
  const created = new Map<string | symbol, MountRecord[]>()
  root[K_MOUNTS] = created
  return created
}

/**
 * The agent preset id this apply's context sits under - a preset row is
 * applied under its preset's standing scope, whose scope key carries
 * an agentPreset - or undefined on the host plane (an unscoped context, or
 * a scope key with no readable preset id: the mount degrades to a host
 * registration rather than failing to mount).
 * @param ctx - the context the row is applied under.
 * @returns the preset id, or undefined for a host-plane apply.
 */
export function presetIdOf(ctx: Context): string | undefined {
  const key = scopeOf(ctx) as { agentPreset?: unknown } | undefined
  const preset = key?.agentPreset
  return typeof preset === 'string' && preset.length > 0 ? preset : undefined
}

/**
 * Register the mount's record in the shared registry; the returned
 * disposer removes it (the caller runs it when the owning fiber unloads,
 * an effect). A superseded preset generation thus stops shadowing its
 * bank the moment it dies, and a registry key with no live records is
 * deleted outright.
 * @param ctx - any context of the runtime (the registry lives on the shared root).
 * @param record - the mount's registry entry.
 * @returns the disposer.
 */
export function registerMount(ctx: Context, record: MountRecord): () => void {
  const registry = registryOf(ctx)
  const list = registry.get(record.key)
  if (list === undefined) registry.set(record.key, [record])
  else list.push(record)
  return () => {
    const current = registry.get(record.key)
    if (current === undefined) return
    const remaining = current.filter(entry => entry !== record)
    if (remaining.length === 0) registry.delete(record.key)
    else registry.set(record.key, remaining)
  }
}

/**
 * This mount's stance on the session's auto-recall surfaces:
 *
 * - silent true: the session's preset has its own mount of this plugin
 *   and this mount is not one of them - a profile-wide row shadowed by
 *   the preset's, or a preset row for ANOTHER preset (whose scoped
 *   listeners never admit the session in a real runtime but whose
 *   listeners are still gated here; tests drive them unscoped). Every
 *   auto-recall surface skips the session outright; the owner serves it.
 * - directiveSources: the mounts whose standing directives this mount
 *   merges into its snapshot - non-empty only when this mount is the
 *   owner of a preset-covered session (the shadowed profile-wide rows);
 *   every other session gets an empty list (no merging).
 *
 * @param ctx - the mount's own context (only used to find the shared registry).
 * @param self - this mount's registry entry.
 * @param session - the session the surface fired for.
 */
export function mountStance(
  ctx: Context,
  self: MountRecord,
  session: Session,
): { silent: boolean; directiveSources: MountRecord[] } {
  const preset = session.header?.agentPreset
  if (preset === undefined) return { silent: false, directiveSources: [] }
  const registry = registryOf(ctx)
  const own = registry.get(preset)
  if (own === undefined || own.length === 0) {
    // The session's preset carries no mount of this plugin: a preset row
    // for another preset does not serve the session; a profile-wide row
    // is the session's only source.
    return { silent: self.key !== HOST_KEY, directiveSources: [] }
  }
  if (!own.includes(self)) return { silent: true, directiveSources: [] }
  return { silent: false, directiveSources: registry.get(HOST_KEY) ?? [] }
}
