## Layout

| file | role |
| --- | --- |
| `hindsight-advanced.ts` | the entry: the loader's whole contract (`name`/`inject`/`Config`/`apply`); `apply` builds one mount and registers the tool + pre-step listener |
| `src/types.ts` | shared shapes (`RecallHit`, `RecallOptions`) |
| `src/tiers.ts` | the visibility-tier (tag) model: `MEMORY_SCOPES`, `sessionTierId`, `scopeTags`, `recallTags` |
| `src/config.ts` | `ResolvedConfig` + the hand-rolled Standard-Schema v1 `Config` validator |
| `src/client.ts` | the REST transport: one bounded call, one clean bounded error shape |
| `src/bank.ts` | `createMount`: the per-mount factory (owns the lazy bank-config sync) and the `retain`/`recall`/`reflect`/`listDirectives`/`retainDirective` operations — the extension point for new Hindsight operations |
| `src/snapshot.ts` | auto-recall surface logic: query derivation, hit + standing-rules rendering, identical-recall snapshot lookup |
| `src/tool.ts` | the model-facing `hindsight` tool (the description IS the retention policy) |
| `src/autorecall.ts` | the `agent/pre-step` listener (bounded lookup + surface commit) |
| `package.json` | the package manifest; `dsh.bundle: { patch: "./cordis.patch.yml" }` makes this a profile bundle (the install step below) |
| `cordis.patch.yml` | the bundle's patch layer — the host-plane mounting row (`id: hindsight`, **shipped `disabled: true`**) and its `config` (the reference below) |
| `test/stub-server.mjs`, `test/test.mjs` | dependency-free smoke suite (stub Hindsight server, 28 checks, six mounts — the fifth covers the visibility tiers, the sixth the standing directives) |
| `test/live.mjs` | live round-trip against a real Hindsight server on a scratch bank (self-cleaning) |
| `test/register.mjs`, `test/hooks.mjs` | tsx loader bootstrap so `node` can import the `.ts` plugin in tests |
