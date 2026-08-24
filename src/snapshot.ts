/**
 * The automatic-recall surface logic: derive the recall query from the
 * step's messages, render hits as the model-facing memory text, and find
 * this mount's most recent snapshot still on the model-visible surface
 * (used to skip re-committing an unchanged recall).
 *
 * @module dsh-plugin-hindsight-advanced/snapshot
 */

import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

import type { DirectiveRule, RecallHit } from './types.ts'

/** Bound for the recall query drawn from the user message. */
export const MAX_QUERY_CHARS = 1000

/** Render hits as the model-facing memory text. Every hit carries its id
 *  (the handle for memory curation); an observation hit the bank backed
 *  with source facts gets its backing facts under it, one `from:` line. */
export function renderRecall(bank: string, hits: RecallHit[]): string {
  const lines = [`Relevant memories from the Hindsight bank "${bank}":`]
  for (const hit of hits) {
    const type = typeof hit.type === 'string' && hit.type.length > 0 ? ` (${hit.type})` : ''
    lines.push(`- ${hit.text.trim()}${type} id:${hit.id}`)
    if (hit.sources !== undefined && hit.sources.length > 0) {
      lines.push(`  from: ${hit.sources.join('; ')}`)
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

/** The plain text of a snapshot message; `''` when it is not one text block. */
function snapshotText(message: UserMessage): string {
  if (message.content.length !== 1) return ''
  const [block] = message.content
  return block?.type === 'text' ? block.text : ''
}

/**
 * `session`'s most recent plugin snapshot message (sourced by
 * `pluginName`) still on the model-visible surface (not shadowed by
 * compaction). Scans the durable log from the end: snapshots are appended
 * in time order, so the newest is the last match.
 */
export function findRetainedSnapshot(session: Session, pluginName: string): { seq: number; text: string } | undefined {
  const onSurface = new Set(session.surface.nodes)
  const events = session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'plugin' || source.plugin !== pluginName) continue
    if (onSurface.has(event.seq)) return { seq: event.seq, text: snapshotText(event.data) }
  }
  return undefined
}
