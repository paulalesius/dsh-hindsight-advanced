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
      + `If the Hindsight server is unreachable the call fails with an error: continue the work without the memory and do not retry it repeatedly.`,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['retain', 'recall', 'reflect'],
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
      types: {
        type: 'array',
        description: 'Recall only. Restrict the search to these fact types.',
        items: { type: 'string', enum: ['world', 'experience', 'observation'] },
      },
      max_tokens: {
        type: 'number',
        description: 'Recall only. Token budget for the response; defaults to the configured budget.',
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
          await mount.retain(content, exec.signal, exec.agent?.session, args.scope ?? config.retainScope)
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
        default:
          throw new Error(`hindsight: unknown action ${String(args.action)}`)
      }
    },
  })
}
