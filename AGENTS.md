# AGENTS.md — developing dsh-plugin-hindsight-advanced

Read this before writing code in this repository. The README is for humans
installing and configuring the plugin; **this file is for agents (and humans)
developing it.**

## What this is

A userland DeepSeek Harness (DSH) profile bundle that mounts Hindsight
long-term memory for a DSH profile: one `hindsight` tool (retain / recall /
reflect) plus automatic per-turn recall, against a Hindsight bank. **No DSH
source modifications, ever** — the whole surface is one entry file plus a
small tree of dependency-light ESM TypeScript modules in `src/`, resolved
from the DSH checkout through the `node_modules` symlink in this directory.

## The design decisions the code embodies

This plugin was designed before it was coded ("describe the design approach
first, without coding anything"). These are the decisions that shape the
tree — preserve them when you change anything:

1. **Design first, code second.** A change that touches architecture (a new
   listener, a new mount surface, a new kind of state) gets a short design
   written down first — in the PR/commit description — not discovered in
   code review.
2. **One simple package, no preemptive splitting.** DSH's own guidance: a
   simple tool plugin is not a three-role capability split. The *behavioral*
   split (transport / operations / tool / auto-recall) is file-level within
   one plugin; do not extract new packages or services.
3. **Isolation is by scope, not by separate banks.** The original Aug 17
   requirement was "apply differently to different presets" (a `hermes`
   bank for the standard preset, a separate bank per project for code
   work). That design was **changed later, before the first commit
   landed**: differentiation is the three visibility scopes inside one
   bank — `global` (every session of the bank), `preset` (the agent
   preset's sessions), and `session` (one session alone). Each memory is
   tagged with exactly one scope's tags (`src/tiers.ts`), and a recall
   always sees only the session's own scope, its preset's, and the
   global one. A bank remains the outer boundary for genuinely separate
   memory surfaces — it is no longer the unit of per-preset or
   per-project separation.
4. **Thin client.** `src/client.ts` is a thin wrapper over the REST API:
   one bounded call, one clean bounded error shape. All Hindsight API
   knowledge lives in the client and the mount operations; the tool and the
   listener never touch HTTP.
5. **Best-effort, failure-isolated (the spill pattern).** A stopped, slow,
   or failing Hindsight server must never block a turn or break a session:
   every automatic lookup is bounded by `autoContextTimeoutMs`, every tool
   failure degrades to a clean error, and retention/lookup errors are
   contained, logged, and never propagated into the agent loop.
6. **The model's context is an append-only surface.** The auto-recall
   snapshot is only ever appended — the plugin never replaces or erases a
   previous turn's snapshot. An identical recall is not re-committed (no
   churn); an empty recall leaves existing snapshots in place. Rewriting
   earlier turns (tombstones / `latestOnly`) was tried and rejected — do
   not resurrect it.
7. **The tool description IS the retention policy.** WHAT and WHEN the model
   stores is decided by the description text in `src/tool.ts` (durable
   facts, preferences, decisions + rationale; never ephemera or raw code).
   Changing that text is a behavior change — say so in the commit message.
   The second "what to retain" policy is server-side (`bankConfig` /
   `retain_mission`), which tells the *server* what to extract.
8. **KV cache is a first-class concern.** Automatic recall runs once per
   turn (the first step only), is bounded, and subagent sessions are
   skipped — so a memory server's latency or outage is never paid in the
   agent loop, and stable prefixes are not invalidated per step.
9. **Secrets are references, never values.** The row carries
   `apiKeyRef` (a POSIX identifier), resolved **per call** through the
   credentials seam (env → `~/.dsh/.credentials.yaml` → `.env`, most
   trusted first) with a launch-environment fallback. The plugin reads the
   seam with an **untyped** `ctx.get('credentials')` and the seam is
   optional — never `import '@deepseek-ai/dsh-credentials'` from this
   package (it is not a declared dependency and must stay unimportable),
   and no literal key ever appears in a committed file.
10. **Test bar: mock only the external service.** The suite runs a stub
    Hindsight server (dependency-free, no framework) for the deterministic
    checks, plus a live round-trip against a real server on a **scratch
    bank** (self-cleaning, never touches the real banks). New behavior gets
    a check in `test/test.mjs`; wiring against the real API gets a live
    check.

## Layout

| file | role |
| --- | --- |
| `hindsight-advanced.ts` | the entry: the loader's whole contract (`name`/`inject`/`Config`/`apply`); `apply` builds one mount and registers the tool + pre-step listener |
| `src/types.ts` | shared shapes (`RecallHit`, `RecallOptions`) |
| `src/tiers.ts` | the visibility-tier (tag) model: `MEMORY_SCOPES`, `sessionTierId`, `scopeTags`, `recallTags` |
| `src/config.ts` | `ResolvedConfig` + the hand-rolled Standard-Schema v1 `Config` validator |
| `src/client.ts` | the REST transport: one bounded call, one clean bounded error shape |
| `src/bank.ts` | `createMount`: the per-mount factory (owns the lazy bank-config sync) and the `retain`/`recall`/`reflect`/`listDirectives`/`retainDirective` operations — **the extension point for new Hindsight operations** |
| `src/snapshot.ts` | auto-recall surface logic: query derivation, hit + standing-rules rendering (hits carry their ids; observation hits carry their source facts as `from:` lines), identical-recall snapshot lookup |
| `src/tool.ts` | the model-facing `hindsight` tool (the description IS the retention policy) |
| `src/autorecall.ts` | the `agent/pre-step` listener (bounded lookup + surface commit) |
| `package.json` | the package manifest; `dsh.bundle: { patch: "./cordis.patch.yml" }` makes this a profile bundle |
| `cordis.patch.yml` | the bundle's patch layer — the host-plane mounting row (`id: hindsight`, **shipped `disabled: true`**) and its `config` (the README documents the keys) |
| `test/stub-server.mjs`, `test/test.mjs` | dependency-free smoke suite (stub Hindsight server, 32 checks, seven mounts — the fifth covers the visibility tiers, the sixth the standing directives, the seventh the recall provenance) |
| `test/live.mjs` | live round-trip against a real Hindsight server on a scratch bank (self-cleaning) |
| `test/register.mjs`, `test/hooks.mjs` | tsx loader bootstrap so `node` can import the `.ts` plugin in tests |
| `misc/banner.jpg` | the README banner |

## The development loop

All commands run from the repo root (the plugin directory) unless noted:

```bash
# type-check (strict; tsc is resolved through the machine-local
# node_modules symlink into the DSH checkout — no absolute path here)
TSC="$(cd "$(realpath node_modules)/../../.." && pwd)/node_modules/.bin/tsc"
"$TSC" --noEmit --strict \
  --noUnusedLocals --noUnusedParameters --noFallthroughCasesInSwitch \
  --module nodenext --target es2023 --allowImportingTsExtensions \
  --skipLibCheck hindsight-advanced.ts

# the stub suite (32 checks)
cd test && node --import ./register.mjs test.mjs

# preset-mount verification (the custom agent preset row)
node test/verify-preset.mjs

# live round-trip (real server, scratch bank; the key from the env, same
# name its apiKeyRef resolves)
HINDSIGHT_API_KEY=<key> node --import ./register.mjs live.mjs
```

- `node_modules` here is a **machine-local symlink** into the DSH
  checkout's `apps/cli/node_modules` — it is gitignored, not part of the
  repo. A fresh checkout recreates it once
  (`ln -s <dsh-checkout>/apps/cli/node_modules node_modules`) and then do
  not `npm install` in this repo and do not add runtime dependencies
  without first deleting an equivalent amount of code.
- Edits to the entry or `src/` take effect after a `dsh web` restart (the
  node half loads at session start); config edits to `cordis.patch.yml`
  likewise.
- Commit messages are written by the maintainer as quoted-heredoc paste
  blocks (`git commit -m "$(cat <<'EOF' …)"`) — match the repo's log style
  (`feat(hindsight): …`, `refactor: …`, `docs: …`).

## Extending the plugin (scalability paths)

- **New Hindsight operation** (e.g. `list`, `stats`, entities): add the
  transport method in `src/client.ts`, the operation in `src/bank.ts`
  (the designated extension point), and — only if model-facing — an action
  in `src/tool.ts` plus description text. Keep the operation bounded and
  failure-isolated per the design decisions above.
- **New isolation need** (e.g. separate memory for a project or a preset):
  use the scope model, not a new bank — `retain`'s `scope` parameter and
  `retainScope` already give global / preset / session separation inside
  one bank. A genuinely separate memory surface (or a different Hindsight
  server) is a new mount row with its own `config` block; the plugin
  stays preset-agnostic either way.
- **New config key**: `src/config.ts` (the hand-rolled Standard-Schema v1
  validator), the entry file's doc comment, `cordis.patch.yml` (the
  reference block), and the README's configuration table — all four.
- **New visibility rule**: `src/tiers.ts` owns the tag model. The model
  never sees tags; a rule change is a behavior change with the same test
  weight as a tier (mount five in the stub suite exists for it).

## Invariants (do not break)

- The entry file is the loader contract; `inject` stays `['tools']` — the
  plugin provides no service of its own and its rows need no isolate realm.
- The bare `hindsight` name is kept for the **tool name**, the error
  prefixes, and the preset row `id`; the package/plugin is
  `dsh-plugin-hindsight-advanced` (the bare name stays reserved).
- Snapshots are append-only; no turn rewriting.
- Subagent auto-recall stays skipped, and a subagent's `session` tier leans
  at the parent that delegated its task.
- The bank-config sync is a lazy one-time `PATCH` that rides the next
  operation's signal and never blocks or fails it.
- The shipped bundle row stays `disabled: true` — activation is always the
  user's declarative act, and never host row + preset row at once.
