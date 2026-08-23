# dsh-plugin-hindsight-advanced

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

A bank can also hold **standing directives** — behavioral rules ("always X",
"never do Y") stored with `retain` + `kind: 'directive'` (+ a short `name`).
Directives are *applied, not recalled*: they carry the same tier tags as
memories, are listed (tier-scoped) on the first step of each turn, and are
rendered in their own "Standing rules" section of the per-turn snapshot — so
a stored rule reaches the model every turn even when the recall matches
nothing. `reflect` calls apply matching directives server-side as well.

<p align="center"><img src="./misc/banner.jpg" alt="dsh-plugin-hindsight-advanced banner"/></p>

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

The preset row uses the bare `name: dsh-plugin-hindsight-advanced` — the preset
mount re-anchors bare specifiers to the host composition, so the profile's
`node_modules` copy resolves. The plugin never reads the session's preset;
isolation is separate banks either way.

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

- edits to the plugin source (the entry or `src/`) → restart `dsh web` (the node half loads at session start)
- config changes → edit `cordis.patch.yml` in place, restart
- uninstall → `dsh plugin --profile web remove dsh-plugin-hindsight-advanced` (the
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
    apiKeyRef: HINDSIGHT_API_KEY      # repeat: no code default (a REF, not the key)
    bankConfig:
      retain_mission: "…what to retain…"
```

**Option B — one preset (per-preset).** Append the preset's own mount to
that preset's `agent.cordis.yml` (e.g. `~/.dsh/.agent-presets/custom/agent.cordis.yml`),
leaving the bundle row disabled:

```yaml
- id: hindsight
  name: dsh-plugin-hindsight-advanced
  config:
    bank: my-bank
    baseUrl: http://127.0.0.1:9177
    apiKeyRef: HINDSIGHT_API_KEY
    bankConfig:
      retain_mission: "…what to retain…"
```

Both options: an id-targeted `config` **replaces the whole block** —
`applyEntryPatches` assigns entry keys, it does not deep-merge
(`target[key] = value`). List every key the plugin needs; keys you omit
fall back to the code defaults in the reference below (so `bank` is the
only strictly required key, and `baseUrl`/`apiKeyRef` are worth repeating
because their code defaults are `:8888`/none). `- id: hindsight` with
`disabled: true` turns a live mount back off. Restart `dsh web` afterwards.

**Never combine the two options.** A preset row is not an override of the
bundle row — presets are separate composition trees that cannot see host
rows — it is a *second mount*: the tools themselves shadow cleanly (scoped
registration wins over the host one), but each mount registers its own
per-step auto-recall listener, so both mounts run their recall and each
appends its own snapshot to the same session surface.

## Configuration reference (the row's `config`)

| key | default | meaning |
| --- | --- | --- |
| `bank` | — | REQUIRED. Hindsight bank id (case-sensitive; the server auto-creates a bank on first use) |
| `baseUrl` | `http://127.0.0.1:8888` | Hindsight REST base |
| `apiKey` | — | optional literal key; `Authorization: Bearer <key>` on every call. Mutually exclusive with `apiKeyRef` — prefer the ref |
| `apiKeyRef` | — | optional CREDENTIAL REFERENCE (a POSIX identifier such as `HINDSIGHT_API_KEY`); the value is resolved per call through the credentials seam — process env, `~/.dsh/.credentials.yaml` (`refs:` section), and `.env` files, most trusted first — so the secret never appears in config files and a rotation needs no restart |
| `autoContext` | `true` | `false` disables the per-turn automatic recall (the tool stays) |
| `retainAsync` | `false` | synchronous by default: the retain call waits for the bank to process the memory; `true` acknowledges fast and runs fact extraction in the background |
| `maxRecallTokens` | `1024` | recall response token budget |
| `autoContextTimeoutMs` | `2500` | bound for the automatic lookup |
| `retainScope` | `preset` | the visibility tier `retain` uses when the model omits the `scope` parameter: `global` (every session of the bank), `preset` (this agent preset's sessions), `session` (this session only) |
| `bankConfig` | — | optional; a flat object of Hindsight per-bank config overrides — the **server-side extraction policy** (e.g. `retain_mission`, the "what to retain" instruction injected into the bank's fact-extraction prompt); applied once before the first memory operation, see Behavior |

### Adding the key

`apiKeyRef` is only a name — the value is resolved on every call, most
trusted first: the process environment, then
`~/.dsh/.credentials.yaml` (the `refs:` section, a 0600 store), then the
project and user `.env` files. The usual way is to add one line to
`~/.dsh/.credentials.yaml` — **alongside any existing refs** (e.g. the LLM
provider's `DEFAULT_API_KEY`), never replacing them:

```yaml
version: 1
refs:
  DEFAULT_API_KEY: <your existing LLM key — leave it alone>
  HINDSIGHT_API_KEY: <the Hindsight server's Bearer token>
```

(Alternatively, export `HINDSIGHT_API_KEY` in the environment that starts
`dsh web`, or put it in a `.env` file.) Because resolution is per call,
editing the store — or rotating the token in place — takes effect on the
next operation: no restart, no config edit. And the secret itself appears
nowhere in a file that gets committed or shipped; the preset row and this
plugin's `cordis.patch.yml` carry only the reference name.

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
  for that step (the `time-context` clock pattern). The snapshot is only
  ever APPENDED to the session surface — the plugin never replaces or
  erases a previous turn's snapshot — so the model context accumulates one
  snapshot per distinct turn, and the durable log keeps every snapshot for
  replay and audit. An empty recall leaves the existing snapshots in
  place; an unchanged one is not re-committed (no churn). Bounded by
  `autoContextTimeoutMs`; subagent sessions
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

`dsh plugin --profile web remove dsh-plugin-hindsight-advanced` (the bundle entry is
dropped automatically) + restart `dsh web`. For a per-preset row instead:
remove that row from the preset's `agent.cordis.yml`; new sessions on that
preset lose the tool. Either way your banks and memories are untouched (they
live in the Hindsight server).

## Tests

```bash
cd test
node --import ./register.mjs test.mjs     # stub server, 28 checks
node --import ./register.mjs live.mjs     # real server, scratch bank, self-cleaning
```

`live.mjs` talks to `http://127.0.0.1:9177` and never touches the real
`hermes` bank. It reads the key from the `HINDSIGHT_API_KEY` environment
variable (the same name its `apiKeyRef` config resolves) and exits with a
message if it is not set: `HINDSIGHT_API_KEY=… node --import ./register.mjs live.mjs`.
