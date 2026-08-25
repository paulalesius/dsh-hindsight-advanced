/**
 * The automatic-recall surface logic: derive the recall query from the
 * step's messages, render hits as the model-facing memory text, render
 * the marker for an unchanged recall (the applied memories, one compact
 * line each), and find this mount's snapshots still on the model-visible
 * surface (an unchanged recall commits the marker instead of a duplicate
 * block).
 *
 * @module dsh-plugin-hindsight-advanced/snapshot
 */

import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

import type { DirectiveRule, RecallHit } from './types.ts'

/** Bound for the recall query drawn from the user message. */
export const MAX_QUERY_CHARS = 1000

/** Render hits as the model-facing memory text. Every hit carries its id
 *  (the handle for memory curation); an observation hit the bank backed
 *  with source facts gets its backing facts under it, one `from:` line per
 *  fact — each with the backing fact's id, the handle for invalidating it
 *  (the observation is derived and cannot be invalidated itself). */
export function renderRecall(bank: string, hits: RecallHit[]): string {
  const lines = [`Relevant memories from the Hindsight bank "${bank}":`]
  for (const hit of hits) {
    const type = typeof hit.type === 'string' && hit.type.length > 0 ? ` (${hit.type})` : ''
    lines.push(`- ${hit.text.trim()}${type} id:${hit.id}`)
    if (hit.sources !== undefined && hit.sources.length > 0) {
      lines.push(`  from: ${hit.sources.map(source => `${source.text} (id:${source.id})`).join('; ')}`)
    }
  }
  return lines.join('\n')
}

/** Render the automatic snapshot: the recalled memories, plus the bank's
 *  standing directives as their OWN section (priority-ordered). Rules reach
 *  the model in this section even when the recall matched nothing — that is
 *  what keeps a stored rule from decaying with recall relevance. */
export function renderSnapshot(bank: string, hits: RecallHit[], rules: DirectiveRule[]): string {
  const parts: string[] = []
  if (hits.length > 0) parts.push(renderRecall(bank, hits))
  if (rules.length > 0) {
    const lines = [`Standing rules from the Hindsight bank "${bank}" — follow them every turn:`]
    for (const rule of rules) {
      lines.push(`- ${rule.content.trim()}`)
    }
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}

/** Cap for one recalled memory on the unchanged-recall marker row. */
export const MARKER_HIT_CHARS = 160

/** One hit's headline: its first line, capped at {@link MARKER_HIT_CHARS}. */
function hitHeadline(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? ''
  if (line.length <= MARKER_HIT_CHARS) return line
  const cut = line.slice(0, MARKER_HIT_CHARS)
  const space = cut.lastIndexOf(' ')
  return `${space > MARKER_HIT_CHARS - 20 ? cut.slice(0, space) : cut}…`
}

/** The row an UNCHANGED recall commits instead of a duplicate block: the
 *  full snapshot is already on the surface (re-committing it would be
 *  churn), but the turn still gets its own context row — and that row NAMES
 *  what it applied (one compact line per recalled memory, plus a pointer
 *  for the standing rules), so the UI shows which memories were applied on
 *  this turn without duplicating the block in the model context. */
export function renderUnchanged(bank: string, hits: RecallHit[], rules: DirectiveRule[]): string {
  const lines = [`Hindsight bank "${bank}": no new memories this turn — the snapshot shown earlier in this conversation is still in effect:`]
  for (const hit of hits) {
    const headline = hitHeadline(hit.text)
    if (headline.length > 0) lines.push(`- ${headline}`)
  }
  if (rules.length > 0) lines.push(`Standing rules from the bank unchanged — still in effect.`)
  return lines.join('\n')
}

/** The latest user-visible text among the step's claimed messages, as a recall query. */
export function queryFromMessages(messages: readonly UserMessage[]): string {
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

/** The last HUMAN message on `session`'s durable log, as a recall query —
 *  the turn-stopping prefetch needs it because that event carries no
 *  messages. Scans the log from the end (the tail is never shadowed by
 *  compaction) and skips every non-human `user/message`: this plugin's own
 *  snapshots and the other plugin-sourced context rows are user-role
 *  messages too, and none of them is a query. */
export function queryFromSession(session: Session): string {
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    if (event.data.source?.kind !== 'user') continue
    if (!Array.isArray(event.data.content)) continue
    const text = event.data.content
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
 * `session`'s plugin snapshot messages (sourced by `pluginName`) still on
 * the model-visible surface (not shadowed by compaction), newest first.
 * Scans the durable log from the end. The caller compares the rendered
 * recall against EVERY one of them — not just the newest — because a
 * snapshot two turns back is still on the surface, and re-committing it
 * would be churn too (the unchanged-recall marker row is a plugin
 * snapshot message as well, but its text never equals a rendered recall,
 * so it can never trigger the comparison).
 */
export function findRetainedSnapshots(session: Session, pluginName: string): { seq: number; text: string }[] {
  const onSurface = new Set(session.surface.nodes)
  const events = session.events
  const retained: { seq: number; text: string }[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'plugin' || source.plugin !== pluginName) continue
    if (onSurface.has(event.seq)) retained.push({ seq: event.seq, text: snapshotText(event.data) })
  }
  return retained
}
