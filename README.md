# dsh-plugin-hindsight

Hindsight long-term memory for a DeepSeek Harness (dsh) profile — **userland
only: no DSH source modifications**. The package is a profile **bundle**
(`package.json` declares `dsh.bundle: { patch: "./cordis.patch.yml" }`): one
bare-path `dsh plugin add` mounts it into the profile's layer stack, and the
bundled row gives every web-profile session a `hindsight` tool (retain /
recall / reflect) and automatic per-turn recall against the configured bank.

Reference deployment on this machine: web profile, bank `dsh`, Hindsight
server at `http://127.0.0.1:9177` — the config lives in
`cordis.patch.yml` (the row's `config` block; the table below documents it).

Inside a bank, memories live in three visibility tiers — `global`, `preset`,
and `session` (the plugin's tag model; the model picks a tier with `retain`'s
`scope` parameter, never seeing raw tags). A recall sees the session's own
tier, its preset's tier, and the global tier — never another session's or
preset's tier. Separate banks (separate mounts) remain the outer isolation
boundary for separate memory surfaces.

## Scope: host-plane (the bundle), or per-preset (a preset row)

**The install is inert** — the bundle row ships `disabled: true`. Opting in
is the user's declarative act, and it picks one of two scopes (never both —
see **Enable and configure**):

- **host-plane** — the user's profile patch layer enables the bundle row
  (`disabled: false`): active in every web-profile session, one bank for
  all of them.
- **per-preset** — a row in a preset's own `agent.cordis.yml`: active only
  in that preset's sessions, with its own `config` block, so "bank `hermes`
  for standard, `dsh-code` for code" is two preset rows. Presets without
  the row are mount-less: no tool, no auto-recall.

The preset row uses the bare `name: dsh-plugin-hindsight` — the preset
mount re-anchors bare specifiers to the host composition, so the profile's
`node_modules` copy resolves. The plugin never reads the session's preset;
isolation is separate banks either way.

## Layout

| file | role |
| --- | --- |
| `hindsight.ts` | the whole plugin (one dependency-light ESM module; the imports of `@deepseek-ai/cordis`, `dsh-agent`, `dsh-session` are type-only and erased at load; runtime imports are `createUserMessage` from `@deepseek-ai/dsh-llm` and `defineTool` from `@deepseek-ai/dsh-tools`) |
| `package.json` | the package manifest; `dsh.bundle: { patch: "./cordis.patch.yml" }` makes this a profile bundle (the install step below) |
| `cordis.patch.yml` | the bundle's patch layer — the host-plane mounting row (`id: hindsight`, **shipped `disabled: true`**) and its `config` (the reference below) |
| `test/stub-server.mjs`, `test/test.mjs` | dependency-free smoke suite (stub Hindsight server, 26 checks, five mounts — the fifth covers the visibility tiers) |
| `test/live.mjs` | live round-trip against a real Hindsight server on a scratch bank (self-cleaning) |
| `test/register.mjs`, `test/hooks.mjs` | tsx loader bootstrap so `node` can import the `.ts` plugin in tests |

## Install (web profile)

Prereqs: a running Hindsight server (`hindsight-api`, REST at
`/v1/default/banks/{bank}/memories…`).

The install is one command — the package is a profile **bundle**, so `dsh
plugin add` links the source into the profile's `node_modules`, records the
dependency, and the CLI reconciles `dsh.profile.bundles` against installed
state and joins this package's `cordis.patch.yml` into the profile's layer
stack. **The install is inert**: the bundle row ships `disabled: true`.
Opt-in is deliberate and per user — either a row in one preset's
`agent.cordis.yml` (that preset's bank) or `disabled: false` in the user's
profile patch layer (every preset); see **Enable and configure** below.

Use a **bare path, not `file:`** — a bare path is a pnpm symlink (edits need
no reinstall); `file:` copies into the pnpm store.

```bash
# from the DSH checkout (tsx + apps/cli live there)
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add /path/to/deepseek-harness/dsh-plugins/hindsight
```

(`dsh plugin …` when the binary is on PATH.)

Then restart `dsh web` once — the bundle layer joins the boot (still inert:
the row is disabled until you enable it, see **Enable and configure**). The
module's own runtime imports (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`)
resolve by Node's upward `node_modules` walk **from the plugin file's
location**: the source directory carries a `node_modules` symlink to the DSH
checkout's `apps/cli/node_modules`, and the bare name also resolves from the
profile directory once linked.

Day-to-day (symlink install):

- edits to `hindsight.ts` → restart `dsh web` (the node half loads at session start)
- config changes → edit `cordis.patch.yml` in place, restart
- uninstall → `dsh plugin --profile web remove dsh-plugin-hindsight` (the
  bundle entry is dropped automatically) + restart

## Enable and configure (per user, declarative)

The install ships inert; activation is one id-targeted entry in **your**
config — never an edit to the plugin source. Both scopes work with the same
mechanics: an id-targeted patch composes **after** every bundle layer
(`applyEntryPatches`, `@deepseek-ai/cordis-plugin-include`) and the loader
honors row-level `disabled` by never activating the entry.

**Option A — every preset (host-plane).** Enable the bundle row in
`~/.dsh/profiles/web/cordis.patch.yml` (append to your existing layer):

```yaml
- id: hindsight
  disabled: false
  config:
    bank: my-bank                     # REQUIRED — the only key with no default
    baseUrl: http://127.0.0.1:9177    # repeat: not a code default (default 8888)
    apiKey: local-key                 # repeat: no code default
    bankConfig:
      retain_mission: "…what to retain…"
```

**Option B — one preset (per-preset).** Append the preset's own mount to
that preset's `agent.cordis.yml` (e.g. `~/.dsh/.agent-presets/custom/agent.cordis.yml`),
leaving the bundle row disabled:

```yaml
- id: hindsight
  name: dsh-plugin-hindsight
  config:
    bank: my-bank
    baseUrl: http://127.0.0.1:9177
    apiKey: local-key
    bankConfig:
      retain_mission: "…what to retain…"
```

Both options: an id-targeted `config` **replaces the whole block** —
`applyEntryPatches` assigns entry keys, it does not deep-merge
(`target[key] = value`). List every key the plugin needs; keys you omit
fall back to the code defaults in the reference below (so `bank` is the
only strictly required key, and `baseUrl`/`apiKey` are worth repeating
because their code defaults are `:8888`/none). `- id: hindsight` with
`disabled: true` turns a live mount back off. Restart `dsh web` afterwards.

**Never combine the two options.** A preset row is not an override of the
bundle row — presets are separate composition trees that cannot see host
rows — it is a *second mount*: the tools themselves shadow cleanly (scoped
registration wins over the host one), but each mount registers its own
per-step auto-recall listener, so both mounts recall and their `latestOnly`
shadow-replaces clobber each other's snapshot.

## Configuration reference (the row's `config`)

| key | default | meaning |
| --- | --- | --- |
| `bank` | — | REQUIRED. Hindsight bank id (case-sensitive; the server auto-creates a bank on first use) |
| `baseUrl` | `http://127.0.0.1:8888` | Hindsight REST base |
| `apiKey` | — | optional; `Authorization: Bearer <key>` on every call |
| `autoContext` | `true` | `false` disables the per-turn automatic recall (the tool stays) |
| `latestOnly` | `true` | the model sees only the LATEST automatic snapshot: each new one shadows the previous one on the session surface (the preserve-thinking pattern), so memory adds one message to the context instead of one per turn; `false` restores the cumulative per-turn appends |
| `retainAsync` | `false` | synchronous by default: the retain call waits for the bank to process the memory; `true` acknowledges fast and runs fact extraction in the background |
| `maxRecallTokens` | `1024` | recall response token budget |
| `autoContextTimeoutMs` | `2500` | bound for the automatic lookup |
| `retainScope` | `preset` | the visibility tier `retain` uses when the model omits the `scope` parameter: `global` (every session of the bank), `preset` (this agent preset's sessions), `session` (this session only) |
| `bankConfig` | — | optional; a flat object of Hindsight per-bank config overrides — the **server-side extraction policy** (e.g. `retain_mission`, the "what to retain" instruction injected into the bank's fact-extraction prompt); applied once before the first memory operation, see Behavior |

## Behavior

- **retain** — the model decides what is durable from the tool description
  (stable facts, preferences, decisions + rationale; never ephemera or raw
  code). Stored **synchronously by default**: the call waits for the bank to
  process the memory, so the very next recall (including the next turn's
  automatic recall) already sees it. `retainAsync: true` instead
  acknowledges fast and runs fact extraction in the background. The memory's
  visibility tier is the `scope` parameter, defaulting to `retainScope`
  (default `preset`).
- **visibility tiers** — the plugin tags every stored memory with at most
  ONE tier's tag (the item's tag set is its scope): `global` stores no tags
  at all (the bank's global scope, visible to every session), `preset` tags
  `preset:<id>` (the session's agent preset; `preset:none` when the session
  has no preset), `session` tags `session:<id>` (visible to that session
  only, including its resume — the id survives resume). Every recall — the
  tool action and the automatic per-turn one — sends
  `[session:<own id>, preset:<own preset>]` under the server's `any`
  matching, which selects exactly the session's own tier, its preset's
  tier, and every untagged memory — never a memory tagged for another
  session or another preset. `reflect` carries the same filter. Banks
  remain the outer isolation boundary.
- **bank config** (`bankConfig`) — there are two "what to retain" policies:
  the tool description tells the *model* what to write, and `bankConfig` tells
  the *server* what to extract from what it receives. `retain_mission` is
  injected into every extraction as a per-request "FOCUS" preamble that takes
  priority over the general guidelines; `retain_extraction_mode` switches the
  extraction prompt (`concise` by default, or `verbose`, `custom`, `verbatim`,
  `chunks`); `retain_custom_instructions` replaces the base prompt entirely
  when the mode is `custom`. The plugin applies the declared overrides with a
  one-time `PATCH /v1/default/banks/{bank}/config` before the first memory
  operation of the mount (the bank is durable server state, so it is not
  re-sent), riding that operation's own signal and never blocking it; a failed
  apply is retried from the next operation. The server's bank-config API is
  gated by `HINDSIGHT_API_ENABLE_BANK_CONFIG_API` (on by default) — with it
  off the PATCH fails and is swallowed, so memory works without the overrides.
- **automatic recall** — on the first step of each turn the latest user
  message is queried and the hits become a plugin-sourced snapshot message
  for that step (the `time-context` clock pattern). With `latestOnly` (the
  default) exactly one snapshot is ever visible to the model: each new one
  is committed to the session surface by shadowing the previous one (the
  same surface-replace mechanism compaction uses), so the durable log keeps
  every snapshot for replay and audit while the context carries only the
  latest recall — the `preserve-thinking` pattern. An empty recall leaves
  the last snapshot in place; an unchanged one is not re-committed.
  `latestOnly: false` restores the cumulative behavior (one appended
  message per turn). Bounded by `autoContextTimeoutMs`; subagent sessions
  are skipped (their task context is owned by the delegating prompt); a
  stopped or slow server never blocks a turn.
- **subagents** — inherit the parent preset's composition (including this
  mount and its bank); their manual `hindsight` calls work, their
  auto-recall is skipped. A subagent's `session` tier leans at the PARENT
  that delegated its task (its own id is short-lived and would orphan its
  memories), so a subagent's session-tier retains are visible to the parent.
- **degraded** — server unreachable: tool calls surface a clean error; the
  automatic recall passes the turn through untouched.

## Uninstall

`dsh plugin --profile web remove dsh-plugin-hindsight` (the bundle entry is
dropped automatically) + restart `dsh web`. For a per-preset row instead:
remove that row from the preset's `agent.cordis.yml`; new sessions on that
preset lose the tool. Either way your banks and memories are untouched (they
live in the Hindsight server).

## Tests

```bash
cd test
node --import ./register.mjs test.mjs     # stub server, 26 checks
node --import ./register.mjs live.mjs     # real server, scratch bank, self-cleaning
```

`live.mjs` talks to `http://127.0.0.1:9177` (key `local-key` on the
reference deployment) and never touches the real `hermes` bank.
