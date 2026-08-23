/**
 * Hindsight long-term memory for a dsh profile — userland, per-preset.
 *
 * This plugin is a plain in-process plugin: a small tree of dependency-light
 * ESM modules (this entry file plus `src/`) that each PRESET that wants
 * memory mounts with its own row in its own `agent.cordis.yml`, carrying its
 * own `bank`. The plugin is preset-agnostic — it never reads the session's
 * `agentPreset` for isolation; a different bank per preset is expressed by
 * mounting the row in different presets with different configs:
 *
 *   # ~/.dsh/.agent-presets/standard/agent.cordis.yml
 *   - id: hindsight
 *     name: ./hindsight.ts
 *     config:
 *       bank: hermes
 *
 *   # ~/.dsh/.agent-presets/code/agent.cordis.yml
 *   - id: hindsight
 *     name: ./hindsight.ts
 *     config:
 *       bank: dsh-code
 *
 * Presets without the row get no `hindsight` tool at all — there is no
 * unmapped/inert state to configure. A session gets the tool, the automatic
 * recall, and the bank of whichever preset it was created from; subagents
 * inherit the parent preset's composition and therefore the same mount.
 *
 * What each mount gives its preset's agents:
 *
 * - a `hindsight` tool with three actions:
 *   - `retain` — store a durable memory. WHAT and WHEN gets stored is decided
 *     by the model from the tool description (durable facts, preferences,
 *     decisions and their rationale; never ephemera or raw code). WHERE it
 *     lands is the visibility tier: the model's `scope` parameter (or the
 *     mount's `retainScope` default) picks `global`, `preset`, or `session`
 *     (see the tier model below). Stored synchronously by default (the call
 *     waits for the bank to process it); `retainAsync: true` acknowledges
 *     fast and runs fact extraction in the background instead. A BEHAVIORAL
 *     RULE (how to act: "always X", "never do Y") is stored with
 *     `kind: 'directive'` (+ a short `name`) as a standing directive instead:
 *     directives are not retrieved by relevance — they are applied, listed
 *     tier-scoped (the same tag model as memories) and rendered in their own
 *     "Standing rules" section of the per-turn snapshot, so a stored rule
 *     reaches the model every turn even when the recall matches nothing.
 *   - `recall` — a targeted semantic search over the mount's bank, scoped
 *     to the session's three visible tiers (below).
 *   - `reflect` — a synthesized answer grounded in the bank's facts, with
 *     the same tier scoping as recall.
 * - automatic recall: on the first step of each turn the latest user message
 *   is queried and the bank's active standing directives are listed, and
 *   both become a plugin-sourced snapshot message (the same pattern
 *   `time-context` uses for the clock). The lookups share one bounded budget
 *   and subagent sessions are skipped, so a slow or stopped Hindsight server
 *   never blocks a turn.
 *
 *   The snapshot is only ever appended — the plugin never replaces or
 *   erases a previous turn's snapshot — so the model context accumulates one
 *   snapshot per distinct turn, while the durable log keeps every snapshot
 *   for replay and audit. An identical recall is not re-committed (no
 *   churn); an empty recall leaves the existing snapshots in place.
 *
 * Visibility tiers (the plugin's tag model — the model never sees tags):
 * the plugin tags every stored memory with at most ONE tier's tag, and the
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
 * another session or another preset. Banks remain the outer isolation
 * boundary: separate banks (separate mounts) for separate memory surfaces.
 *
 * Config (the row's `config` block):
 * - `bank` — REQUIRED. Hindsight bank id (case-sensitive; the server
 *   auto-creates a bank on first use).
 * - `baseUrl` — Hindsight REST base; default `http://127.0.0.1:8888`.
 * - `apiKey` — optional; sent as `Authorization: Bearer <key>` on every call.
 * - `autoContext` — default `true`; `false` disables the per-turn recall
 *   (the tool stays available).
 * - `retainAsync` — default `false` (synchronous: the retain call waits for
 *   the bank to process the memory); `true` acknowledges fast and runs fact
 *   extraction in the background.
 * - `maxRecallTokens` — recall response budget; default `1024`.
 * - `autoContextTimeoutMs` — bound for the automatic lookup; default `2500`.
 * - `retainScope` — the visibility tier `retain` uses when the model omits
 *   the `scope` parameter: `global` | `preset` | `session`; default
 *   `preset`. Recall and reflect always see all three tiers the session
 *   can claim (its own, its preset's, and the global one).
 * - `bankConfig` — optional; a flat map of Hindsight per-bank config
 *   overrides, forwarded verbatim as the server's `updates` — e.g.
 *   `retain_mission`, the "what to retain" policy the server injects into
 *   its fact-extraction prompt. The bank is server-side state, so the
 *   declaration is applied as a one-time PATCH, lazily before the first
 *   memory operation (a failed apply never blocks that operation, and the
 *   next operation retries the sync).
 *
 * The plugin provides no service of its own (it registers into the tools
 * registry and listens on `agent/pre-step`), so its preset row needs no
 * isolate realm — the same as the preset's other tool rows.
 *
 * Code layout: this file is the entry the loader imports (the Plugin.Object
 * contract: `name`/`inject`/`Config`/`apply`); `src/` holds the modules —
 * `types` (shared shapes), `tiers` (the tag/tier model), `config` (the
 * Standard-Schema validator), `client` (the REST transport), `bank` (the
 * per-mount factory and its operations), `snapshot` (auto-recall surface
 * logic), `tool` (the model-facing tool), `autorecall` (the pre-step
 * listener).
 *
 * @module dsh-plugin-hindsight
 */

import type { Context } from '@deepseek-ai/cordis'

import { buildAutoRecall } from './src/autorecall.ts'
import { createMount } from './src/bank.ts'
import { Config, type ResolvedConfig } from './src/config.ts'
import { buildTool } from './src/tool.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'hindsight'

/** Services the plugin requires: tool registration only. */
export const inject = ['tools']

/** The Standard-Schema v1 validator for the row's `config`. */
export { Config }

/**
 * Register the hindsight tool and the automatic per-turn recall for the
 * lifetime of `ctx`. The bank is fixed by `config` for every session this
 * mount reaches.
 * @param ctx - plugin context; registrations unwind with it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  /** One mount: the bank's operations and its per-mount state. */
  const mount = createMount(config)

  ctx.on('agent/pre-step', buildAutoRecall(mount, name), { prepend: true })

  ctx.tools.register(buildTool(mount))
}
