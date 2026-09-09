// Live round-trip against the real Hindsight server, driven through the
// workspace package (the deployable file), with the production config shape:
// a single mount routing to a scratch bank. Also verifies the visibility
// tiers against the REAL server: retain tier tags (preset default, session
// tier), a server-side tag read-back via /memories/list, the recall tier
// filter (own + preset tiers visible, a sibling session's tier not), read
// (a rendered id resolves to its text and type via GET /memories/{id}),
// invalidation (the soft PATCH retires a memory and it leaves the recall
// surface), and observation curation (an observation hit renders no id of
// its own; the from: line's id — the backing fact — is the one curatable
// handle).
//
// Uses a scratch bank (auto-created by the server) and deletes it at the end,
// so the user's real banks are never touched.
//
//   HINDSIGHT_API_KEY=… node --import ./register.mjs live.mjs
import assert from 'node:assert/strict'

const BASE = 'http://127.0.0.1:9177'
// The key never lives in this file: the plugin mounts with the production
// apiKeyRef shape and resolves the value through the launch environment
// (no credentials seam in this bare composition). The direct fetch calls
// below use the same value.
const API_KEY_REF = 'HINDSIGHT_API_KEY'
const API_KEY = process.env[API_KEY_REF]
if (API_KEY === undefined || API_KEY.length === 0) {
  console.error(`live.mjs: set ${API_KEY_REF} in the environment (the value the apiKeyRef resolves to) to run the live round-trip`)
  process.exit(1)
}
const BANK = 'dsh-plugin-smoke'
// The deployable file, resolved relative to this test — no absolute path.
const PLUGIN = new URL('../hindsight-advanced.ts', import.meta.url).href

const plugin = await import(PLUGIN)
assert.equal(plugin.name, 'hindsight-advanced')

// ── same minimal context shape as test.mjs ──────────────────────────────────
function makeCtx() {
  return {
    tools: { registered: [], register(tool) { this.registered.push(tool) } },
    listeners: [],
    on(event, fn, options) { this.listeners.push({ event, fn, options }) },
    // no seam in this bare composition: the plugin falls back to the
    // launch environment (process.env) for the apiKeyRef
    get: () => undefined,
  }
}
const signal = new AbortController().signal

// Fake sessions in the shape test.mjs uses: the plugin reads session.id and
// session.header.agentPreset to derive the tier tags. Two sessions of one
// preset, so the preset tier is shared between them while the session tier
// is per-session.
const alice = { session: { id: 'live-sess-a', header: { agentPreset: 'smoke-preset' } } }
const bob = { session: { id: 'live-sess-b', header: { agentPreset: 'smoke-preset' } } }

// bankConfig rides the first memory operation as a PATCH .../config and is
// durable server state: assert the mission actually landed via GET.
const MISSION = 'Focus on the live-demo project: build steps and deployment target.'
// The production shape: the loader validates the row's config before
// apply, so feed the row through the plugin's own validator and apply the
// resolved (fully defaulted) value — not a hand-assembled raw object.
const resolved = plugin.Config['~standard'].validate({
  bank: BANK,
  baseUrl: BASE,
  apiKeyRef: API_KEY_REF,
  autoContext: true,
  maxRecallTokens: 4096,
  autoContextTimeoutMs: 2500,
  bankConfig: { retain_mission: MISSION },
})
assert.ok('value' in resolved, JSON.stringify(resolved))
const ctx = makeCtx()
plugin.apply(ctx, resolved.value)
assert.equal(ctx.tools.registered.length, 1, 'one tool registered')
const tool = ctx.tools.registered[0]
assert.equal(tool.name, 'hindsight')

const run = (args, exec = { signal }) => tool.execute(args, exec)

// ── start clean: scratch bank may exist from a previous run; delete it ──────
{
  const res = await fetch(`${BASE}/v1/default/banks/${BANK}`, { method: 'DELETE', headers: { authorization: `Bearer ${API_KEY}` } })
  assert.ok(res.ok || res.status === 404, `cleanup delete: HTTP ${res.status}`)
}
console.log(`ok  scratch bank ${BANK} reset`)

// ── server-side tag read-back: /memories/list is a direct DB query, so it
//    does not wait on embedding/indexing latency ────────────────────────────
const listUnits = async params => {
  const url = new URL(`${BASE}/v1/default/banks/${BANK}/memories/list`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const res = await fetch(url, { headers: { authorization: `Bearer ${API_KEY}` } })
  assert.ok(res.ok, `memory list: HTTP ${res.status}`)
  const data = await res.json()
  return data.items ?? []
}

// ── retain (synchronous): the default scope is the session's preset tier ────
{
  const out = await run({ action: 'retain', text: 'The live-demo project is built with pnpm and deploys to the staging box.' }, { agent: alice, signal })
  assert.equal(out.action, 'retain')
  assert.equal(out.bank, BANK)
  const units = (await listUnits({ tags: 'preset:smoke-preset', tags_match: 'all_strict' }))
    .filter(unit => /live-demo|pnpm|staging box/.test(String(unit.text ?? '')))
  assert.ok(units.length > 0, `no unit tagged preset:smoke-preset carrying the retain content: ${JSON.stringify(await listUnits({}))}`)
  console.log('ok  retain (default scope) → unit stored tagged preset:smoke-preset (verified server-side)')
}

// ── retain scope: 'session' ─────────────────────────────────────────────────
{
  await run({ action: 'retain', text: 'The smoke session keeps its scratch notes in a Notion page.', scope: 'session' }, { agent: alice, signal })
  const units = (await listUnits({ tags: 'session:live-sess-a', tags_match: 'all_strict' }))
    .filter(unit => /Notion/.test(String(unit.text ?? '')))
  assert.ok(units.length > 0, `no unit tagged session:live-sess-a carrying the retain content: ${JSON.stringify(await listUnits({}))}`)
  console.log('ok  retain scope: session → unit stored tagged session:live-sess-a (verified server-side)')
}

// ── bank config: the first op should have PATCHed the declared mission ──────
{
  const res = await fetch(`${BASE}/v1/default/banks/${BANK}/config`, { headers: { authorization: `Bearer ${API_KEY}` } })
  assert.ok(res.ok, `config read-back: HTTP ${res.status}`)
  const config = await res.json()
  const overrides = config.overrides ?? config
  assert.equal(overrides.retain_mission, MISSION, JSON.stringify(config))
  console.log('ok  bankConfig → retain_mission applied via the lazy config PATCH')
}

// ── recall: poll until the bank's extraction lands (bounded) ────────────────
let hits = ''
const deadline = Date.now() + 90_000
while (Date.now() < deadline) {
  const out = await run({ action: 'recall', query: 'how is live-demo built and where does it deploy' }, { agent: alice, signal })
  assert.equal(out.action, 'recall')
  hits = out.text === 'no memories matched' ? '' : String(out.text)
  if (hits.length > 0) break
  await new Promise(r => setTimeout(r, 3_000))
}
assert.ok(hits.length > 0, `recall never matched: ${JSON.stringify(hits)}`)
assert.match(String(hits), /live-demo|pnpm|192\.168\.8\.20/)
console.log('ok  recall (tier-filtered) → matched the preset-tier memory')

// the session-tier memory's id, captured during the tier-visibility block
// (its render is the only place the model sees it) and consumed by the
// invalidation check below.
let notionId = ''

// ── tier visibility: own + preset tiers visible, a sibling's tier is not ────
{
  // alice (the owner) sees her own session tier, once indexed
  let sessionHits = ''
  const deadline2 = Date.now() + 90_000
  while (Date.now() < deadline2) {
    const out = await run({ action: 'recall', query: 'where does the smoke session keep its scratch notes' }, { agent: alice, signal })
    sessionHits = out.text === 'no memories matched' ? '' : String(out.text)
    if (/Notion/.test(sessionHits)) break
    await new Promise(r => setTimeout(r, 3_000))
  }
  assert.ok(/Notion/.test(sessionHits), `the owner's own session-tier memory never matched: ${JSON.stringify(sessionHits)}`)

  // the id the model would invalidate is the one the recall result renders
  const notionIdMatch = sessionHits.match(/id:([^\s]+)/)
  assert.ok(notionIdMatch, `the session-tier recall rendered no id to invalidate: ${JSON.stringify(sessionHits)}`)
  notionId = notionIdMatch[1]

  // read: the rendered id resolves to its text and type (the disambiguation
  // step of a curation call against the REAL server's GET /memories/{id})
  const read = await run({ action: 'read', id: notionId }, { agent: alice, signal })
  assert.equal(read.action, 'read')
  assert.equal(read.bank, BANK)
  assert.match(String(read.text), /Notion/)
  assert.match(String(read.text), new RegExp(`id:${notionId}`))
  console.log('ok  read → the rendered id resolves to its text and type (verified against the real server)')

  // bob (same preset, another session): the preset tier is shared, the
  // session tier is not — the server-side tag filter makes this exact
  const bobPreset = await run({ action: 'recall', query: 'how is live-demo built and where does it deploy' }, { agent: bob, signal })
  assert.match(String(bobPreset.text), /live-demo|pnpm|192\.168\.8\.20/, 'the shared preset tier is visible to the sibling session')
  const bobSession = await run({ action: 'recall', query: 'where does the smoke session keep its scratch notes' }, { agent: bob, signal })
  assert.doesNotMatch(String(bobSession.text), /Notion/, 'a sibling session\'s session-tier memory must stay invisible')
  console.log('ok  tier visibility → own + preset tiers visible, a sibling session\'s tier is not')
}

// ── invalidate: a wrong or stale memory is soft-retired by its rendered id ──
{
  const out = await run(
    { action: 'invalidate', id: notionId, reason: 'live round-trip: retiring the scratch note' },
    { agent: alice, signal },
  )
  assert.equal(out.action, 'invalidate')
  assert.equal(out.bank, BANK)
  assert.match(String(out.text), /invalidated/)

  // the retired memory leaves the recall surface (a short poll in case the
  // server propagates the state change with a beat of latency)
  let after = ''
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const out2 = await run({ action: 'recall', query: 'where does the smoke session keep its scratch notes' }, { agent: alice, signal })
    after = String(out2.text)
    if (!/Notion/.test(after)) break
    await new Promise(r => setTimeout(r, 3_000))
  }
  assert.doesNotMatch(after, /Notion/, `the invalidated memory still surfaces in recall: ${JSON.stringify(after)}`)
  console.log('ok  invalidate → the memory is soft-retired and leaves the recall surface')
}

// ── observation curation: only the backing fact carries an id ───────────────
// The bank's consolidation is asynchronous and not guaranteed on a tiny
// scratch bank, so this check runs only when the server actually produced
// an observation hit with a from: line. (The derived-observation 400 path
// is exercised by the stub suite — the live surface no longer renders the
// observation's own id, so there is no handle to feed it.)
{
  const out = await run({ action: 'recall', query: 'how is live-demo built and where does it deploy' }, { agent: alice, signal })
  const text = String(out.text)
  const fromId = text.match(/from: id:([^\s;]+)/)
  if (fromId === null) {
    console.log('skip  observation curation → the bank produced no observation hit with a from: line to exercise it')
  } else {
    // the observation renders NO id of its own — the trap handle whose
    // invalidation the bank refuses; the from: line's id is the one
    // curatable handle
    assert.doesNotMatch(text, /\(observation\) id:/, 'the observation hit renders no id of its own')

    // the backing fact (the from: line's id) is the curatable handle
    const backing = await run({ action: 'invalidate', id: fromId[1], reason: 'live round-trip: retiring the backing fact' }, { agent: alice, signal })
    assert.match(String(backing.text), /invalidated/)
    let after = ''
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const out2 = await run({ action: 'recall', query: 'how is live-demo built and where does it deploy' }, { agent: alice, signal })
      after = String(out2.text)
      if (!after.includes(`id:${fromId[1]}`)) break
      await new Promise(r => setTimeout(r, 3_000))
    }
    assert.doesNotMatch(after, `id:${fromId[1]}`, `the retired backing fact still renders as a source: ${JSON.stringify(after)}`)
    console.log('ok  observation curation → the observation renders no id of its own; the backing fact is retired and its from line is pruned')
  }
}

// ── reflect: synthesized answer grounded in the bank ────────────────────────
{
  const out = await run({ action: 'reflect', query: 'What do we know about the live-demo project?' }, { agent: alice, signal })
  assert.equal(out.action, 'reflect')
  assert.equal(typeof out.text, 'string')
  assert.ok(out.text.length > 0)
  console.log(`ok  reflect → "${String(out.text).slice(0, 140)}${out.text.length > 140 ? '…' : ''}"`)
}

// ── cleanup ─────────────────────────────────────────────────────────────────
{
  const res = await fetch(`${BASE}/v1/default/banks/${BANK}`, { method: 'DELETE', headers: { authorization: `Bearer ${API_KEY}` } })
  assert.ok(res.ok, `final delete: HTTP ${res.status}`)
  console.log(`ok  scratch bank ${BANK} deleted`)
}

console.log('\nall live hindsight round-trip checks passed')
