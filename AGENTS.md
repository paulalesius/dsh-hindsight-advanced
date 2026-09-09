# AGENTS.md — developing dsh-plugin-hindsight-advanced

Read this before writing code in this repository. The README is for humans
installing and configuring the plugin; **this file is for agents (and humans)
developing it.**

## What this is

A userland DeepSeek Harness (DSH) profile bundle that mounts Hindsight
long-term memory for a DSH profile: one `hindsight` tool (retain / recall /
reflect / read / invalidate) plus automatic per-turn recall (prefetched in the
background at turn-stop, consumed at the next turn's first step), against
a Hindsight bank. **No DSH
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
6. **The model's context is append-only by default — opt-in replacement
   behind `recallPreserve: false`.** By default the auto-recall snapshot
   is only ever appended — the plugin never replaces or erases a
   previous turn's snapshot. An identical recall re-commits no duplicate
   block (no churn) — the turn instead gets a marker row
   (`renderUnchanged`) naming the applied memories one compact line each,
   so the UI still shows exactly what memory was applied that turn; an
   empty recall leaves existing snapshots in place. `recallPreserve:
   false` (the naming mirrors llama-server's `--no-reasoning-preserve`)
   keeps the surface to the LATEST full snapshot with an in-place
   record of every earlier recall turn: each new snapshot retires the
   previously retained full card via a `surfaceOp` replace that installs
   a TOMBSTONE (`renderTombstone`) in the old slot — a tiny
   `form: 'notice'` one-line marker the UI renders as a collapsed row,
   so every past recall turn keeps a visible marker WHERE it recalled —
   shadow-priced by a log-only `compaction/prune` appended immediately
   before (its `shadowedTokenCount` is the old card's full price from
   the optional `tokenMeter` service — absent meter means no price, a
   safe overcount; the fold then prices the replace as the tiny
   tombstone minus the shadowed range). The FULL new snapshot then
   rides the pre-step decision, which the loop appends as a fresh card
   after the triggering message. The durable log keeps every full
   snapshot (tombstones never count as snapshots — `form: 'notice'`);
   an unchanged recall is a pure no-op (no marker, no retire); a
   refused retirement degrades to the append path (old card stays, new
   full card rides the decision) so a turn never breaks. The in-place
   part is the only rewrite the plugin performs, it is the default-off
   behavior the operator opts into, and the fresh full card never
   commits directly (the loop hardcodes `append` on the decision,
   which is exactly where the card wants to land).
7. **The tool description IS the retention policy.** WHAT and WHEN the model
   stores is decided by the description text in `src/tool.ts` (durable
   facts, preferences, decisions + rationale; never ephemera or raw code).
   Changing that text is a behavior change — say so in the commit message.
   The second "what to retain" policy is server-side (`bankConfig` /
   `retain_mission`), which tells the *server* what to extract.
8. **KV cache is a first-class concern.** Automatic recall runs once per
   turn (the first step only), is bounded, and subagent sessions are
   skipped — so a memory server's latency or outage is never paid in the
   agent loop, and stable prefixes are not invalidated per step. The
   lookup itself is started ahead of the turn that pays for it: the
   `agent/turn-stopping` listener fires a detached recall job (never
   awaited — that event is serial and awaited at the boundary) that runs
   in the user's think time, and the next first step consumes the cached
   result. From the second turn on the snapshot therefore targets the
   PREVIOUS turn's message (the same trade the Hermes integration ships as
   its default); the first turn, and any turn whose job failed or was not
   ready in time, take the original bounded synchronous path. The `prefetch`
   config key (default `true`) gates the job: `false` disables it, so
   every turn queries the CURRENT message on the synchronous path —
   relevance to what you just said, at the cost of bank latency on the
   first model call. The query is not just that one message: the
   `recallContextTurns` key (default `5`; the reference Hindsight
   integrations ship `1`) composes the anchor with the recent prior
   turns' lines (one `user: …` / `assistant: …` line per message) under
   a `Prior context:` header, capped at 1000 chars with the oldest lines
   dropping first — the anchor's own line is never context (it is the
   tail), which on the prefetch means its assistant replies ARE.
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
| `hindsight-advanced.ts` | the entry: the loader's whole contract (`name`/`inject`/`Config`/`apply`); `apply` builds one mount and registers the tool + the three auto-recall listeners (pre-step, turn-stopping, disposed) |
| `src/types.ts` | shared shapes (`RecallHit`, `RecallOptions`) |
| `src/tiers.ts` | the visibility-tier (tag) model: `MEMORY_SCOPES`, `sessionTierId`, `scopeTags`, `recallTags` |
| `src/config.ts` | `ResolvedConfig` + the hand-rolled Standard-Schema v1 `Config` validator |
| `src/client.ts` | the REST transport: one bounded call, one clean bounded error shape |
| `src/bank.ts` | `createMount`: the per-mount factory (owns the lazy bank-config sync) and the `retain`/`recall`/`reflect`/`read`/`invalidate`/`listDirectives`/`retainDirective` operations — **the extension point for new Hindsight operations** |
| `src/snapshot.ts` | auto-recall surface logic: query derivation (from the step's messages, and from the session's durable log for the turn-stop prefetch — human `user/message` events only, so plugin snapshots are never queries) + the multi-turn composition (`composeRecallQuery`: the anchor under a `Prior context:` block of the last `recallContextTurns` prior human turns, one line per message, capped with oldest-first truncation), hit + standing-rules rendering (curatable hits carry their ids; an observation hit carries NO id of its own — it is derived and the bank refuses to curate it, so its id would render as the handle for exactly the call that 400s — with its source facts under it on `from:` lines — ids ONLY, no fact text (the consolidated observation supersedes its sources, so re-rendering their text would only duplicate the recall context), each the only curatable handle), the unchanged-recall marker (the applied memories, one compact line each), and the retained-snapshot lookup (an unchanged recall commits the marker instead of a duplicate block) |
| `src/tool.ts` | the model-facing `hindsight` tool (the description IS the retention policy) |
| `src/autorecall.ts` | the auto-recall listeners: the `agent/turn-stopping` prefetch (detached recall job — at most one live slot per session, hard 120 s TTL mirroring the Hermes op timeout), the `agent/pre-step` consumer (cached result if ready, else the original bounded synchronous lookup) + surface commit, and `agent/disposed` cleanup |
| `package.json` | the package manifest; `dsh.bundle: { patch: "./cordis.patch.yml" }` makes this a profile bundle |
| `cordis.patch.yml` | the bundle's patch layer — the host-plane mounting row (`id: hindsight`, **shipped `disabled: true`**) and its `config` (the README documents the keys) |
| `test/stub-server.mjs`, `test/test.mjs` | dependency-free smoke suite (stub Hindsight server, 48 checks, eleven mounts — the fifth covers the visibility tiers, the sixth the standing directives, the seventh the recall provenance, the eighth memory invalidation plus the `read` action: read resolves an id to its text and type (a fact: its own line; an observation: its backing facts WITH their text — unlike recall's ids-only from line; an unknown id: the same bounded 404), and derived-observation curation: the observation renders no id of its own, invalidating one (an id the model can still hold from an earlier snapshot) is refused by the bank and surfaced as an actionable pointer to the backing fact, and only the backing fact on the `from:` line is curatable, the ninth the turn-stop prefetch: cached consumption without a bank call, the job querying the turn's own human message, an unchanged recall committing the marker row, too-slow discard, failed-job fallback, subagent skip, the `prefetch: false` gate, disposal cleanup, the tenth the multi-turn query: the anchor under a `Prior context:` block on both paths (the sync anchor not on the log yet; the prefetch anchor's own line dropped, its reply kept), oldest-first truncation at the cap, `recallContextTurns: 1` as the single-message query, the eleventh `recallPreserve: false`: the first snapshot a plain append committed directly (on the surface before the triggering message, never riding the decision), a new snapshot retiring the previous full card in place — a `form: 'notice'` tombstone marker in the old slot, shadow-priced by the adjacent log-only `compaction/prune` (old card's full price), while the full new card lands fresh after the triggering message on the decision (the durable log keeping both full snapshots) — an unchanged recall committing nothing, a refused retirement degrading to the append path with the orphaned price harmless) |
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

# the stub suite (48 checks)
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
- Snapshots are append-only UNLESS the operator sets `recallPreserve:
  false` — then the surface carries only the latest FULL snapshot: each
  new one retires the previous full card in place (a `form: 'notice'`
  tombstone in the old slot, shadow-priced by an adjacent log-only
  `compaction/prune`) and lands fresh at its own turn on the decision,
  and the durable log still keeps every full snapshot (tombstones never
  count as snapshots).
- Subagent auto-recall stays skipped, and a subagent's `session` tier leans
  at the parent that delegated its task.
- The bank-config sync is a lazy one-time `PATCH` that rides the next
  operation's signal and never blocks or fails it.
- The shipped bundle row stays `disabled: true` — activation is always the
  user's declarative act, and never host row + preset row at once.
