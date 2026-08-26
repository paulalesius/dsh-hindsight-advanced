/**
 * The model-facing `hindsight` tool.
 *
 * The description IS the retention policy: it tells the model what is
 * durable (and therefore worth a `retain`) and what is not.
 *
 * @module dsh-plugin-hindsight-advanced/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import type { Mount } from './bank.ts'
import { renderRecall } from './snapshot.ts'

/** Build the `hindsight` tool for the given mount. */
export function buildTool(mount: Mount) {
  const config = mount.config

  return defineTool({
    name: 'hindsight',
    description:
      `Long-term memory through a Hindsight bank: store durable memories, search them, or ask the bank a question.\n`
      + `\n`
      + `retain — store a memory that should survive this session. Call it whenever the conversation produces something durable and non-obvious: stable facts about the user (identity, role, preferences, constraints), facts about their environment or projects, decisions and their rationale, corrections and lessons learned. Write text as one or two concise, self-contained sentences that make sense without this conversation. Do NOT retain: ephemeral task state, raw code or file contents, anything already recorded in a file, one-off details, or unverified claims. If it is not clearly useful in a future session, do not retain it. The scope parameter chooses where the memory is visible: 'global' to every session of the bank, 'preset' to this agent preset's sessions, 'session' to this session only; omit it for the configured default. When the durable thing is a BEHAVIORAL RULE (how to act: "always X", "never do Y", formatting or safety constraints) rather than a fact, store it as a directive instead: kind: 'directive' plus a short unique name — directives are standing rules applied automatically at the start of every turn, not retrieved by relevance like memories.\n`
      + `\n`
      + `recall — targeted search over the memories this session can see (its own, its preset's, and the bank's global ones). Relevant memories are also surfaced automatically at the start of each turn; call this only when the surfaced memories do not cover what you need.\n`
      + `\n`
      + `reflect — ask the bank a question and get a synthesized answer grounded in its facts. Use it when the answer must combine several memories, e.g. "what do we know about X?".\n`
      + `\n`
      + `read — resolve a stored memory's id to its text and type. Call it when you need to see what an id in a recall result or a "from:" line actually says before acting on it (e.g. deciding which of several ids to invalidate). For an observation, the backing facts' ids come back too.\n`
      + `\n`
      + `invalidate — retire a stored memory that has turned out to be wrong or stale (the user corrected it, or you found a direct contradiction), so it stops appearing in recall. Pass the memory's id (the id:<uuid> shown in recall results and the per-turn snapshot) and the reason. Call it only when you are confident the memory is wrong: invalidation is soft and reversible, but do not clobber a memory future sessions still need. If the corrected truth is already stored, prefer invalidating the stale memory over retaining a contradicting fact — a stale memory left live keeps making the bank return both beliefs forever. Only raw facts (world / experience) can be invalidated — an observation hit carries no id of its own, and the id on its "from:" line is the curatable one: invalidate that backing fact to retire it. If the "from:" line lists several ids, decide which level is wrong before calling invalidate:\n`
      + `- the observation is wrong as a statement, but its facts are individually true → invalidate nothing (wrong derivation; the facts are still usable).\n`
      + `- one or more facts are wrong → use read on each id to see its text, then invalidate only the wrong id(s), one call each.\n`
      + `\n`
      + `If the Hindsight server is unreachable the call fails with an error: continue the work without the memory and do not retry it repeatedly.`,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['retain', 'recall', 'reflect', 'read', 'invalidate'],
        description: 'The operation to perform.',
      },
      text: {
        type: 'string',
        description: 'The memory to store, as one or two concise, self-contained sentences. Required for retain.',
      },
      scope: {
        type: 'string',
        enum: ['global', 'preset', 'session'],
        description:
          'Retain only. The visibility tier the memory lands in: '
          + "'global' is visible to every session of the bank, 'preset' to this agent preset's sessions, "
          + "'session' to this session only. Omit to use the configured default.",
      },
      query: {
        type: 'string',
        description: 'The question or topic. Required for recall and reflect.',
      },
      kind: {
        type: 'string',
        enum: ['memory', 'directive'],
        description:
          'Retain only. "memory" (default) stores a fact for relevance-based recall; '
          + '"directive" stores a standing rule that is applied automatically at the start of every turn.',
      },
      name: {
        type: 'string',
        description:
          "Retain with kind 'directive' only: a short unique name for the rule (e.g. 'shell-safe-commit'). "
          + 'Required when kind is directive.',
      },
      timestamp: {
        type: 'string',
        description:
          'Retain of a memory only. When the content OCCURRED, as an ISO 8601 date (e.g. "2026-06-01") — '
          + 'for facts about the past, not just when they were stored. Use "unset" for timeless content. '
          + 'Omit to record the storage time.',
      },
      types: {
        type: 'array',
        description: 'Recall only. Restrict the search to these fact types.',
        items: { type: 'string', enum: ['world', 'experience', 'observation'] },
      },
      max_tokens: {
        type: 'number',
        description: 'Recall only. Token budget for the response; defaults to the configured budget.',
      },
      id: {
        type: 'string',
        description:
          'Invalidate and read only. The memory id, as shown in recall results and the per-turn '
          + 'snapshot (id:<uuid>) or on a "from:" line under an observation hit (which shows no id of '
          + 'its own — the observation itself is derived and cannot be invalidated).',
      },
      reason: {
        type: 'string',
        description: 'Invalidate only. Why the memory is wrong or stale; recorded with the invalidation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          bank: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const result = value as { action?: unknown; bank?: unknown; text?: unknown }
        return [{ type: 'text', text: `${String(result.action ?? 'hindsight')} on bank "${String(result.bank ?? '?')}"\n${String(result.text ?? '')}` }]
      },
    },
    execute: async (args, exec) => {
      switch (args.action) {
        case 'retain': {
          const content = (args.text ?? '').trim()
          if (content.length === 0) throw new Error('hindsight: text is required for retain')
          // An explicit occurrence time, forwarded only when the model gave
          // one ('' → the bank stamps the storage time instead).
          const timestamp = typeof args.timestamp === 'string' ? args.timestamp.trim() : ''
          if (args.kind === 'directive') {
            const directiveName = (args.name ?? '').trim()
            if (directiveName.length === 0) {
              throw new Error('hindsight: name is required for retain with kind directive')
            }
            await mount.retainDirective(directiveName, content, exec.signal, exec.agent?.session, args.scope ?? config.retainScope)
            return {
              action: 'retain',
              bank: config.bank,
              text: `stored as standing directive "${directiveName}"; it is applied automatically at the start of every turn`,
            }
          }
          await mount.retain(
            content,
            exec.signal,
            exec.agent?.session,
            args.scope ?? config.retainScope,
            timestamp.length > 0 ? timestamp : undefined,
          )
          return {
            action: 'retain',
            bank: config.bank,
            text: config.retainAsync
              ? 'stored for background extraction; it becomes searchable once the bank processes it'
              : 'stored and processed by the bank; it is searchable now',
          }
        }
        case 'recall': {
          const query = (args.query ?? '').trim()
          if (query.length === 0) throw new Error('hindsight: query is required for recall')
          const hits = await mount.recall(query, exec.signal, exec.agent?.session, {
            types: args.types,
            maxTokens: args.max_tokens,
          })
          return hits.length === 0
            ? { action: 'recall', bank: config.bank, text: 'no memories matched' }
            : { action: 'recall', bank: config.bank, text: renderRecall(config.bank, hits) }
        }
        case 'reflect': {
          const query = (args.query ?? '').trim()
          if (query.length === 0) throw new Error('hindsight: query is required for reflect')
          const answer = await mount.reflect(query, exec.signal, exec.agent?.session)
          return { action: 'reflect', bank: config.bank, text: answer }
        }
        case 'read': {
          const memoryId = (args.id ?? '').trim()
          if (memoryId.length === 0) throw new Error('hindsight: id is required for read')
          const unit = await mount.read(memoryId, exec.signal)
          // The same rendering contract as recall: text + type + id — and for
          // an observation, its backing facts under it, WITH their text this
          // time: this is the disambiguation call, the one whose whole reason
          // to exist is to show what each id actually says.
          const type = unit.type === null ? '' : ` (${unit.type})`
          let text = `- ${unit.text}${type} id:${unit.id}`
          if (unit.sources !== undefined && unit.sources.length > 0) {
            const lines = unit.sources.map(source =>
              source.text.length > 0 ? `- id:${source.id} — "${source.text}"` : `- id:${source.id}`,
            )
            text += `\n  from:\n  ${lines.join('\n  ')}`
          }
          return { action: 'read', bank: config.bank, text }
        }
        case 'invalidate': {
          const memoryId = (args.id ?? '').trim()
          if (memoryId.length === 0) throw new Error('hindsight: id is required for invalidate')
          const reason = (args.reason ?? '').trim()
          if (reason.length === 0) throw new Error('hindsight: reason is required for invalidate')
          try {
            await mount.invalidate(memoryId, reason, exec.signal)
          } catch (error) {
            // The bank's 400 for a derived observation is the one trap the
            // model can still fall into (a snapshot committed earlier in
            // this session can predate the no-id rendering) — surface it
            // as the instruction it should have been, not a raw HTTP error.
            if (error instanceof Error && error.message.includes('is a observation')) {
              throw new Error(
                `hindsight: ${memoryId} is a derived observation — it regenerates from its source facts and cannot be invalidated directly. `
                + 'If the fact is wrong, invalidate its backing fact instead: pass the id on the \'from:\' line under that observation.',
              )
            }
            throw error
          }
          return {
            action: 'invalidate',
            bank: config.bank,
            text: `memory ${memoryId} invalidated and archived; it no longer appears in recall (the bank can restore it)`,
          }
        }
        default:
          throw new Error(`hindsight: unknown action ${String(args.action)}`)
      }
    },
  })
}
