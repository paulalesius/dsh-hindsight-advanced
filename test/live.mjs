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
// It also covers the dual-mount ownership round-trip (design decision 13): a profile-wide host row and a preset row reach one session against two scratch banks; the preset mount owns the session's auto-recall - one snapshot per turn start with the host bank's standing directives merged in, the host mount silent on every automatic surface - driven through the real client (real recall, real directive listings, real extraction latency).
//
// Uses scratch banks (auto-created by the server) and deletes them at the
// end, so the user's real banks are never touched. The server defaults to
// 127.0.0.1:9177; set HINDSIGHT_BASE_URL to point at a non-local server.
//
//   HINDSIGHT_API_KEY=… [HINDSIGHT_BASE_URL=http://…] \
//     node --import ./register.mjs live.mjs
import assert from 'node:assert/strict'

const BASE = process.env.HINDSIGHT_BASE_URL ?? 'http://127.0.0.1:9177'
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
// the dual-mount ownership section's two scratch banks
const OWN_HOST_BANK = 'dsh-live-smoke-host'
const OWN_KERNEL_BANK = 'dsh-live-smoke-kernel'
// The deployable file, resolved relative to this test — no absolute path.
const PLUGIN = new URL('../hindsight-advanced.ts', import.meta.url).href

const plugin = await import(PLUGIN)
assert.equal(plugin.name, 'hindsight-advanced')

// ── same context shape as test.mjs (the dual-mount section needs the full one: createScope mints a scope fiber through ctx.plugin/extend, and the shared mount registry lives on the inherited root) ──────────────────────────────────
function makeCtx(extra = {}) {
  const ctx = {
    tools: {
      registered: [],
      register(tool) { this.registered.push(tool) },
    },
    listeners: [],
    on(event, fn, options) { this.listeners.push({ event, fn, options }) },
    // no seam in this bare composition: the plugin falls back to the
    // launch environment (process.env) for the apiKeyRef
    get(name) { return extra[name] },
    root: Object.create(null),
    effectDisposers: [],
    plugin() {
      const child = Object.create(this)
      child.listeners = []
      child.effectDisposers = []
      return { ctx: child, dispose: async () => {} }
    },
    extend(meta) {
      const child = Object.create(this)
      child.listeners = []
      child.effectDisposers = []
      for (const key of Reflect.ownKeys(meta)) {
        Object.defineProperty(child, key, Reflect.getOwnPropertyDescriptor(meta, key))
      }
      return child
    },
    effect(fn) {
      const disposer = fn()
      if (disposer !== undefined) this.effectDisposers.push(disposer)
    },
  }
  return ctx
}
const signal = new AbortController().signal

// ── minimal Session stand-in (same shape as test.mjs): the plugin reads
// events and surface.nodes, and the loop appends the decision's messages
// with a plain append
const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])
function makeSession(id, header = {}) {
  let seq = 0
  const session = {
    id,
    header,
    events: [],
    snapshotEvents: () => [...session.events],
    surface: { nodes: [] },
    append(type, data, opts = {}) {
      seq += 1
      const op = opts.surfaceOp ?? 'append'
      const event = { seq, type, data }
      if (SURFACE_EVENT_TYPES.has(type)) {
        event.surfaceOp = op
        if (op === 'append') {
          session.surface.nodes.push(seq)
        } else {
          let insertAt = -1
          for (let i = session.surface.nodes.length - 1; i >= 0; i -= 1) {
            const node = session.surface.nodes[i]
            if (node >= op.startSeq && node <= op.endSeq) {
              if (insertAt === -1) insertAt = i
              session.surface.nodes.splice(i, 1)
            }
          }
          session.surface.nodes.splice(insertAt === -1 ? session.surface.nodes.length : insertAt, 0, seq)
        }
      }
      if (opts.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
      session.events.push(event)
      return event
    },
  }
  return session
}
const isSnapshot = (event) =>
  event.type === 'user/message'
  && event.data.source?.kind === 'hindsight'
  && event.data.source.form === 'snapshot'
const snapshots = (session) => session.events.filter(isSnapshot)
const userMsg = (text) => ({ id: `u${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
// Run one pre-step the way the loop does: the loop appends the decision
// messages with a plain append - the snapshot rides the decision.
async function runStep(listener, a, step, messages) {
  a.turn = (a.turn ?? 0) + 1
  const decision = await listener(
    { agent: a, messages, turn: a.turn, step, signal },
    async () => ({ kind: 'enter', messages }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) a.session.append('user/message', message, { surfaceOp: 'append' })
  }
  return decision
}
const tick = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms))

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

// ── server-side tag read-back: /memories/list is a direct DB query, but the
//    server processes a retained unit asynchronously after the POST returns
//    (the unit is not visible until that processing lands), so the read-back
//    polls until the unit is visible - bounded ──────────────────────────────
const listUnits = async params => {
  const url = new URL(`${BASE}/v1/default/banks/${BANK}/memories/list`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const res = await fetch(url, { headers: { authorization: `Bearer ${API_KEY}` } })
  assert.ok(res.ok, `memory list: HTTP ${res.status}`)
  const data = await res.json()
  return data.items ?? []
}

const waitForUnit = async (params, pattern, label) => {
  const until = Date.now() + 30_000
  let units = []
  for (;;) {
    units = (await listUnits(params)).filter(unit => pattern.test(String(unit.text ?? '')))
    if (units.length > 0 || Date.now() >= until) break
    await new Promise(r => setTimeout(r, 2_000))
  }
  assert.ok(units.length > 0, `no ${label} unit carrying the retain content after polling: ${JSON.stringify(await listUnits({}))}`)
}

// ── retain (synchronous): the default scope is the session's preset tier ────
{
  const out = await run({ action: 'retain', text: 'The live-demo project is built with pnpm and deploys to the staging box.' }, { agent: alice, signal })
  assert.equal(out.action, 'retain')
  assert.equal(out.bank, BANK)
  await waitForUnit({ tags: 'preset:smoke-preset', tags_match: 'all_strict' }, /live-demo|pnpm|staging box/, 'preset:smoke-preset')
  console.log('ok  retain (default scope) → unit stored tagged preset:smoke-preset (verified server-side)')
}

// ── retain scope: 'session' ─────────────────────────────────────────────────
{
  await run({ action: 'retain', text: 'The smoke session keeps its scratch notes in a Notion page.', scope: 'session' }, { agent: alice, signal })
  await waitForUnit({ tags: 'session:live-sess-a', tags_match: 'all_strict' }, /Notion/, 'session:live-sess-a')
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

// ── dual-mount ownership against the REAL server ─────────────────────────
// The production gpu-kernels shape: a profile-wide host row and a preset row
// of this plugin reach one session against two different banks. The preset
// mount OWNS the session's auto-recall (design decision 13): one snapshot
// per turn start - the owner bank's card with the host bank's standing
// directives merged in as their own section - while the host mount is total
// silence on every automatic surface for that session. The stub suite
// proves the loop semantics deterministically; this section proves the same
// wiring through the real client (real recall, real directive listings,
// real extraction latency). Note the stand-in's listeners are driven
// directly, so the scope fiber's session filter (which keeps the preset
// mount out of no-preset sessions in the real loop) is not modeled here.
{
  const { createScope } = await import('@deepseek-ai/dsh-scope')

  // fresh scratch banks (a previous run may have left one behind)
  for (const bank of [OWN_HOST_BANK, OWN_KERNEL_BANK]) {
    const res = await fetch(`${BASE}/v1/default/banks/${bank}`, { method: 'DELETE', headers: { authorization: `Bearer ${API_KEY}` } })
    assert.ok(res.ok || res.status === 404, `reset delete ${bank}: HTTP ${res.status}`)
  }

  // Two mounts against one shared root context, the production shape: the
  // host row unscoped (its registry record under the shared host key), the
  // preset row under a real createScope (its record under the preset id).
  const hostCtx = makeCtx()
  plugin.apply(hostCtx, {
    ...resolved.value,
    bank: OWN_HOST_BANK,
    recallContextTurns: 1,
    prefetch: false,
    recallAfterText: true,
    recallAfterCompaction: true,
  })
  const kernelScope = createScope(hostCtx, { agentPreset: 'live-kernel' })
  plugin.apply(kernelScope.ctx, {
    ...resolved.value,
    bank: OWN_KERNEL_BANK,
    recallContextTurns: 1,
    prefetch: false,
    recallAfterText: true,
    recallAfterCompaction: true,
  })
  const hostPreStep = hostCtx.listeners[0].fn
  const hostTurnStopping = hostCtx.listeners[1].fn
  const hostSessionEvent = hostCtx.listeners[2].fn
  const hostGate = hostCtx.listeners[3].fn
  const ownerPreStep = kernelScope.ctx.listeners[0].fn
  const ownerSessionEvent = kernelScope.ctx.listeners[2].fn
  // The stand-in's tools registry is inherited along the context chain, so
  // BOTH applies appended to the host context's array (apply order).
  const hostTool = hostCtx.tools.registered[0]
  const ownerTool = kernelScope.ctx.tools.registered[1]

  // Disjoint canaries per bank, plus a standing directive on each bank:
  // the host directive is GLOBAL (untagged - visible to every session of
  // the host bank, the production shape of the dsh bank's standing rules),
  // the kernel directive PRESET-scoped (visible to the preset's sessions
  // only). The real server tier-filters the listings, so the scopes matter.
  // Any host-bank content leaking into the kernel session's snapshots shows
  // up as the sapphire canary or a second card.
  const hostAgent = { session: makeSession('live-agent-host') }
  const kernelAgent = { session: makeSession('live-agent-kernel', { agentPreset: 'live-kernel' }) }
  await hostTool.execute({ action: 'retain', text: 'The live host bank stores its sapphire tokens in the east drawer.' }, { agent: hostAgent, signal })
  await hostTool.execute({ action: 'retain', kind: 'directive', name: 'live-host-rule', scope: 'global', text: 'Live host standing rule: keep the sapphire drawer sealed.' }, { agent: hostAgent, signal })
  await ownerTool.execute({ action: 'retain', text: 'The live kernel bank stores its vermilion gaskets in the north rack.' }, { agent: kernelAgent, signal })
  await ownerTool.execute({ action: 'retain', kind: 'directive', name: 'live-kernel-rule', text: 'Live kernel standing rule: never open the vermilion rack.' }, { agent: kernelAgent, signal })
  console.log(`ok  dual mount (live): two scratch banks seeded, two mounts on one shared root context`)

  const kernel = { session: makeSession('live-sess-kernel', { agentPreset: 'live-kernel' }) }

  // Turn 1 through the owner mount: ONE snapshot, the owner bank card, with
  // BOTH banks' standing directives in their own per-bank sections. Each
  // re-drive is a fresh recall plus directive listings, and the unchanged-
  // recall comparison is on the full rendered text, so the loop breaks on
  // the first card that carries everything: the real server may index the
  // kernel bank's fact and activate a retained directive asynchronously.
  let cardText = ''
  {
    const deadline = Date.now() + 90_000
    const ownerRules = `Standing rules from the Hindsight bank "${OWN_KERNEL_BANK}" - follow them every turn:`
    const hostRules = `Standing rules from the Hindsight bank "${OWN_HOST_BANK}" - follow them every turn:`
    for (;;) {
      const decision = await runStep(ownerPreStep, kernel, 1, [userMsg('inspect the vermilion gaskets in the north rack')])
      const card = decision.messages.find(message => message.source?.kind === 'hindsight')
      cardText = card ? card.content[0].text : ''
      if (cardText.includes('vermilion gaskets') && cardText.includes(ownerRules) && cardText.includes(hostRules)) break
      if (Date.now() > deadline) break
      await new Promise(resolve => setTimeout(resolve, 3_000))
    }
  }
  assert.ok(cardText.length > 0, 'the owner mount commits the session snapshot')
  assert.ok(cardText.includes(`Relevant memories from the Hindsight bank "${OWN_KERNEL_BANK}"`), 'the card names the owner bank')
  assert.ok(cardText.includes('vermilion gaskets'), 'the card carries the owner bank hit')
  assert.doesNotMatch(cardText, /sapphire tokens/, 'the host bank hit stays out of the owner card')
  assert.ok(cardText.includes(`Standing rules from the Hindsight bank "${OWN_KERNEL_BANK}" - follow them every turn:`), 'the owner bank rules section')
  assert.ok(cardText.includes(`Standing rules from the Hindsight bank "${OWN_HOST_BANK}" - follow them every turn:`), 'the merged host bank rules section')
  assert.ok(cardText.includes('never open the vermilion rack'), 'the owner bank rule text')
  assert.ok(cardText.includes('keep the sapphire drawer sealed'), 'the merged host bank rule text')
  assert.ok(cardText.includes('id:'), 'the owner bank hit carries its curatable id')
  console.log('ok  dual mount (live): one snapshot per turn start, host standing rules merged')

  // The host mount, driven for the same kernel session, is silent on every
  // automatic surface: the mid-step claim, the turn-stop prefetch, the
  // post-compaction recall, and the pre-execution gate - and the kernel
  // session's surface gains nothing from any of them.
  const kernelSnapshots = () => snapshots(kernel.session).length
  const beforeSilence = kernelSnapshots()
  const silentDecision = await hostPreStep(
    { agent: kernel, messages: [userMsg('steer: protect the sapphire drawer')], turn: 1, step: 2, signal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(silentDecision.messages.length, 0, 'no host mid-step recall for the kernel session')
  hostTurnStopping({ agent: kernel, turn: 1, signal })
  await tick()
  const hostNextTurn = await runStep(hostPreStep, kernel, 2, [userMsg('re-check the north rack again')])
  assert.equal(hostNextTurn.messages.filter(message => message.source?.kind === 'hindsight').length, 0, 'no host prefetch consumption for the kernel session')
  hostSessionEvent(kernel.session, { type: 'compaction/end', data: { compactionId: 'live-c1', turn: null } })
  await tick()
  assert.equal(kernelSnapshots(), beforeSilence, 'no host post-compaction snapshot for the kernel session')
  const hostGateResult = await hostGate(
    { name: 'bash', arguments: { command: 'open the vermilion rack' }, agent: kernel, signal },
    async () => ({ kind: 'allow' }),
  )
  assert.deepEqual(hostGateResult, { kind: 'allow' }, 'the host gate is silent for the kernel session')
  console.log('ok  dual mount (live): the host row is silent on every kernel surface')

  // The owner keeps its own surfaces: its post-compaction recall commits the
  // recall:compact snapshot DIRECTLY to the surface (polling the real
  // extraction). The merged host-bank rules section is asserted with the
  // same re-drive as turn 1: the shadow listing is failure-isolated by
  // design, so a transient hiccup on that one fetch drops it from that
  // snapshot - the loop re-fires the event one bounded lookup at a time
  // (9 s cadence, the recallCompactTimeoutMs budget plus margin, so no
  // in-flight lookups stack) until a compact snapshot carries the merge.
  {
    const deadline = Date.now() + 90_000
    const hostRules = `Standing rules from the Hindsight bank "${OWN_HOST_BANK}"`
    let compactionSeq = 0
    let firedAt = 0
    for (;;) {
      if (Date.now() - firedAt >= 9_000) {
        compactionSeq += 1
        ownerSessionEvent(kernel.session, { type: 'compaction/end', data: { compactionId: `live-c2-${compactionSeq}`, turn: null } })
        firedAt = Date.now()
      }
      const merged = snapshots(kernel.session).some(snapshot =>
        snapshot.data.source.sections[0].name.startsWith('recall:compact')
        && snapshot.data.content[0].text.includes(hostRules),
      )
      if (merged) break
      if (Date.now() > deadline) break
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
  const compact = snapshots(kernel.session).filter(snapshot =>
    snapshot.data.source.sections[0].name.startsWith('recall:compact'),
  )
  assert.ok(compact.length >= 1, 'the owner commits its post-compaction snapshot')
  for (const snapshot of compact) {
    assert.equal(snapshot.data.source.bank, OWN_KERNEL_BANK, 'every compact snapshot is the owner bank')
    assert.doesNotMatch(snapshot.data.content[0].text, /sapphire tokens/, 'no host bank content after compaction')
  }
  assert.ok(compact.some(snapshot => snapshot.data.content[0].text.includes(`Standing rules from the Hindsight bank "${OWN_HOST_BANK}"`)), 'a compact snapshot carries the merged host rules')
  console.log('ok  dual mount (live): post-compaction recall is the owner alone')

  // A session no preset mount covers: the host row serves it unchanged -
  // host bank only, its own rules section, no merged kernel section.
  const plain = { session: makeSession('live-sess-plain') }
  let plainText = ''
  {
    const deadline = Date.now() + 90_000
    for (;;) {
      const decision = await runStep(hostPreStep, plain, 1, [userMsg('inspect the sapphire tokens in the east drawer')])
      const card = decision.messages.find(message => message.source?.kind === 'hindsight')
      plainText = card ? card.content[0].text : ''
      if (plainText.includes('sapphire tokens')) break
      if (Date.now() > deadline) break
      await new Promise(resolve => setTimeout(resolve, 3_000))
    }
  }
  assert.ok(plainText.includes(`Relevant memories from the Hindsight bank "${OWN_HOST_BANK}"`), 'the host row serves a no-preset session as before')
  assert.ok(plainText.includes('sapphire tokens'), 'the host card carries the host bank hit')
  assert.ok(plainText.includes('keep the sapphire drawer sealed'), 'the host rules section on the host card')
  assert.doesNotMatch(plainText, new RegExp(`Standing rules from the Hindsight bank "${OWN_KERNEL_BANK}"`), 'no merged kernel rules on the host card')
  console.log('ok  dual mount (live): no-preset sessions keep the host row behavior')
}

// ── cleanup: delete all three scratch banks ──────────────────────────────────
for (const bank of [BANK, OWN_HOST_BANK, OWN_KERNEL_BANK]) {
  const res = await fetch(`${BASE}/v1/default/banks/${bank}`, { method: 'DELETE', headers: { authorization: `Bearer ${API_KEY}` } })
  assert.ok(res.ok, `final delete ${bank}: HTTP ${res.status}`)
  console.log(`ok  scratch bank ${bank} deleted`)
}

console.log('\nall live hindsight round-trip checks passed')
