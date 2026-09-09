/**
 * Hindsight long-term memory for a dsh profile — userland, per-preset.
 *
 * This plugin is a plain in-process plugin: a small tree of dependency-light
 * ESM modules (this entry file plus `src/`) that each PRESET that wants
 * memory mounts with its own row in its own `agent.cordis.yml`. The plugin
 * is preset-agnostic — it never reads the session's `agentPreset` for
 * isolation. What separates the presets' memories is the visibility scope
 * inside the bank (the `global` / `preset` / `session` model below):
 * presets normally share ONE bank and the preset scope already keeps their
 * memories apart. A different `bank` per row is for genuinely separate
 * memory surfaces (or a different Hindsight server) only:
 *
 *   # ~/.dsh/.agent-presets/standard/agent.cordis.yml
 *   - id: hindsight
 *     name: ./hindsight-advanced.ts
 *     config:
 *       bank: dsh
 *
 *   # ~/.dsh/.agent-presets/code/agent.cordis.yml
 *   - id: hindsight
 *     name: ./hindsight-advanced.ts
 *     config:
 *       bank: dsh
 *
 * Presets without the row get no `hindsight` tool at all — there is no
 * unmapped/inert state to configure. A session gets the tool, the automatic
 * recall, and the bank of whichever preset it was created from; subagents
 * inherit the parent preset's composition and therefore the same mount.
 *
 * What each mount gives its preset's agents:
 *
 * - a `hindsight` tool with four actions:
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
 *   - `invalidate` — retire a memory the model has shown to be wrong or
 *     stale. The model passes the memory's id (the handle recall results
 *     and the per-turn snapshot render as `id:<uuid>`) and a reason; the
 *     bank soft-retires it — excluded from recall and consolidation,
 *     archived, reversible server-side — so a corrected belief stops
 *     competing with the stale one in every future recall.
 * - automatic recall: the first step of each turn commits a plugin-sourced
 *   snapshot message into the model context (the same pattern
 *   `time-context` uses for the clock), carrying the bank's active standing
 *   directives in their own section. The recall for it starts AHEAD of the
 *   turn that pays for it: when a turn stops (no live tool calls, no fresh
 *   steering) a detached job runs the recall for that turn's own message —
 *   while the user is reading or typing the next one — and the next turn
 *   consumes the cached result without a bank call. The trade (the same
 *   one the Hermes integration ships as its default): from the second turn
 *   on the snapshot targets the PREVIOUS turn's message — the current
 *   message is already in the model context, and the memory layer is
 *   durable knowledge. The first turn, and any turn whose job failed, take
 *   the original bounded synchronous path (the lookups share one bounded
 *   budget). Subagent sessions are skipped, so a slow or stopped Hindsight
 *   server never blocks a turn.
 *
  *   The snapshot is append-only by default (`recallPreserve: true`): the
 *   plugin never replaces or erases a previous turn's snapshot, so the
 *   model context accumulates one snapshot per distinct turn, while the
 *   durable log keeps every snapshot for replay and audit. An identical
 *   recall re-commits no duplicate block (no churn) — the turn instead
 *   gets a marker row naming the applied memories (one compact line each),
 *   so the UI still shows exactly what memory was applied that turn; an
 *   empty recall leaves the existing snapshots in place.
 *
 *   `recallPreserve: false` instead keeps the surface to the LATEST
 *   snapshot: each new one replaces the previously retained one in place
 *   (the session surface's `replace` op, priced through the shadow-price
 *   `compaction/prune` metering event) while the durable log keeps every
 *   snapshot for replay and audit. A failed replace degrades to the append
 *   path, so the turn never breaks. The naming matches the llama-server
 *   `--no-reasoning-preserve` flag: with it off, the server keeps each
 *   turn's reasoning only for that turn.
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
 * - `apiKeyRef` — optional CREDENTIAL REFERENCE (a POSIX identifier such as
 *   `HINDSIGHT_API_KEY`) instead of the value: the value is resolved per call
 *   through the credentials seam (process env, `$DSH_HOME/.credentials.yaml`,
 *   and `.env` files, most trusted first), so config files never carry the
 *   secret and a rotation needs no restart. Mutually exclusive with `apiKey`.
 * - `autoContext` — default `true`; `false` disables the per-turn recall
 *   (the tool stays available).
 * - `prefetch` — default `true`: the recall starts ahead of the turn that
 *   pays for it, so from the second turn on the snapshot targets the
 *   PREVIOUS message. `false`: no job, every turn waits on the server
 *   (up to `autoContextTimeoutMs`) and the snapshot targets the CURRENT
 *   message — relevant to what you just said, at the cost of bank
 *   latency on every first model call.
 * - `recallContextTurns` — default `5` (the reference Hindsight
 *   integrations ship `1`): the automatic recall's query is the anchor
 *   message (the current one on the synchronous path, the previous
 *   turn's on the prefetch) under a `Prior context:` block of the last
 *   `recallContextTurns - 1` human turns from the durable log (the
 *   anchor's own turn on the prefetch), one `user: …` / `assistant: …`
 *   line per message, capped at 1000 chars with the OLDEST lines
 *   dropping first (the anchor stays whole). `1` restores the
 *   single-message query.
 * - `recallPreserve` — default `true`: the model surface is append-only
 *   for the snapshots — every committed recall stays in the model context.
 *   `false`: the surface carries only the LATEST snapshot — each new one
 *   replaces the previously retained one in place (the session surface's
 *   `replace` op, priced through the shadow-price `compaction/prune`
 *   metering event) while the durable log keeps every snapshot for replay
 *   and audit. Matches the llama-server `--no-reasoning-preserve` naming:
 *   with it off, a turn's snapshot, like its reasoning, lives for that
 *   turn only.
 * - `retainAsync` — default `false` (synchronous: the retain call waits for
 *   the bank to process the memory); `true` acknowledges fast and runs fact
 *   extraction in the background.
 * - `maxRecallTokens` — recall response budget; default `4096`.
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
 * registry and listens on `agent/pre-step`, `agent/turn-stopping`, and
 * `agent/disposed`), so its preset row needs no isolate realm — the same
 * as the preset's other tool rows.
 *
 * Code layout: this file is the entry the loader imports (the Plugin.Object
 * contract: `name`/`inject`/`Config`/`apply`); `src/` holds the modules —
 * `types` (shared shapes), `tiers` (the tag/tier model), `config` (the
 * Standard-Schema validator), `client` (the REST transport), `bank` (the
 * per-mount factory and its operations), `snapshot` (auto-recall surface
 * logic), `tool` (the model-facing tool), `autorecall` (the pre-step
 * consumer + turn-stopping prefetch + disposal cleanup).
 *
 * @module dsh-plugin-hindsight-advanced
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

import { buildAutoRecall } from './src/autorecall.ts'
import { createMount } from './src/bank.ts'
import { Config, type ResolvedConfig } from './src/config.ts'
import { buildTool } from './src/tool.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'hindsight-advanced'

/** Services the plugin requires: tool registration only. */
export const inject = ['tools']

/** The Standard-Schema v1 validator for the row's `config`. */
export { Config }

/**
 * Build the mount's per-operation authorization resolver: a literal
 * `apiKey` is returned as-is; an `apiKeyRef` is resolved per call through
 * the credentials seam (process env, `$DSH_HOME/.credentials.yaml`, and
 * `.env` files, most trusted first) — and, in a composition without the
 * seam, through the launch environment, which is then the whole credential
 * plane. The seam is OPTIONAL on purpose: it is read with `ctx.get`, so the
 * plugin still mounts where no credentials provider is registered.
 * @param ctx - plugin context owning the seam and launch-environment slots.
 * @param config - validated plugin configuration.
 */
function buildResolveApiKey(
  ctx: Context,
  config: ResolvedConfig,
): () => Promise<string | undefined> {
  if (config.apiKeyRef === undefined) {
    return async () => config.apiKey
  }
  const ref = config.apiKeyRef
  return async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    const ambient = launchEnvironmentOf(ctx).get(ref)
    return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
  }
}

/**
 * Register the hindsight tool and the automatic per-turn recall for the
 * lifetime of `ctx`. The bank is fixed by `config` for every session this
 * mount reaches.
 * @param ctx - plugin context; registrations unwind with it.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  /** One mount: the bank's operations and its per-mount state. */
  const mount = createMount(config, buildResolveApiKey(ctx, config))

  // One mount owns all three auto-recall listeners: pre-step consumes the
  // slot, turn-stopping fills it, disposal clears it — the slot map lives
  // in the closure they share. `ctx` is threaded for the recallPreserve
  // shadow price (an untyped `ctx.get('tokenMeter')` at commit time —
  // optional, so a composition without the meter degrades to an unpriced
  // replace).
  const autoRecall = buildAutoRecall(mount, name, ctx)

  ctx.on('agent/pre-step', autoRecall.preStep, { prepend: true })
  ctx.on('agent/turn-stopping', autoRecall.turnStopping)
  ctx.on('agent/disposed', autoRecall.disposed)

  ctx.tools.register(buildTool(mount))
}
