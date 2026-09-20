/**
 * The automatic-recall surface logic: derive the recall query from the
 * step's messages (the turn's anchor, an intervention step's human steer,
 * or the previous step's committed assistant message for a mid-step
 * agent-output recall), render hits as the model-facing memory text,
 * render the marker for an unchanged recall (the applied memories, one
 * compact line each), render the tombstone a `recallPreserve: false`
 * surface installs in place of a retired snapshot card (a one-line
 * `notice`-form marker; the full card of the current recall is the one
 * appended at its own turn), and find this mount's full snapshots still
 * on the model-visible surface (an unchanged recall commits the marker
 * instead of a duplicate block; tombstones are never snapshots).
 *
 * @module dsh-plugin-hindsight-advanced/snapshot
 */

import type { AssistantMessage, Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'

import type { DirectiveRule, RecallHit } from './types.ts'

/** Bound for the recall query drawn from the user message. */
export const MAX_QUERY_CHARS = 1000

/** Render hits as the model-facing memory text. A curatable hit (a world /
 *  experience fact) carries its id — the handle for memory curation. An
 *  observation hit carries NO id of its own: the bank refuses to curate
 *  derived observations, so rendering its id would hand the model the exact
 *  handle that 400s. The curatable half of an observation pair is its
 *  backing fact, rendered under it on the `from:` line — ids ONLY, no fact
 *  text: the consolidated observation already supersedes its sources, so
 *  re-rendering their text would only duplicate the recall context. */
export function renderRecall(bank: string, hits: RecallHit[]): string {
  const lines = [`Relevant memories from the Hindsight bank "${bank}":`]
  for (const hit of hits) {
    const type = typeof hit.type === 'string' && hit.type.length > 0 ? ` (${hit.type})` : ''
    const id = hit.type === 'observation' ? '' : ` id:${hit.id}`
    lines.push(`- ${hit.text.trim()}${type}${id}`)
    if (hit.sources !== undefined && hit.sources.length > 0) {
      lines.push(`  from: ${hit.sources.map(source => `id:${source.id}`).join('; ')}`)
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

/**
 * The tombstone a `recallPreserve: false` surface installs in place of a
 * RETIRED snapshot: when a new snapshot refreshes the context, the old full
 * card is replaced — at its own slot, right where that turn's recall fired —
 * by this one-line marker, while the full new snapshot is appended as a
 * fresh card at its own turn. The model reads `text` (a few dozen tokens,
 * vs. thousands for the card it stands in for: the retirement's meter delta
 * is the tiny tombstone minus the retired card's full price); the UI shows
 * `summary` on the collapsed row — `form: 'notice'` is the form whose whole
 * point is a one-line account readable without expanding, so every past
 * recall turn keeps a visible marker of WHERE it recalled without anyone
 * scrolling, and the single full card at the latest recall turn is the
 * content. The wording never lists a memory (that text is the card's job)
 * and never equals a rendered recall (a tombstone can therefore never trip
 * the unchanged-recall comparison).
 */
export function renderTombstone(bank: string): { text: string; summary: string } {
  return {
    text: `Hindsight bank "${bank}": a memory snapshot was applied on this turn and was later refreshed; the current snapshot is the newest one below.`,
    summary: `memory snapshot applied here — refreshed later; the full text is the newest snapshot below`,
  }
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

/** The latest HUMAN message's text among the step's claimed messages: the
 *  recall anchor for an intervention step. A later step's claim can carry
 *  plugin-injected user-role context rows alongside the steering, and a
 *  claim that holds only plugin context (or no text at all) is not an
 *  intent: `''` means the step recalls nothing. */
export function queryFromHumanMessages(messages: readonly UserMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.source?.kind !== 'user') continue
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(' ')
      .trim()
    if (text.length > 0) return text.slice(0, MAX_QUERY_CHARS)
  }
  return ''
}

/** Cap for the mid-step recall anchor's visible text (the joined `text`
 *  blocks of the previous step's committed assistant message, before the
 *  final {@link MAX_QUERY_CHARS} query cap). */
export const MID_STEP_TEXT_CHARS = 600

/** Cap for the mid-step recall anchor's reasoning (the joined `reasoning`
 *  blocks of the previous step's committed assistant message, before the
 *  final {@link MAX_QUERY_CHARS} query cap). */
export const MID_STEP_REASONING_CHARS = 400

/** The block kind(s) a mid-step recall was anchored on: the tag for the
 *  collapsed row's label (`recall:text - <ms>ms`, `recall:think - <ms>ms`,
 *  `recall:think+text - <ms>ms`). */
export type MidStepKind = 'text' | 'think' | 'think+text'

/** One mid-step recall's anchor, derived from the previous step's
 *  committed assistant message. */
export interface MidStepAnchor {
  /** The composed anchor: the enabled kinds joined in the model's
   *  generation order (the reasoning first, then the text), each kind's
   *  blocks joined with a space and capped at its bound. */
  anchor: string
  /** Which kind(s) the anchor is made of (the row's label tag). */
  kind: MidStepKind
}

/**
 * The mid-step recall anchor from a step's committed assistant message:
 * the enabled block kinds (gated by `recallAfterText` /
 * `recallAfterReasoning`), reasoning first and then text (the model's
 * generation order), each kind's non-empty blocks joined with a space and
 * capped at its bound, the two kinds joined with a newline. `null` when
 * neither enabled kind is present in the message (or the message carries
 * no block array at all, as an interrupted prefix may): the step anchors
 * nothing and the pre-step passes through.
 */
export function midStepAnchor(
  message: AssistantMessage,
  recallAfterText: boolean,
  recallAfterReasoning: boolean,
): MidStepAnchor | null {
  if (!recallAfterText && !recallAfterReasoning) return null
  if (!Array.isArray(message.content)) return null
  const text = recallAfterText
    ? message.content
        .filter(block => block.type === 'text')
        .map(block => block.text.trim())
        .filter(part => part.length > 0)
        .join(' ')
        .slice(0, MID_STEP_TEXT_CHARS)
    : ''
  const reasoning = recallAfterReasoning
    ? message.content
        .filter(block => block.type === 'reasoning')
        .map(block => block.text.trim())
        .filter(part => part.length > 0)
        .join(' ')
        .slice(0, MID_STEP_REASONING_CHARS)
    : ''
  const parts = [reasoning, text].filter(part => part.length > 0)
  const anchor = parts.join('\n').trim()
  if (anchor.length === 0) return null
  const kind: MidStepKind = parts.length === 2 ? 'think+text' : reasoning.length > 0 ? 'think' : 'text'
  return { anchor, kind }
}

/**
 * The previous step's committed assistant message from `session`'s
 * durable log (the `assistant/message` event for `turn`, `step - 1`): the
 * message plus the event's seq (the caller drops that line from the
 * query's context), or `undefined` when the log carries no such event (the
 * loop has not committed the previous step yet: the mid-step recall
 * degrades to a pass-through). `assistant/attempt` rows are log-only
 * records of attempts that committed nothing and never anchor. By the
 * time the pre-step for `step` fires, the loop has already appended
 * `step - 1`'s event to the durable log, so the lookup finds it.
 */
export function previousStepAssistant(
  session: Session,
  turn: number,
  step: number,
): { message: AssistantMessage; seq: SessionSeq } | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    if (event.data.turn !== turn || event.data.step !== step - 1) continue
    return { message: event.data.message, seq: event.seq }
  }
  return undefined
}

/** The last HUMAN message on `session`'s durable log, as a recall query —
 *  the turn-stopping prefetch needs it because that event carries no
 *  messages. Scans the log from the end (the tail is never shadowed by
 *  compaction) and skips every non-human `user/message`: this plugin's own
 *  snapshots and the other plugin-sourced context rows are user-role
 *  messages too, and none of them is a query. */
export function queryFromSession(session: Session): string {
  const events = session.snapshotEvents()
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

/** A message's text as ONE query line: the text blocks joined with a space,
 *  every whitespace run collapsed (a context line must stay one line). */
function queryLine(message: UserMessage | AssistantMessage): string {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The last `turns` HUMAN turns on `session`'s durable log, rendered as
 * context lines, oldest first: one line per message — `user: …` for the
 * turn's human message and `assistant: …` for each assistant reply in the
 * turn. A turn starts at a HUMAN `user/message` (the same rule
 * `queryFromSession` applies — plugin-sourced user-role rows, including
 * this plugin's own snapshots, are not turns) and runs to the next one.
 * `dropLastHuman` omits the log's last human message's own line — the
 * prefetch's anchor, which is the query's tail, not its context (its
 * assistant replies, which come after it, stay). `dropSeq` additionally
 * omits one named event's line: the mid-step anchor's own line (the
 * anchor is the query's tail, not its context).
 */
function contextLines(session: Session, turns: number, dropLastHuman: boolean, dropSeq?: SessionSeq): string[] {
  const entries: { seq: SessionSeq; role: 'user' | 'assistant'; line: string }[] = []
  let lastHumanAt = -1
  const events = session.snapshotEvents()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'user/message') {
      if (event.data.source?.kind !== 'user') continue
      const line = queryLine(event.data)
      if (line.length === 0) continue
      lastHumanAt = entries.length
      entries.push({ seq: event.seq, role: 'user', line })
    } else if (event.type === 'assistant/message') {
      const line = queryLine(event.data.message)
      if (line.length === 0) continue
      entries.push({ seq: event.seq, role: 'assistant', line })
    }
  }
  if (turns <= 0) return []
  // The window starts at the `turns`-th human turn from the end.
  let humansSeen = 0
  let start = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.role !== 'user') continue
    humansSeen += 1
    if (humansSeen >= turns) {
      start = index
      break
    }
  }
  if (start === -1) start = 0
  const lines: string[] = []
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) continue
    if (dropLastHuman && index === lastHumanAt) continue
    if (dropSeq !== undefined && entry.seq === dropSeq) continue
    lines.push(`${entry.role}: ${entry.line}`)
  }
  return lines
}

/**
 * The anchor message composed with the session's recent context into the
 * automatic recall's query (the reference Hindsight integrations'
 * `composeRecallQuery` + `truncateRecallQuery`, adapted to the durable
 * session log): the recent PRIOR human turns above the anchor, one
 * `user: …` / `assistant: …` line per message, under a `Prior context:`
 * header, the anchor last. `turns <= 1` (or no context lines) leaves the
 * anchor alone — exactly the single-message query. The composed query is
 * capped at {@link MAX_QUERY_CHARS} the way the reference truncates it:
 * the anchor is kept whole and the OLDEST context lines drop first (if
 * even the anchor alone does not fit, the anchor is what gets cut — the
 * existing cap behavior).
 *
 * `anchorIsOnLog`: the prefetch's anchor is the log's own last human
 * message (its turn counts toward `turns`, its user line is dropped as
 * the anchor, its assistant replies become context lines); the
 * synchronous anchor comes from the pre-step payload, which is not on the
 * log yet (the log holds the prior turns only, so it counts `turns - 1`).
 * A mid-step anchor (the previous step's committed assistant message) is
 * on the log too: the current turn's human line stays in the window (the
 * step recalls against the thing it is responding to) and the anchor's
 * own line is dropped by name instead (its seq as `dropSeq`).
 *
 * `dropSeq`: optionally omit one named event's line from the context:
 * the mid-step anchor's own line, which is the query's tail, not its
 * context.
 */
export function composeRecallQuery(
  session: Session,
  latest: string,
  turns: number,
  anchorIsOnLog: boolean,
  dropSeq?: SessionSeq,
): string {
  const anchor = latest.trim()
  if (anchor.length === 0) return ''
  if (turns <= 1) return anchor.slice(0, MAX_QUERY_CHARS)
  // The prefetch is the only caller that drops the last HUMAN line as the
  // anchor; the mid-step path keeps it (the anchor's line is an assistant
  // line, dropped by seq).
  const dropLastHuman = anchorIsOnLog && dropSeq === undefined
  const lines = contextLines(session, turns - (anchorIsOnLog ? 0 : 1), dropLastHuman, dropSeq)
  if (lines.length === 0) return anchor.slice(0, MAX_QUERY_CHARS)
  const header = 'Prior context:\n\n'
  const tail = `\n\n${anchor}`
  // The reference's truncation: keep the anchor whole, walk the lines
  // newest-first, and drop the oldest while the query is over the cap.
  const kept: string[] = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined) continue
    kept.unshift(line)
    if (`${header}${kept.join('\n')}${tail}`.length > MAX_QUERY_CHARS) {
      kept.shift()
      break
    }
  }
  if (kept.length === 0) return anchor.slice(0, MAX_QUERY_CHARS)
  return `${header}${kept.join('\n')}${tail}`
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
export function findRetainedSnapshots(session: Session, pluginName: string): { seq: SessionSeq; text: string; message: UserMessage }[] {
  const onSurface = new Set(session.surface.nodes)
  const events = session.snapshotEvents()
  const retained: { seq: SessionSeq; text: string; message: UserMessage }[] = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = event.data.source
    // Only FULL snapshot cards are retained: the tombstone a
    // `recallPreserve: false` surface installs in place of a retired card
    // is a plugin message of this same bank, but its `form: 'notice'`
    // marks it as a marker, not a snapshot (its text never equals a
    // rendered recall, so it could not match either — the form check just
    // keeps the set honest).
    if (source.kind !== 'plugin' || source.plugin !== pluginName || source.form !== 'snapshot') continue
    if (onSurface.has(event.seq)) retained.push({ seq: event.seq, text: snapshotText(event.data), message: event.data })
  }
  return retained
}
