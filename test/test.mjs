// Smoke test for the userland hindsight plugin, driven against the stub
// Hindsight server: export shape, Config validation (one mount, one bank,
// the retainScope tier default, the apiKeyRef grammar + mutual exclusion
// with apiKey), per-mount bank behavior (banks are the OUTER isolation;
// inside a bank, the three visibility tiers), authorization (literal key,
// credential ref via the seam, ref via the environment fallback), tool
// execution (retain / recall / reflect / read, with tier tags, plus standing
// directives: kind: directive, tier-scoped listing, rules-on-empty-recall,
// plus provenance: budgeted source-fact enrichment on recall, hit ids, and
// `from:` lines under observation hits — in the tool AND the auto-recall
// snapshot — and retain's explicit occurrence timestamp),
// plus curation: invalidating a memory the model has shown to be wrong or
// stale (a soft PATCH with a recorded reason; the retired memory leaves the
// recall surface) and read — resolving an id to its text and type (a fact:
// its own line; an observation: its backing facts WITH their text; an
// unknown id: the same bounded 404),
// plus the automatic recall's query composition (recallContextTurns,
// default 5): the anchor message under a `Prior context:` block of the
// recent prior turns (one line per user / assistant message), capped at
// 1000 chars with the oldest lines dropping first — on BOTH the
// synchronous path (the anchor not on the log yet) and the prefetch
// (the anchor's own turn composed in, its own line dropped),
// and the automatic pre-step recall: with recallPreserve (default) the
// snapshot rows ride the pre-step decision (landing AFTER the triggering
// message) and are only ever appended; with recallPreserve: false the
// surface carries only the LATEST full snapshot — each new one retires
// the previous full card in place (a tiny `form: 'notice'` tombstone
// marker at the old turn, shadow-priced by an adjacent log-only
// compaction/prune) and lands fresh as a full card at its own turn (the
// durable log keeps every full snapshot; an unchanged recall commits
// nothing — the snapshot is already current);
// in preserve mode an identical recall commits a marker row — naming the
// applied memories one compact line each — instead of a duplicate block,
// so every applied recall has a visible row.
// The recall starts AHEAD of the turn that pays for it (the turn-stopping
// prefetch): the detached job queries the turn's own human message while
// the user is reading or typing, the next step consumes the cache with no
// bank call, a failed or too-slow job falls back to the original bounded
// synchronous path, subagent turns never prefetch, prefetch: false gates
// the job off (every turn queries its current message synchronously), and
// disposal clears the slot.
import assert from 'node:assert/strict'
import { start, state } from './stub-server.mjs'

const stub = await start(18888)
const stubUrl = `http://127.0.0.1:${stub.port}`

const plugin = await import('../hindsight-advanced.ts')

// ── export shape: Cordis Plugin.Object ──────────────────────────────────────
assert.equal(plugin.name, 'hindsight-advanced')
assert.deepEqual(plugin.inject, ['tools'])
assert.equal(typeof plugin.apply, 'function')
assert.equal(plugin.Config['~standard'].version, 1)
assert.equal(typeof plugin.Config['~standard'].validate, 'function')
console.log('ok  export shape (Plugin.Object: name/inject/Config/apply)')

// ── Config validation ───────────────────────────────────────────────────────
const validate = input => plugin.Config['~standard'].validate(input)

// one mount, one bank
const standard = validate({ bank: 'hermes' })
assert.ok('value' in standard, JSON.stringify(standard))
assert.deepEqual(standard.value, {
  bank: 'hermes',
  baseUrl: 'http://127.0.0.1:8888',
  autoContext: true,
  prefetch: true,
  recallContextTurns: 5,
  recallAfterText: false,
  recallAfterReasoning: false,
  recallPreserve: true,
  retainAsync: false,
  maxRecallTokens: 4096,
  autoContextTimeoutMs: 2500,
  retainScope: 'preset',
})

// retainScope: an enum with a 'preset' default
const scopedMount = validate({ bank: 'x', retainScope: 'session' })
assert.ok('value' in scopedMount, JSON.stringify(scopedMount))
assert.equal(scopedMount.value.retainScope, 'session')
const globalMount = validate({ bank: 'x', retainScope: 'global' })
assert.equal(globalMount.value.retainScope, 'global')
const badScope = validate({ bank: 'x', retainScope: 'everywhere' })
assert.ok('issues' in badScope && badScope.issues.some(issue => issue.path?.[0] === 'retainScope'), JSON.stringify(badScope))

// retainAsync: opt-in + validation
const asyncMount = validate({ bank: 'x', retainAsync: true })
assert.ok('value' in asyncMount, JSON.stringify(asyncMount))
assert.equal(asyncMount.value.retainAsync, true)

// prefetch: on by default (the recall reads the previous turn ahead);
// opt-out + validation
const noPrefetch = validate({ bank: 'x', prefetch: false })
assert.ok('value' in noPrefetch, JSON.stringify(noPrefetch))
assert.equal(noPrefetch.value.prefetch, false)
const badPrefetch = validate({ bank: 'x', prefetch: 'yes' })
assert.ok('issues' in badPrefetch && badPrefetch.issues.some(issue => issue.path?.[0] === 'prefetch'), JSON.stringify(badPrefetch))

// recallContextTurns: 5 by default (the reference integrations use 1 — the
// plugin's `Prior context:` block is a first-class part of the query); validation
const oneContextTurn = validate({ bank: 'x', recallContextTurns: 1 })
assert.ok('value' in oneContextTurn, JSON.stringify(oneContextTurn))
assert.equal(oneContextTurn.value.recallContextTurns, 1)
const badTurns = validate({ bank: 'x', recallContextTurns: 2.5 })
assert.ok('issues' in badTurns && badTurns.issues.some(issue => issue.path?.[0] === 'recallContextTurns'), JSON.stringify(badTurns))
const zeroTurns = validate({ bank: 'x', recallContextTurns: 0 })
assert.ok('issues' in zeroTurns && zeroTurns.issues.some(issue => issue.path?.[0] === 'recallContextTurns'), JSON.stringify(zeroTurns))

// recallPreserve: true by default (the append-only surface); opt-out +
// validation
const noPreserve = validate({ bank: 'x', recallPreserve: false })
assert.ok('value' in noPreserve, JSON.stringify(noPreserve))
assert.equal(noPreserve.value.recallPreserve, false)
const badPreserve = validate({ bank: 'x', recallPreserve: 'yes' })
assert.ok('issues' in badPreserve && badPreserve.issues.some(issue => issue.path?.[0] === 'recallPreserve'), JSON.stringify(badPreserve))

// recallAfterText / recallAfterReasoning: off by default (the mid-step
// agent-output recall is opt-in); opt-in + validation
const midText = validate({ bank: 'x', recallAfterText: true })
assert.ok('value' in midText, JSON.stringify(midText))
assert.equal(midText.value.recallAfterText, true)
assert.equal(midText.value.recallAfterReasoning, false)
const midThink = validate({ bank: 'x', recallAfterReasoning: true })
assert.ok('value' in midThink, JSON.stringify(midThink))
assert.equal(midThink.value.recallAfterReasoning, true)
const badMidText = validate({ bank: 'x', recallAfterText: 'yes' })
assert.ok('issues' in badMidText && badMidText.issues.some(issue => issue.path?.[0] === 'recallAfterText'), JSON.stringify(badMidText))
const badMidThink = validate({ bank: 'x', recallAfterReasoning: 'yes' })
assert.ok('issues' in badMidThink && badMidThink.issues.some(issue => issue.path?.[0] === 'recallAfterReasoning'), JSON.stringify(badMidThink))

// bank is required
const none = validate({})
assert.ok('issues' in none && none.issues.some(issue => issue.message === 'bank is required'), JSON.stringify(none))
const badBank = validate({ bank: 7 })
assert.ok('issues' in badBank && badBank.issues.some(issue => issue.path?.[0] === 'bank'))
const badInt = validate({ bank: 'x', maxRecallTokens: 'large' })
assert.ok('issues' in badInt && badInt.issues.some(issue => issue.path?.[0] === 'maxRecallTokens'))
const badRetain = validate({ bank: 'x', retainAsync: 'yes' })
assert.ok('issues' in badRetain && badRetain.issues.some(issue => issue.path?.[0] === 'retainAsync'))
// apiKeyRef: a credential REFERENCE name (POSIX identifier), never the value
const withRef = validate({ bank: 'x', apiKeyRef: 'HINDSIGHT_API_KEY' })
assert.ok('value' in withRef, JSON.stringify(withRef))
assert.equal(withRef.value.apiKeyRef, 'HINDSIGHT_API_KEY')
assert.equal(withRef.value.apiKey, undefined)
const badRef = validate({ bank: 'x', apiKeyRef: 'nope key' })
assert.ok('issues' in badRef && badRef.issues.some(issue => issue.path?.[0] === 'apiKeyRef'), JSON.stringify(badRef))
const bothKeys = validate({ bank: 'x', apiKey: 'literal', apiKeyRef: 'HINDSIGHT_API_KEY' })
assert.ok('issues' in bothKeys && bothKeys.issues.some(issue => issue.message === 'set apiKey OR apiKeyRef, not both'), JSON.stringify(bothKeys))
// bankConfig: a flat object of string overrides, forwarded verbatim
const withConfig = validate({ bank: 'x', bankConfig: { retain_mission: 'Focus on coding work.', retain_extraction_mode: 'custom' } })
assert.ok('value' in withConfig, JSON.stringify(withConfig))
assert.deepEqual(withConfig.value.bankConfig, { retain_mission: 'Focus on coding work.', retain_extraction_mode: 'custom' })
const badBankConfig = validate({ bank: 'x', bankConfig: 'nope' })
assert.ok('issues' in badBankConfig && badBankConfig.issues.some(issue => issue.path?.[0] === 'bankConfig'))
const badBankConfigEntry = validate({ bank: 'x', bankConfig: { retain_mission: 7 } })
assert.ok('issues' in badBankConfigEntry && badBankConfigEntry.issues.some(issue => issue.path?.join('.') === 'bankConfig.retain_mission'))
const trimmed = validate({ bank: '  hermes  ', baseUrl: 'http://127.0.0.1:8888///' })
assert.equal(trimmed.value.bank, 'hermes')
assert.equal(trimmed.value.baseUrl, 'http://127.0.0.1:8888')
console.log('ok  Config validator (required bank, defaults, trimming, issues)')

// ── a minimal plugin context ────────────────────────────────────────────────
// `extra` stands in for seam services the plugin may read with ctx.get
// (e.g. a credentials stub); everything else reads as unprovided.
function makeCtx(extra = {}) {
  return {
    tools: {
      registered: [],
      register(tool) { this.registered.push(tool) },
    },
    listeners: [],
    on(event, fn, options) { this.listeners.push({ event, fn, options }) },
    get(name) { return extra[name] },
  }
}

// Minimal Session stand-in: the plugin reads events, surface.nodes, and
// appends user/message with append or positional replace. The surface
// semantics modeled here mirror dsh-session: only the four
// message-producing event types join the surface, and a replace shadows
// its range with the new node landing IN PLACE at the range's position;
// every other type (compaction/prune included) is log-only.
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

// session fixtures: the plugin reads id, header.agentPreset (the preset
// tier), and header.origin/parentSession (subagent tier leaning); the base
// fixtures carry no preset, so their tier tags are preset:none
const agent = { session: makeSession('sess-1') }
const otherAgent = { session: makeSession('sess-2') }
const subagent = { session: makeSession('sess-3', { origin: 'subagent' }) }
const baseSignal = new AbortController().signal
const userMsg = (text) => ({ id: `u${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const isSnapshot = (event) =>
  event.type === 'user/message'
  && event.data.source?.kind === 'plugin'
  && event.data.source.plugin === 'hindsight-advanced'
  && event.data.source.form === 'snapshot'
const snapshots = (session) => session.events.filter(isSnapshot)
const onSurface = (session, event) => session.surface.nodes.includes(event.seq)

// Mirrors deriveEventMessage over the stand-in's surface: each surface
// event derives to its message.
const deriveMessages = (session) => session.surface.nodes
  .map(seq => session.events[seq - 1])
  .map(event => event.data)
const derivedSnapshots = (session) => deriveMessages(session).filter(message =>
  message.source?.kind === 'plugin' && message.source.plugin === 'hindsight-advanced' && message.source.form === 'snapshot',
)

// Run one pre-step the way the loop does: the loop appends the decision's
// messages with a plain append — the snapshot rides the decision, landing
// after the triggering message.
async function runStep(listener, a, step, messages) {
  a.turn = (a.turn ?? 0) + 1
  const decision = await listener(
    { agent: a, messages, turn: a.turn, step, signal: baseSignal },
    async () => ({ kind: 'enter', messages }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) a.session.append('user/message', message, { surfaceOp: 'append' })
  }
  return decision
}

// Run a mid-turn step on a FIXED turn the way the loop does: `runStep`
// numbers every call as a new turn, while the mid-step recalls live INSIDE
// one turn (step 2 of turn 1). The decision's messages are appended with a
// plain append, as the loop does.
async function runStepAt(listener, a, turn, step, messages) {
  a.turn = turn
  const decision = await listener(
    { agent: a, messages, turn, step, signal: baseSignal },
    async () => ({ kind: 'enter', messages }),
  )
  if (decision.kind === 'enter') {
    for (const message of decision.messages) a.session.append('user/message', message, { surfaceOp: 'append' })
  }
  return decision
}

// Seed the durable log with a step's committed assistant message the way
// the loop's `assistant/message` event carries it (the mid-step recall's
// anchor source): `turn`/`step` on the event data, the committed blocks on
// `message.content`.
const asstStep = (session, turn, step, blocks) =>
  session.append('assistant/message', {
    turn,
    step,
    message: { id: `a-${turn}-${step}`, role: 'assistant', content: blocks, source: { kind: 'model' } },
  })
const textBlock = (text) => ({ type: 'text', text })
const thinkBlock = (text) => ({ type: 'reasoning', text })
const toolCallBlock = (name) => ({ id: `tc-${name}`, type: 'toolCall', name, input: {} })

// ── authorization: literal key, credential ref (seam), ref (env fallback) ───
{
  // literal apiKey → Bearer header on every call
  const ctxLiteral = makeCtx()
  plugin.apply(ctxLiteral, { bank: 'authz', baseUrl: stubUrl, apiKey: 'literal-key' })
  await ctxLiteral.tools.registered[0].execute({ action: 'recall', query: 'authz probe' }, { signal: baseSignal })
  assert.equal(state.requests.at(-1).authorization, 'Bearer literal-key')

  // apiKeyRef resolved per call through the credentials seam (ctx.get)
  const ctxSeam = makeCtx({ credentials: { resolve: async ref => ({ value: `seam-key:${ref}`, source: 'file' }) } })
  plugin.apply(ctxSeam, { bank: 'authz', baseUrl: stubUrl, apiKeyRef: 'HINDSIGHT_API_KEY' })
  await ctxSeam.tools.registered[0].execute({ action: 'recall', query: 'authz probe' }, { signal: baseSignal })
  assert.equal(state.requests.at(-1).authorization, 'Bearer seam-key:HINDSIGHT_API_KEY')

  // no seam in this composition: the launch environment is the whole
  // credential plane — the ref names an environment variable
  process.env.HINDSIGHT_ENV_FALLBACK_KEY = 'env-key'
  try {
    const ctxEnv = makeCtx()
    plugin.apply(ctxEnv, { bank: 'authz', baseUrl: stubUrl, apiKeyRef: 'HINDSIGHT_ENV_FALLBACK_KEY' })
    await ctxEnv.tools.registered[0].execute({ action: 'recall', query: 'authz probe' }, { signal: baseSignal })
    assert.equal(state.requests.at(-1).authorization, 'Bearer env-key')
  } finally {
    delete process.env.HINDSIGHT_ENV_FALLBACK_KEY
  }
  console.log('ok  authorization: literal apiKey / apiKeyRef via seam / apiKeyRef via environment')
}

// ── mount A: bank hermes (what `standard` would mount) ──────────────────────
// Pinned to recallContextTurns: 1: this mount's automatic-recall checks
// assert the single-message anchor semantics (exact query, an unrelated
// message getting an empty recall, an unchanged recall committing the
// marker) — the multi-turn `Prior context:` composition gets its own
// mount (J) at the default of 5.
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, recallContextTurns: 1 })
  assert.equal(ctx.tools.registered.length, 1)
  const tool = ctx.tools.registered[0]
  const listener = ctx.listeners[0].fn
  assert.equal(tool.name, 'hindsight')
  assert.deepEqual(tool.parameters.properties.action.enum, ['retain', 'recall', 'reflect', 'read', 'invalidate'])
  assert.ok(tool.parameters.required?.includes('action'))
  assert.equal(tool.parameters.properties.tags, undefined, 'no tag parameter')
  console.log('ok  tool registered, pre-step listener prepended (one mount, one bank)')

  // retain — the stub must see the exact Hindsight retain shape, synchronous
  const retainResult = await tool.execute(
    { action: 'retain', text: 'The user prefers tabs over spaces in this project.' },
    { signal: baseSignal },
  )
  const retainReq = state.requests.at(-1)
  assert.equal(retainReq.path, '/v1/default/banks/hermes/memories')
  assert.deepEqual(retainReq.body, { items: [{ content: 'The user prefers tabs over spaces in this project.' }] })
  assert.equal(retainResult.bank, 'hermes')
  assert.equal(retainResult.text, 'stored and processed by the bank; it is searchable now')
  console.log('ok  mount A: retain (sync default) → POST /v1/default/banks/hermes/memories {items}')

  // retainAsync: true sends the async flag and reports background extraction
  const ctxAsync = makeCtx()
  plugin.apply(ctxAsync, { ...standard.value, retainAsync: true, baseUrl: stubUrl })
  const asyncResult = await ctxAsync.tools.registered[0].execute(
    { action: 'retain', text: 'The user keeps their backups on the NAS at home.' },
    { signal: baseSignal },
  )
  const asyncReq = state.requests.at(-1)
  assert.equal(asyncReq.body.async, true)
  assert.match(asyncResult.text, /stored for background extraction/)
  console.log('ok  mount A: retainAsync: true → body carries async, reports background extraction')

  // retain with an explicit occurrence time: forwarded verbatim — an ISO
  // date ('when it happened') or 'unset' (timeless); omitted, the body is
  // exactly what it was (the bank stamps the storage time instead)
  await tool.execute(
    { action: 'retain', text: 'The team migrated to the new CI in June.', timestamp: '2026-06-01T00:00:00Z' },
    { signal: baseSignal },
  )
  assert.deepEqual(state.requests.at(-1).body, {
    items: [{ content: 'The team migrated to the new CI in June.', timestamp: '2026-06-01T00:00:00Z' }],
  })
  await tool.execute(
    { action: 'retain', text: 'The project name derives from its first city.', timestamp: 'unset' },
    { signal: baseSignal },
  )
  assert.deepEqual(state.requests.at(-1).body, {
    items: [{ content: 'The project name derives from its first city.', timestamp: 'unset' }],
  })
  console.log('ok  mount A: retain forwards an explicit occurrence timestamp (ISO, and "unset")')

  // recall — the stored memory comes back; without an agent in the
  // execution there is no session context, hence no tier filter
  const recallResult = await tool.execute({ action: 'recall', query: 'which editor does the user prefer?' }, { signal: baseSignal })
  assert.match(recallResult.text, /prefers tabs over spaces/)
  const recallReq = state.requests.at(-1)
  assert.equal(recallReq.path, '/v1/default/banks/hermes/memories/recall')
  assert.equal(recallReq.body.max_tokens, 4096)
  assert.equal(recallReq.body.tags, undefined, 'no agent context: no tier filter')
  assert.deepEqual(recallReq.body.types, ['world', 'experience', 'observation'], 'default: all three layers')
  assert.equal(recallReq.body.prefer_observations, true, 'default: observations supersede their raw facts')
  console.log('ok  mount A: recall returns the stored memory (no agent → whole bank visible)')

  // consolidation mode — the recall body requests every layer with
  // prefer_observations, so a fact + its observation collapse to the
  // observation; an explicit model types restriction wins over the default
  await tool.execute({ action: 'recall', query: 'which editor does the user prefer?', types: ['world'] }, { signal: baseSignal })
  const constrainedReq = state.requests.at(-1)
  assert.deepEqual(constrainedReq.body.types, ['world'], 'explicit model types restriction wins')
  assert.equal(constrainedReq.body.prefer_observations, true, 'still sent; a no-op without an observation type')
  console.log('ok  mount A: recall requests consolidation mode (all three layers, prefer_observations)')

  // reflect — synthesized answer
  const reflectResult = await tool.execute({ action: 'reflect', query: 'what do we know about their editor?' }, { signal: baseSignal })
  assert.match(reflectResult.text, /^FAKE-REFLECT:/)
  console.log('ok  mount A: reflect → POST .../reflect {query}')

  // argument validation still runs through defineTool
  await assert.rejects(() => tool.execute({ action: 'retain' }, { signal: baseSignal }), /text/)
  await assert.rejects(() => tool.execute({ action: 'recall' }, { signal: baseSignal }), /query/)
  await assert.rejects(() => tool.execute({ action: 'invalidate', reason: 'corrected by the user' }, { signal: baseSignal }), /id/)
  await assert.rejects(() => tool.execute({ action: 'invalidate', id: 'm1' }, { signal: baseSignal }), /reason/)
  console.log('ok  mount A: missing required args are rejected')

  // ── automatic recall (append-only: never replaces a prior turn) ───────────────────────────
  // Turn 1: the snapshot rides the pre-step decision, so the loop appends it
  // right after the message that triggered the recall — below it in the log.
  const d1 = await runStep(listener, agent, 1, [userMsg('which editor does the user prefer?')])
  assert.equal(d1.kind, 'enter')
  assert.equal(d1.messages.length, 2, 'the snapshot rides the decision')
  const snaps1 = snapshots(agent.session)
  assert.equal(snaps1.length, 1)
  assert.ok(onSurface(agent.session, snaps1[0]), 'turn 1 snapshot is on the model-visible surface')
  assert.equal(snaps1[0].surfaceOp, 'append', 'the loop appends the snapshot as a plain append')
  assert.equal(snaps1[0].seq, agent.session.events.at(-2).seq + 1, 'the row lands right after the triggering message')
  assert.match(snaps1[0].data.content[0].text, /Relevant memories from the Hindsight bank "hermes"/)
  assert.match(snaps1[0].data.content[0].text, /prefers tabs over spaces/)
  assert.match(snaps1[0].data.source.label, /^recall - \d+ms$/, 'the row label is the lookup wall clock, e.g. "recall - 3ms"')
  assert.equal(snaps1[0].data.source.plugin, 'hindsight-advanced', 'the plugin stays the attribution identity beside the label')
  const autoReq = state.requests.filter(request =>
    request.path === '/v1/default/banks/hermes/memories/recall'
    && request.body.query === 'which editor does the user prefer?',
  ).at(-1)
  assert.ok(autoReq, 'the auto-recall hit the stub')
  const autoRulesReq = state.requests.filter(request => request.path === '/v1/default/banks/hermes/directives').at(-1)
  assert.ok(autoRulesReq, 'the auto-lookup also listed standing rules')
  assert.ok(autoRulesReq.query.includes('active_only=true'), 'only active rules are listed')
  assert.equal(deriveMessages(agent.session).length, 2, 'model context: the message + its snapshot')
  console.log('ok  mount A: auto-recall appends the snapshot after the message that triggered it')

  // Turn 2, different query: the new snapshot rides the decision again and is
  // APPENDED — the previous snapshot is never replaced or erased; the model
  // context accumulates both.
  await tool.execute({ action: 'retain', text: 'The demo build runs on Node 22.' }, { signal: baseSignal })
  const d2 = await runStep(listener, agent, 1, [userMsg('which node runtime does the demo build use?')])
  assert.equal(d2.messages.length, 2, 'the new snapshot rides the decision')
  const snaps2 = snapshots(agent.session)
  assert.equal(snaps2.length, 2, 'durable log keeps every snapshot')
  assert.equal(snaps2[0].surfaceOp, 'append', 'the old snapshot was appended, never replaced')
  assert.ok(onSurface(agent.session, snaps2[0]), 'the old snapshot stays on the model surface')
  assert.ok(onSurface(agent.session, snaps2[1]), 'the new snapshot is on the model surface')
  const modelSnaps2 = derivedSnapshots(agent.session)
  assert.equal(modelSnaps2.length, 2, 'the model context accumulates every recall')
  assert.match(modelSnaps2[1].content[0].text, /Node 22/, 'the newest snapshot is the latest recall')
  console.log('ok  mount A: turn 2 appends a new snapshot — the previous one is never erased')

  // Turn 3, empty recall: the existing snapshots stay in place, nothing new.
  const d3 = await runStep(listener, agent, 1, [userMsg('tell me a completely unrelated story about zzzzzz')])
  assert.equal(d3.messages.length, 1, 'an empty recall rides no snapshot')
  assert.equal(snapshots(agent.session).length, 2, 'an empty recall appends no snapshot')
  assert.match(derivedSnapshots(agent.session).at(-1).content[0].text, /Node 22/, 'the last snapshot remains in context')
  console.log('ok  mount A: an empty recall leaves the existing snapshots in place')

  // Unchanged snapshot: the duplicate block is not re-committed (no
  // churn) — but the turn still gets its row, the marker, naming the
  // applied memories one line each, so the UI shows what was applied
  // here and nothing looks skipped.
  const snapsUnchanged = snapshots(agent.session).length
  const d4unchanged = await runStep(listener, agent, 1, [userMsg('which node runtime does the demo build use?')])
  assert.equal(d4unchanged.messages.length, 2, 'an unchanged recall appends the marker row')
  assert.match(d4unchanged.messages.at(-1).content[0].text, /no new memories this turn/, 'the marker says the earlier snapshot stands')
  assert.match(d4unchanged.messages.at(-1).content[0].text, /- The demo build runs on Node 22\./, 'the marker names the applied memory')
  const afterMarker = snapshots(agent.session).length
  assert.equal(afterMarker, snapsUnchanged + 1, 'one marker row, no duplicate block')
  console.log('ok  mount A: an unchanged recall commits a marker naming the applied memories, not a duplicate block')

  // A HUMAN intervention claimed at step 2 recalls on the bounded
  // synchronous path, anchored on the steering itself (the loop skips the
  // turn-stop prefetch while a steer is queued, so the step owns no cache),
  // and commits its snapshot onto the step's decision. recallContextTurns: 1
  // makes the query exactly the anchor, so the stub sees the steer verbatim.
  const d4 = await runStep(listener, agent, 2, [userMsg('wait, the demo build must run on Node 22')])
  assert.equal(d4.messages.length, 2, 'the intervention snapshot rides the step decision')
  assert.match(d4.messages.at(-1).content[0].text, /Node 22/, 'the intervention recall names the matched memory')
  assert.match(d4.messages.at(-1).source.label, /^recall - \d+ms$/, 'the intervention row carries the same label')
  assert.equal(d4.messages.at(-1).source.plugin, 'hindsight-advanced', 'the plugin stays the attribution identity')
  const interventionReq = state.requests.filter(request =>
    request.path === '/v1/default/banks/hermes/memories/recall'
    && request.body.query === 'wait, the demo build must run on Node 22',
  ).at(-1)
  assert.ok(interventionReq, 'the intervention recall queried the steer itself')
  const afterIntervention = snapshots(agent.session).length
  assert.equal(afterIntervention, afterMarker + 1, 'the intervention commits its snapshot')
  // A step-2 claim WITHOUT a human message (plugin-injected context alone)
  // is not an intent: no recall, no snapshot.
  const injectedContext = { id: `inj${Math.random()}`, role: 'user', content: [{ type: 'text', text: 'injected plugin context' }], source: { kind: 'plugin', plugin: 'other-plugin', form: 'notice' } }
  const d4b = await runStep(listener, agent, 2, [injectedContext])
  assert.equal(d4b.messages.length, 1, 'a non-human step-2 claim rides no snapshot')
  assert.equal(snapshots(agent.session).length, afterIntervention, 'no recall for a plugin-context claim')
  // subagents pass through unchanged, without committing snapshots
  const d5 = await runStep(listener, subagent, 1, [userMsg('subagent work')])
  assert.equal(d5.messages.length, 1)
  assert.equal(snapshots(subagent.session).length, 0, 'subagents get no snapshot')
  // rejections pass through untouched
  const reject = await listener({ agent, messages: [userMsg('x')], turn: 9, step: 1, signal: baseSignal }, async () => ({ kind: 'reject' }))
  assert.equal(reject.kind, 'reject')
  console.log('ok  mount A: a human intervention at step 2 recalls; non-human claims, subagents, and rejections pass through')
}

// ── mount B: bank dsh-code — a separate bank is a separate surface ──────────
{
  const ctx = makeCtx()
  plugin.apply(ctx, validate({ bank: 'dsh-code', baseUrl: stubUrl }).value)
  const tool = ctx.tools.registered[0]

  await tool.execute({ action: 'retain', text: 'The demo project builds with pnpm and strict TS.' }, { signal: baseSignal })
  const retainReq = state.requests.at(-1)
  assert.equal(retainReq.path, '/v1/default/banks/dsh-code/memories')
  assert.deepEqual(retainReq.body, { items: [{ content: 'The demo project builds with pnpm and strict TS.' }] })
  console.log('ok  mount B: retain → POST /v1/default/banks/dsh-code/memories {items}')

  // sees its own bank, not mount A's hermes memory
  const own = await tool.execute({ action: 'recall', query: 'how does the demo build?' }, { agent: otherAgent, signal: baseSignal })
  assert.match(own.text, /builds with pnpm/)
  const cross = await tool.execute({ action: 'recall', query: 'which editor does the user prefer?' }, { signal: baseSignal })
  assert.equal(cross.text, 'no memories matched', 'dsh-code must not see hermes memories')
  console.log('ok  mount B: separate banks do not leak into each other')
}

// ── mount C: bankConfig — the server-side extraction policy, declarative ────
{
  const ctx = makeCtx()
  plugin.apply(ctx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'dsh-config',
    bankConfig: { retain_mission: 'Focus on coding decisions and project facts.', retain_extraction_mode: 'custom' },
  })
  const tool = ctx.tools.registered[0]

  // nothing is sent at mount time: the bank is server-side state and the
  // server may be down when the preset mounts
  assert.equal(state.requests.filter(request => request.method === 'PATCH').length, 0, 'no config PATCH at mount')

  // the first memory operation applies the declared bank config, then acts
  await tool.execute({ action: 'retain', text: 'The demo ships on the first of the month.' }, { signal: baseSignal })
  const patchReq = state.requests.filter(request => request.method === 'PATCH').at(-1)
  assert.equal(patchReq.path, '/v1/default/banks/dsh-config/config')
  assert.deepEqual(patchReq.body, { updates: { retain_mission: 'Focus on coding decisions and project facts.', retain_extraction_mode: 'custom' } })
  assert.equal(state.requests.at(-1).path, '/v1/default/banks/dsh-config/memories', 'the retain itself still went through')
  assert.deepEqual(state.bankConfigs['dsh-config'], { retain_mission: 'Focus on coding decisions and project facts.', retain_extraction_mode: 'custom' })
  console.log('ok  mount C: the first memory op PATCHes the declared bank config, then acts')

  // the config is durable server state: a later op does not re-apply it
  const patchCount = () => state.requests.filter(request => request.method === 'PATCH').length
  const before = patchCount()
  await tool.execute({ action: 'recall', query: 'when does the demo ship?' }, { signal: baseSignal })
  assert.equal(patchCount(), before, 'a synced config is not re-applied')
  console.log('ok  mount C: the config is applied once, not per operation')
}

// ── mount D: a failing config PATCH never blocks, and the next op retries ───
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'flaky', bankConfig: { retain_mission: 'x' } })
  const tool = ctx.tools.registered[0]

  // the failed PATCH is swallowed; the memory operation lands on its own
  const result = await tool.execute({ action: 'retain', text: 'Flaky bank memories still land.' }, { signal: baseSignal })
  assert.match(result.text, /stored/)
  assert.ok(state.memories.some(memory => memory.bank === 'flaky' && memory.text.includes('Flaky bank')))
  const flakyPatchCount = () => state.requests.filter(request => request.method === 'PATCH' && request.path === '/v1/default/banks/flaky/config').length
  assert.equal(flakyPatchCount(), 1, 'the first op attempted the config PATCH')

  // the next operation retries the sync (and still proceeds either way)
  await tool.execute({ action: 'recall', query: 'flaky memories' }, { signal: baseSignal })
  assert.equal(flakyPatchCount(), 2, 'a failed config PATCH is retried from the next operation')
  console.log('ok  mount D: a failing config PATCH never blocks a memory op; the next op retries')
}

// ── mount E: visibility tiers — one tier tag per item, recall ORs the tiers ─
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'tiers' })
  const tool = ctx.tools.registered[0]
  const listener = ctx.listeners[0].fn

  // the tool exposes the scope enum; raw tags never reach the model
  assert.deepEqual(tool.parameters.properties.scope.enum, ['global', 'preset', 'session'])
  assert.equal(tool.parameters.properties.tags, undefined, 'no raw tag parameter')

  // two sessions of one preset, one of another
  const alice = { session: makeSession('sess-a', { agentPreset: 'standard' }) }
  const bob = { session: makeSession('sess-b', { agentPreset: 'standard' }) }
  const carol = { session: makeSession('sess-c', { agentPreset: 'code' }) }
  const recallAs = (a, query) => tool.execute({ action: 'recall', query }, { agent: a, signal: baseSignal }).then(result => result.text)

  // scope omitted: the configured default (preset) tags the item
  await tool.execute({ action: 'retain', text: 'The standard preset team ships on Fridays.' }, { agent: alice, signal: baseSignal })
  assert.deepEqual(state.requests.at(-1).body.items, [{
    content: 'The standard preset team ships on Fridays.',
    tags: ['preset:standard'],
  }])

  // scope: 'global' — no tags at all (the bank's global scope)
  await tool.execute({ action: 'retain', text: 'The company office is in Lisbon.', scope: 'global' }, { agent: alice, signal: baseSignal })
  assert.deepEqual(state.requests.at(-1).body.items, [{ content: 'The company office is in Lisbon.' }])

  // scope: 'session' — exactly the session's own tag
  await tool.execute({ action: 'retain', text: 'Alice is prototyping a new onboarding flow.', scope: 'session' }, { agent: alice, signal: baseSignal })
  assert.deepEqual(state.requests.at(-1).body.items, [{
    content: 'Alice is prototyping a new onboarding flow.',
    tags: ['session:sess-a'],
  }])
  console.log('ok  mount E: retain tags the item with exactly one tier (preset default, global, session)')

  // a recall sends the session's two tiers, any-matched
  await tool.execute({ action: 'recall', query: 'fridays' }, { agent: alice, signal: baseSignal })
  const recallReq = state.requests.at(-1)
  assert.deepEqual(recallReq.body.tags, ['session:sess-a', 'preset:standard'])
  assert.equal(recallReq.body.tags_match, 'any')
  assert.deepEqual(recallReq.body.types, ['world', 'experience', 'observation'], 'tier filter rides with consolidation mode')
  assert.equal(recallReq.body.prefer_observations, true)

  // visibility matrix: own + preset + global are visible; another session's
  // or another preset's tier is not
  assert.match(await recallAs(alice, 'fridays'), /Fridays/)
  assert.match(await recallAs(bob, 'fridays'), /Fridays/, 'the same preset shares its tier')
  assert.equal(await recallAs(carol, 'fridays'), 'no memories matched', "another preset's tier is invisible")
  assert.match(await recallAs(carol, 'lisbon'), /Lisbon/, 'the global tier is visible to everyone')
  assert.match(await recallAs(alice, 'onboarding'), /onboarding flow/, 'the own session tier is visible')
  assert.equal(await recallAs(bob, 'onboarding'), 'no memories matched', "another session's tier is invisible")
  console.log('ok  mount E: recall sees own + preset + global tiers, never another session\'s or preset\'s')

  // reflect carries the same tier filter
  await tool.execute({ action: 'reflect', query: 'what do we know about fridays' }, { agent: alice, signal: baseSignal })
  const reflectReq = state.requests.at(-1)
  assert.deepEqual(reflectReq.body.tags, ['session:sess-a', 'preset:standard'])
  assert.equal(reflectReq.body.tags_match, 'any')
  console.log('ok  mount E: reflect carries the same tier filter as recall')

  // retainScope: 'session' — an omitted scope lands in the session tier
  const ctx2 = makeCtx()
  plugin.apply(ctx2, { ...standard.value, baseUrl: stubUrl, bank: 'tiers', retainScope: 'session' })
  const sessionTool = ctx2.tools.registered[0]
  await sessionTool.execute({ action: 'retain', text: 'Bob keeps his scratch notes in Notion.' }, { agent: bob, signal: baseSignal })
  assert.deepEqual(state.requests.at(-1).body.items, [{
    content: 'Bob keeps his scratch notes in Notion.',
    tags: ['session:sess-b'],
  }])
  assert.match(await recallAs(bob, 'notion scratch notes'), /Notion/, 'visible to its own session')
  assert.equal(await recallAs(alice, 'notion scratch notes'), 'no memories matched', '... and to no other session')
  console.log('ok  mount E: retainScope: session defaults an omitted scope to the session tier')

  // subagent tier leaning: the child's session tier is the parent's
  const child = { session: makeSession('sess-child', { origin: 'subagent', parentSession: 'sess-a', agentPreset: 'standard' }) }
  await tool.execute({ action: 'retain', text: 'The onboarding flow uses the blue theme.', scope: 'session' }, { agent: child, signal: baseSignal })
  assert.deepEqual(state.requests.at(-1).body.items, [{
    content: 'The onboarding flow uses the blue theme.',
    tags: ['session:sess-a'],
  }], 'a subagent leans at its parent session')
  assert.match(await recallAs(alice, 'blue theme'), /blue theme/, 'the parent sees the subagent\'s session-tier retain')
  assert.equal(await recallAs(bob, 'blue theme'), 'no memories matched', '... and a sibling session does not')
  console.log('ok  mount E: a subagent\'s session tier leans at the parent that delegated it')

  // the automatic pre-step recall is tier-scoped the same way
  const before = state.requests.length
  await runStep(listener, alice, 1, [userMsg('when does the team ship?')])
  const autoReq = state.requests[before]
  assert.deepEqual(autoReq.body.tags, ['session:sess-a', 'preset:standard'])
  assert.equal(autoReq.body.tags_match, 'any')
  assert.deepEqual(autoReq.body.types, ['world', 'experience', 'observation'], 'auto-recall also requests consolidation mode')
  assert.equal(autoReq.body.prefer_observations, true)
  assert.match(snapshots(alice.session)[0].data.content[0].text, /Fridays/)
  console.log('ok  mount E: the automatic pre-step recall is tier-scoped too')
}

// ── mount F: standing directives — rules are applied, not recalled ──────────
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'rules' })
  const tool = ctx.tools.registered[0]
  const listener = ctx.listeners[0].fn

  // the tool exposes kind + name for directive retains
  assert.deepEqual(tool.parameters.properties.kind.enum, ['memory', 'directive'])
  assert.ok(tool.parameters.properties.name, 'the name parameter exists for directives')

  const alice = { session: makeSession('sess-r1', { agentPreset: 'standard' }) }
  const carol = { session: makeSession('sess-r2', { agentPreset: 'code' }) }

  // a directive retained with the default scope lands with exactly the preset tier tag
  const directiveResult = await tool.execute(
    { action: 'retain', kind: 'directive', name: 'tabs', text: 'Always use tabs in this project.' },
    { agent: alice, signal: baseSignal },
  )
  assert.match(directiveResult.text, /standing directive "tabs"/)
  let req = state.requests.at(-1)
  assert.equal(req.method, 'POST')
  assert.equal(req.path, '/v1/default/banks/rules/directives')
  assert.deepEqual(req.body, { name: 'tabs', content: 'Always use tabs in this project.', is_active: true, tags: ['preset:standard'] })

  // scope: 'global' — untagged, visible to every session of the bank
  await tool.execute(
    { action: 'retain', kind: 'directive', name: 'no-force-push', text: 'Never force-push to shared branches.', scope: 'global' },
    { agent: alice, signal: baseSignal },
  )
  req = state.requests.at(-1)
  assert.deepEqual(req.body, { name: 'no-force-push', content: 'Never force-push to shared branches.', is_active: true })

  // a directive without a name is rejected before it touches the server
  await assert.rejects(
    () => tool.execute({ action: 'retain', kind: 'directive', text: 'A rule with no name.' }, { agent: alice, signal: baseSignal }),
    /name/,
  )

  // the pre-step listing is tier-scoped like recall; same preset sees the
  // preset rule + the global one
  await runStep(listener, alice, 1, [userMsg('what formatting rule applies here?')])
  const rulesReq = state.requests.filter(request => request.path === '/v1/default/banks/rules/directives').at(-1)
  assert.ok(rulesReq.query.includes('active_only=true'))
  assert.ok(rulesReq.query.includes(`${encodeURIComponent('session:sess-r1')},${encodeURIComponent('preset:standard')}`),
    'the listing carries the session tier tags')
  const aliceSnap = snapshots(alice.session).at(-1).data.content[0].text
  assert.match(aliceSnap, /Standing rules from the Hindsight bank "rules"/)
  assert.match(aliceSnap, /Always use tabs in this project/)
  assert.match(aliceSnap, /Never force-push to shared branches/)

  // another preset sees only the global rule
  await runStep(listener, carol, 1, [userMsg('what formatting rule applies here?')])
  const carolSnap = snapshots(carol.session).at(-1).data.content[0].text
  assert.match(carolSnap, /Never force-push to shared branches/, 'the global rule is visible to everyone')
  assert.doesNotMatch(carolSnap, /Always use tabs/, "another preset's rule is invisible")
  console.log('ok  mount F: directives carry the tier model; the pre-step listing is tier-scoped')

  // the core fix: a rule reaches the model even when the recall matched
  // nothing (rules are applied, not retrieved by relevance)
  const dave = { session: makeSession('sess-r3', { agentPreset: 'standard' }) }
  await runStep(listener, dave, 1, [userMsg('tell me a story about zzzzzz')])
  const daveSnap = snapshots(dave.session).at(-1)
  assert.ok(daveSnap, 'an empty recall still commits a snapshot when rules are active')
  assert.doesNotMatch(daveSnap.data.content[0].text, /Relevant memories/, 'no memory section when the recall is empty')
  assert.match(daveSnap.data.content[0].text, /Standing rules/)
  assert.match(daveSnap.data.content[0].text, /Always use tabs in this project/)
  console.log('ok  mount F: a standing rule reaches the model even on an empty recall')
}

// ── mount G: provenance — source facts render under their observation hit ───
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'provenance' })
  const tool = ctx.tools.registered[0]
  const listener = ctx.listeners[0].fn
  const alice = { session: makeSession('sess-g1', { agentPreset: 'standard' }) }

  // a raw world fact and the observation consolidated from it
  await tool.execute({ action: 'retain', text: 'The user works remotely from home.' }, { signal: baseSignal })
  await tool.execute({ action: 'retain', text: '[observation] The user is a remote worker based at home.' }, { signal: baseSignal })

  // the recall body requests the budgeted source-facts enrichment
  await tool.execute({ action: 'recall', query: 'remote worker' }, { agent: alice, signal: baseSignal })
  const recallReq = state.requests.at(-1)
  assert.deepEqual(recallReq.body.include, { source_facts: { max_tokens: 512 } }, 'source facts requested, budgeted')

  // the observation hit renders its backing fact UNDER it — with the
  // backing fact's id, the only curatable handle (the observation itself
  // renders NO id: it is derived and the bank refuses to curate it); the
  // raw fact hit gets no from line of its own (it is not an observation,
  // so the server backs nothing)
  const result = await tool.execute({ action: 'recall', query: 'remote worker' }, { agent: alice, signal: baseSignal })
  assert.match(result.text, /remote worker based at home\. \(observation\)/, 'the observation hit renders')
  assert.doesNotMatch(result.text, /remote worker based at home\. \(observation\) id:/, '... with NO id of its own (the trap handle)')
  assert.match(result.text, /from: id:m\d+/, 'its backing fact renders under it as its id (the curatable one)')
  assert.doesNotMatch(result.text, /from: The user works remotely/, '... with NO fact text (the observation already supersedes its sources)')
  assert.match(result.text, /works remotely from home\. \(world\) id:m\d+/, 'the raw fact carries its id')
  assert.doesNotMatch(result.text, /works remotely from home\. \(world\) id:m\d+\n  from:/, 'the raw fact gets no from line')
  console.log('ok  mount G: recall requests budgeted source facts; the observation renders no id of its own, only the from line with the backing fact\'s id')

  // the auto-recall snapshot carries the same provenance (id + from line)
  await runStep(listener, alice, 1, [userMsg('is the user a remote worker?')])
  const autoReq = state.requests.filter(request =>
    request.path === '/v1/default/banks/provenance/memories/recall',
  ).at(-1)
  assert.deepEqual(autoReq.body.include, { source_facts: { max_tokens: 512 } }, 'auto-recall requests source facts too')
  const snap = snapshots(alice.session).at(-1).data.content[0].text
  assert.doesNotMatch(snap, /remote worker based at home\. \(observation\) id:/, 'the snapshot observation carries no id of its own')
  assert.match(snap, /from: id:m\d+/, 'its from line (the backing fact\'s id) lands in the snapshot')
  assert.doesNotMatch(snap, /from: The user works remotely/, '... with no duplicated fact text')
  console.log('ok  mount G: the automatic snapshot carries provenance (from line with the backing fact\'s id) too')
}

// ── mount H: curation — the model retires a memory it has shown to be wrong ─
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'curation' })
  const tool = ctx.tools.registered[0]

  // a memory the conversation later contradicts
  await tool.execute({ action: 'retain', text: 'The project uses a Postgres database at home.' }, { signal: baseSignal })

  // the id the model acts on is the one the recall result rendered
  const recallText = (await tool.execute({ action: 'recall', query: 'which database does the project use' }, { signal: baseSignal })).text
  const match = recallText.match(/id:(m\d+)/)
  assert.ok(match, `the recall result carries the id to invalidate: ${recallText}`)
  const memoryId = match[1]

  // read → a GET that resolves the rendered id to its text and type — the
  // disambiguation step for an invalidation the model is not sure about
  const read = await tool.execute({ action: 'read', id: memoryId }, { signal: baseSignal })
  assert.equal(read.action, 'read')
  const readReq = state.requests.at(-1)
  assert.equal(readReq.method, 'GET')
  assert.equal(readReq.path, `/v1/default/banks/curation/memories/${memoryId}`)
  assert.match(read.text, new RegExp(`Postgres database at home\\. \\(world\\) id:${memoryId}`))
  console.log('ok  mount H: read resolves the fact id to its text and type (world)')

  // invalidate → a PATCH with the soft-retire state and the recorded reason
  const result = await tool.execute(
    { action: 'invalidate', id: memoryId, reason: 'corrected by the user: the project moved to MySQL' },
    { signal: baseSignal },
  )
  const patchReq = state.requests.at(-1)
  assert.equal(patchReq.method, 'PATCH')
  assert.equal(patchReq.path, `/v1/default/banks/curation/memories/${memoryId}`)
  assert.deepEqual(patchReq.body, { state: 'invalidated', reason: 'corrected by the user: the project moved to MySQL' })
  assert.match(result.text, new RegExp(`memory ${memoryId} invalidated`))

  // a soft retire, not a shred: the memory is excluded from recall now
  const after = (await tool.execute({ action: 'recall', query: 'which database does the project use' }, { signal: baseSignal })).text
  assert.equal(after, 'no memories matched')
  console.log('ok  mount H: invalidate PATCHes the memory (state + reason) and it leaves the recall surface')

  // an unknown id is a clean bounded error, like every other mount operation
  await assert.rejects(
    () => tool.execute({ action: 'invalidate', id: 'm-none', reason: 'wrong id probe' }, { signal: baseSignal }),
    /hindsight: .*returned HTTP 404/,
  )
  console.log('ok  mount H: an unknown id degrades to the clean bounded error')

  // read shares the same bounded 404 degradation
  await assert.rejects(
    () => tool.execute({ action: 'read', id: 'm-none' }, { signal: baseSignal }),
    /hindsight: .*returned HTTP 404/,
  )
  console.log('ok  mount H: a read of an unknown id degrades to the same clean bounded error')

  // the hit the model usually sees is the CONSOLIDATED observation — the
  // only curatable handle in the pair is its backing fact, on the from:
  // line; the observation itself renders no id to pass to invalidate
  await tool.execute({ action: 'retain', text: 'The billing service is written in Go.' }, { signal: baseSignal })
  await tool.execute({ action: 'retain', text: '[observation] The billing service language is Go.' }, { signal: baseSignal })
  const obsText = (await tool.execute({ action: 'recall', query: 'billing service' }, { signal: baseSignal })).text
  assert.doesNotMatch(obsText, /\(observation\) id:/, 'the observation hit shows no id of its own')
  const backingId = obsText.match(/from: id:(m\d+)/)?.[1]
  assert.ok(backingId, `the from line carries the one id handle: ${obsText}`)

  // read of the observation's OWN id (held from an earlier snapshot): the
  // backing fact comes back WITH its text — unlike recall's ids-only from
  // line, this is the disambiguation call whose job is to show what each id
  // actually says before the model picks which to invalidate
  const obsMemory = [...state.memories].reverse().find(candidate => candidate.bank === 'curation' && candidate.observation)
  const obsRead = await tool.execute({ action: 'read', id: obsMemory.id }, { signal: baseSignal })
  assert.match(obsRead.text, new RegExp(`billing service language is Go\\. \\(observation\\) id:${obsMemory.id}`))
  assert.match(obsRead.text, new RegExp(`from:\\s*- id:${backingId} — "The billing service is written in Go\\."`))
  console.log('ok  mount H: read of the observation id resolves its backing fact WITH its text')

  // read of the backing fact's id: the "read each id" step of a multi-id
  // invalidation — the fact resolves to its own text and type
  const backingRead = await tool.execute({ action: 'read', id: backingId }, { signal: baseSignal })
  assert.match(backingRead.text, new RegExp(`billing service is written in Go\\. \\(world\\) id:${backingId}`))
  console.log('ok  mount H: read of the backing fact id resolves its own text and type')

  // the model can still be handed the observation's OWN id (a snapshot
  // committed earlier in the session predates the no-id rendering): the
  // bank refuses it, and the plugin surfaces the refusal as the
  // instruction it should have been, not a raw HTTP 400
  await assert.rejects(
    () => tool.execute({ action: 'invalidate', id: obsMemory.id, reason: 'derived, not curatable' }, { signal: baseSignal }),
    /is a derived observation.*backing fact.*from:/,
  )
  console.log('ok  mount H: invalidating a derived observation is refused with an actionable pointer to its backing fact')

  // invalidating the backing fact: the observation still surfaces, but its
  // from line is pruned (the source fact is no longer a source fact)
  await tool.execute({ action: 'invalidate', id: backingId, reason: 'the service was rewritten in Rust' }, { signal: baseSignal })
  const afterObs = (await tool.execute({ action: 'recall', query: 'billing service' }, { signal: baseSignal })).text
  assert.match(afterObs, /billing service language is Go\. \(observation\)/, 'the observation still surfaces')
  assert.doesNotMatch(afterObs, /billing service language is Go\. \(observation\) id:/, '... still with no id of its own')
  assert.doesNotMatch(afterObs, /from:/, '... and its from line is gone')
  console.log('ok  mount H: invalidating the backing fact prunes the from line, the observation stays')
}

// ── mount I: the turn-stop prefetch — the recall runs in the user's think time ──
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'prefetch' })
  const preStep = ctx.listeners[0].fn
  const turnStopping = ctx.listeners[1].fn
  const tool = ctx.tools.registered[0]
  assert.deepEqual(
    ctx.listeners.map(entry => entry.event),
    ['agent/pre-step', 'agent/turn-stopping', 'agent/disposed'],
    'the mount registers pre-step (consumer), turn-stopping (producer), disposed (cleanup)',
  )
  assert.deepEqual(ctx.listeners[0].options, { prepend: true })

  const alice = { session: makeSession('sess-p1', { agentPreset: 'standard' }) }
  const recallPath = '/v1/default/banks/prefetch/memories/recall'
  const recallCount = () => state.requests.filter(request => request.path === recallPath).length
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async (predicate, ms = 1000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(5)
    }
    return predicate()
  }

  // Turn 1 has no cache yet: the original bounded synchronous path. The
  // bank is held slow for a moment so the turn-stopping job's recall
  // lands AFTER the extra retain below — the cached snapshot then differs
  // from turn 1's and commits on turn 2 instead of skipping as identical.
  await tool.execute({ action: 'retain', text: 'The project uses a Postgres database.' }, { signal: baseSignal })
  state.recallDelayMs = 60
  await runStep(preStep, alice, 1, [userMsg('which database does the project use')])
  assert.equal(recallCount(), 1, 'turn 1 takes the synchronous path (no slot yet)')
  const first = snapshots(alice.session).at(-1)
  assert.ok(first, 'turn 1 commits a snapshot')
  assert.doesNotMatch(first.data.content[0].text, /managed/, 'turn 1 saw only the first memory')

  // Turn stop: the detached job starts for the turn's own message. The
  // event is awaited at the boundary, so the listener must return at once.
  assert.equal(
    turnStopping({ agent: alice, turn: 1, signal: baseSignal }),
    undefined,
    'turn-stopping returns immediately (the job is detached)',
  )

  // While the job's recall is held (60 ms) an extra retain lands in the
  // bank — the job sees it when its response releases.
  await tool.execute({ action: 'retain', text: 'The project database runs on managed Postgres.' }, { signal: baseSignal })
  assert.ok(await waitFor(() => recallCount() === 2), 'the detached job issued its recall')
  assert.equal(
    state.requests.filter(request => request.path === recallPath).at(-1).body.query,
    'which database does the project use',
    'the job queried the turn\'s own human message (snapshots are not queries)',
  )

  // Turn 2 consumes the cache: no bank call at the step, and the cached
  // result commits a snapshot (its view of the bank differs from turn 1's).
  const before = recallCount()
  await runStep(preStep, alice, 1, [userMsg('how is the database hosted?')])
  assert.equal(recallCount(), before, 'turn 2\'s step issued no bank call')
  const second = snapshots(alice.session).at(-1)
  assert.ok(second, 'turn 2 commits a snapshot from the cache')
  assert.match(second.data.content[0].text, /managed Postgres/, 'the cached snapshot carries the job\'s view of the bank')
  assert.match(second.data.source.label, /^recall - \d+ms$/, 'the cached snapshot carries the job wall clock as its row label')
  state.recallDelayMs = 0

  // An unchanged cached recall commits no duplicate block (no churn): the
  // job for turn 2's message matches the same two memories, so the
  // rendering is identical to the snapshot just committed — the step
  // commits the marker row instead, and still makes no bank call.
  assert.equal(turnStopping({ agent: alice, turn: 2, signal: baseSignal }), undefined)
  assert.ok(await waitFor(() => recallCount() === before + 1), 'the turn-2 job issued its recall')
  const snapshotCount = snapshots(alice.session).length
  const turn3 = await runStep(preStep, alice, 1, [userMsg('and anything else about the database?')])
  assert.equal(turn3.messages.length, 2, 'the unchanged turn appends the marker row')
  assert.match(turn3.messages.at(-1).content[0].text, /no new memories this turn/, 'the marker says the earlier snapshot stands')
  assert.match(turn3.messages.at(-1).content[0].text, /- The project database runs on managed Postgres\./, 'the marker names the applied memories')
  assert.equal(snapshots(alice.session).length, snapshotCount + 1, 'one marker row, no duplicate block')
  assert.equal(recallCount(), before + 1, 'and the step issued no bank call')

  // A bank slower than the budget: the cached job is not ready in time, so
  // the step discards it and proceeds without memory — the same cost as a
  // slow server on the synchronous path, minus the attempt that already ran.
  const ctxSlow = makeCtx()
  plugin.apply(ctxSlow, { ...standard.value, baseUrl: stubUrl, bank: 'prefetch-slow', autoContextTimeoutMs: 120 })
  const preStepSlow = ctxSlow.listeners[0].fn
  const turnStoppingSlow = ctxSlow.listeners[1].fn
  const dave = { session: makeSession('sess-p5', { agentPreset: 'standard' }) }
  const slowRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/prefetch-slow/memories/recall').length
  state.recallDelayMs = 2000
  await runStep(preStepSlow, dave, 1, [userMsg('hello zzzz')])
  assert.equal(slowRecalls(), 1, 'turn 1\'s synchronous lookup hit the budget (no snapshot)')
  assert.equal(snapshots(dave.session).length, 0)
  turnStoppingSlow({ agent: dave, turn: 1, signal: baseSignal })
  assert.ok(await waitFor(() => slowRecalls() === 2), 'the job\'s recall is in flight (held)')
  await runStep(preStepSlow, dave, 1, [userMsg('second turn yyy')])
  assert.equal(slowRecalls(), 2, 'turn 2\'s step issued no new request (the job is still held)')
  assert.equal(snapshots(dave.session).length, 0, '...and no snapshot: not ready in time, discarded')
  state.recallDelayMs = 0

  // A failed job deletes its own slot: the next step falls back to a fresh
  // bounded synchronous lookup — and the failure stays contained.
  const ctx2 = makeCtx()
  plugin.apply(ctx2, { ...standard.value, baseUrl: stubUrl, bank: 'broken' })
  const preStep2 = ctx2.listeners[0].fn
  const turnStopping2 = ctx2.listeners[1].fn
  const bob = { session: makeSession('sess-p2') }
  const brokenRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/broken/memories/recall').length
  await runStep(preStep2, bob, 1, [userMsg('anything at all')])
  assert.equal(brokenRecalls(), 1, 'turn 1 tried (and failed) the synchronous lookup')
  assert.equal(snapshots(bob.session).length, 0)
  turnStopping2({ agent: bob, turn: 1, signal: baseSignal })
  assert.ok(await waitFor(() => brokenRecalls() === 2), 'the job tried (and failed) too')
  await runStep(preStep2, bob, 1, [userMsg('the next turn now')])
  assert.equal(brokenRecalls(), 3, 'the failed job left no slot: turn 2 took a FRESH synchronous lookup')
  assert.equal(snapshots(bob.session).length, 0, '...and the failure stayed contained (no snapshot, no crash)')

  // Subagent turns never start a prefetch (auto-recall stays skipped there).
  const ctx3 = makeCtx()
  plugin.apply(ctx3, { ...standard.value, baseUrl: stubUrl, bank: 'prefetch-sub' })
  const turnStopping3 = ctx3.listeners[1].fn
  const child = { session: makeSession('sess-p3', { origin: 'subagent', agentPreset: 'standard' }) }
  child.session.append('user/message', userMsg('subagent task'), { surfaceOp: 'append' })
  assert.equal(turnStopping3({ agent: child, turn: 1, signal: baseSignal }), undefined)
  await sleep(50)
  assert.equal(
    state.requests.filter(request => request.path.includes('/banks/prefetch-sub/')).length,
    0,
    'no prefetch request for a subagent session',
  )

  // prefetch: false — the gate: no job ever starts, and every turn takes
  // the synchronous path, whose query is the CURRENT message (pinned to
  // recallContextTurns: 1 — this check asserts the single-message query;
  // the composed one is mount J's territory).
  const ctx5 = makeCtx()
  plugin.apply(ctx5, { ...standard.value, baseUrl: stubUrl, bank: 'prefetch-off', prefetch: false, recallContextTurns: 1 })
  const preStep5 = ctx5.listeners[0].fn
  const turnStopping5 = ctx5.listeners[1].fn
  const erin = { session: makeSession('sess-p6', { agentPreset: 'standard' }) }
  const offRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/prefetch-off/memories/recall').length
  await ctx5.tools.registered[0].execute({ action: 'retain', text: 'The project uses a Postgres database.' }, { signal: baseSignal })
  await runStep(preStep5, erin, 1, [userMsg('first question about the database')])
  assert.equal(offRecalls(), 1, 'turn 1 takes the synchronous path')
  assert.equal(
    state.requests.filter(request => request.path === '/v1/default/banks/prefetch-off/memories/recall').at(-1).body.query,
    'first question about the database',
    'the synchronous query is the CURRENT message',
  )
  assert.equal(turnStopping5({ agent: erin, turn: 1, signal: baseSignal }), undefined)
  await sleep(50)
  assert.equal(offRecalls(), 1, 'prefetch: false starts no turn-stop job')
  await runStep(preStep5, erin, 1, [userMsg('second question about the database')])
  assert.equal(offRecalls(), 2, 'turn 2 takes a fresh synchronous lookup (no slot was left)')
  assert.equal(
    state.requests.filter(request => request.path === '/v1/default/banks/prefetch-off/memories/recall').at(-1).body.query,
    'second question about the database',
    '...querying its own current message',
  )

  // Disposal clears the slot: the next step takes the synchronous path.
  const ctx4 = makeCtx()
  plugin.apply(ctx4, { ...standard.value, baseUrl: stubUrl, bank: 'prefetch-discard' })
  const preStep4 = ctx4.listeners[0].fn
  const turnStopping4 = ctx4.listeners[1].fn
  const disposed = ctx4.listeners[2].fn
  const carol = { session: makeSession('sess-p4', { agentPreset: 'standard' }) }
  const discardRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/prefetch-discard/memories/recall').length
  await ctx4.tools.registered[0].execute({ action: 'retain', text: 'The project uses a Postgres database.' }, { signal: baseSignal })
  await runStep(preStep4, carol, 1, [userMsg('nothing to see here')])
  assert.equal(discardRecalls(), 1, 'turn 1\'s synchronous lookup (no match, no snapshot)')
  assert.equal(snapshots(carol.session).length, 0)
  turnStopping4({ agent: carol, turn: 1, signal: baseSignal })
  assert.ok(await waitFor(() => discardRecalls() === 2), 'the job ran for the empty turn')
  disposed({ agent: carol })
  await runStep(preStep4, carol, 1, [userMsg('which database does the project use')])
  assert.equal(discardRecalls(), 3, 'the slot was cleared: turn 2 took a fresh synchronous lookup')
  const carolSnap = snapshots(carol.session).at(-1)
  assert.ok(carolSnap && carolSnap.data.content[0].text.includes('Postgres database'), 'the fresh lookup committed a snapshot')
  console.log('ok  mount I: turn-stop prefetch — cached consumption without a bank call, the job queries the turn\'s own human message, an unchanged recall commits a marker row, a too-slow job is discarded, a failed job falls back, subagents never prefetch, prefetch: false gates the job off, disposal clears the slot')
}

// ── mount J: recallContextTurns (default 5) — the `Prior context:` query ──
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'context' })
  const listener = ctx.listeners[0].fn
  const turnStopping = ctx.listeners[1].fn
  const tool = ctx.tools.registered[0]
  const recallPath = '/v1/default/banks/context/memories/recall'
  const recallCount = () => state.requests.filter(request => request.path === recallPath).length
  const lastQuery = () => state.requests.filter(request => request.path === recallPath).at(-1)?.body.query
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async (predicate, ms = 1000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(5)
    }
    return predicate()
  }
  // The loop never appends assistant rows (the model does, not the test's
  // stand-in) — seed them the way the durable log carries them.
  const assistantMsg = (text) => ({ turn: 1, step: 1, message: { id: `a${Math.random()}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } })

  const gracie = { session: makeSession('sess-c1', { agentPreset: 'standard' }) }

  // A memory whose words appear ONLY in the prior context, never in the
  // anchor — proof that the composed lines are what really gets queried.
  await tool.execute({ action: 'retain', text: 'The demo build pipeline was retired for CI.' }, { signal: baseSignal })

  // Synchronous path: the anchor is NOT on the log yet (pre-step fires
  // before the turn's messages are appended), so the log holds the prior
  // turns only and all of them count toward the window.
  gracie.session.append('user/message', userMsg('set up the build pipeline'))
  gracie.session.append('assistant/message', assistantMsg('Done — the pipeline uses Makefile targets.'))
  gracie.session.append('user/message', userMsg('now add tests for it'))
  gracie.session.append('assistant/message', assistantMsg('Added the Makefile test targets.'))
  await runStep(listener, gracie, 1, [userMsg('which cache did the old prototype use')])
  assert.equal(
    lastQuery(),
    'Prior context:\n\n'
      + 'user: set up the build pipeline\n'
      + 'assistant: Done — the pipeline uses Makefile targets.\n'
      + 'user: now add tests for it\n'
      + 'assistant: Added the Makefile test targets.\n'
      + '\nwhich cache did the old prototype use',
    'the synchronous query is the anchor under the prior context',
  )
  const gracieSnap = snapshots(gracie.session).at(-1)
  assert.match(gracieSnap.data.content[0].text, /demo build pipeline/, 'a context-only word ("pipeline") hit the bank through the composed query')
  console.log('ok  mount J: the synchronous query carries the prior turns under `Prior context:` (default 5)')

  // Prefetch path: the anchor IS the log's last human message — its turn
  // counts toward the window, its own user line is dropped (it is the tail),
  // and its assistant reply becomes the newest context line.
  gracie.session.append('assistant/message', assistantMsg('The old prototype used a Redis cache.'))
  assert.equal(turnStopping({ agent: gracie, turn: 1, signal: baseSignal }), undefined)
  assert.ok(await waitFor(() => recallCount() === 2), 'the detached job issued its recall')
  assert.equal(
    lastQuery(),
    'Prior context:\n\n'
      + 'user: set up the build pipeline\n'
      + 'assistant: Done — the pipeline uses Makefile targets.\n'
      + 'user: now add tests for it\n'
      + 'assistant: Added the Makefile test targets.\n'
      + 'assistant: The old prototype used a Redis cache.\n'
      + '\nwhich cache did the old prototype use',
    'the job anchor keeps its own line out of the context',
  )
  console.log('ok  mount J: the prefetch query composes the anchor turn in (its reply is context, its line is not)')

  // The cap: the anchor is kept whole and the OLDEST context line drops
  // first — here the whole prior user line, keeping only the newer one.
  const hank = { session: makeSession('sess-c2', { agentPreset: 'standard' }) }
  const longUser = `context line alpha `.repeat(30).trim()
  const longAssistant = `context line beta `.repeat(25).trim()
  hank.session.append('user/message', userMsg(longUser))
  hank.session.append('assistant/message', assistantMsg(longAssistant))
  await runStep(listener, hank, 1, [userMsg('final question about the cache')])
  assert.equal(
    lastQuery(),
    `Prior context:\n\nassistant: ${longAssistant}\n\nfinal question about the cache`,
    'over the cap, the oldest line drops and the anchor stays whole',
  )

  // If even the newest line alone does not fit, no context survives — the
  // query falls back to the anchor (capped as before).
  const ivy = { session: makeSession('sess-c3', { agentPreset: 'standard' }) }
  ivy.session.append('user/message', userMsg(`huge context `.repeat(120).trim()))
  await runStep(listener, ivy, 1, [userMsg('one short question')])
  assert.equal(lastQuery(), 'one short question', 'no context fits under the cap → the anchor alone')

  // recallContextTurns: 1 (the reference default): the single-message
  // query, even with prior turns on the log.
  const ctxOne = makeCtx()
  plugin.apply(ctxOne, { ...standard.value, baseUrl: stubUrl, bank: 'context-one', recallContextTurns: 1 })
  const judy = { session: makeSession('sess-c4', { agentPreset: 'standard' }) }
  judy.session.append('user/message', userMsg('set up the build pipeline'))
  await runStep(ctxOne.listeners[0].fn, judy, 1, [userMsg('one short question')])
  assert.equal(
    state.requests.filter(request => request.path === '/v1/default/banks/context-one/memories/recall').at(-1).body.query,
    'one short question',
    'recallContextTurns: 1 leaves the single-message query',
  )
  console.log('ok  mount J: over the cap the oldest context drops (the anchor stays whole); recallContextTurns: 1 is the single-message query')
}

// ── mount K: recallPreserve: false — the surface carries only the LATEST snapshot ──
{
  // A token-meter stub prices the shadow: a finite estimate per message.
  const ctx = makeCtx({ tokenMeter: { estimateMessage: () => 7 } })
  plugin.apply(ctx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'preserve-off',
    recallPreserve: false,
    recallContextTurns: 1,
    prefetch: false,
  })
  const listener = ctx.listeners[0].fn
  const tool = ctx.tools.registered[0]
  const kate = { session: makeSession('sess-k') }

  // Two memories, each matched by one turn's query and never the other's.
  await tool.execute({ action: 'retain', text: 'User K prefers tabs over spaces in the editor.' }, { signal: baseSignal })
  await tool.execute({ action: 'retain', text: 'Project kbuild compiles with strict pnpm.' }, { signal: baseSignal })

  // Turn 1 (no snapshot yet): a plain append — but committed DIRECTLY by
  // the plugin, not on the pre-step decision, so it lands on the surface
  // BEFORE the triggering message (the placement difference vs preserve
  // mode) and the decision carries only the turn's message.
  const d1 = await runStep(listener, kate, 1, [userMsg('which editor does user K prefer?')])
  assert.equal(d1.kind, 'enter')
  assert.equal(d1.messages.length, 1, 'the first snapshot commits directly — it never rides the decision')
  const snaps1 = snapshots(kate.session)
  assert.equal(snaps1.length, 1)
  assert.equal(snaps1[0].surfaceOp, 'append', 'the first snapshot is a plain append')
  assert.ok(onSurface(kate.session, snaps1[0]))
  assert.equal(kate.session.surface.nodes[0], snaps1[0].seq, 'the snapshot lands before the triggering message')
  assert.match(snaps1[0].data.content[0].text, /prefers tabs over spaces/)
  assert.equal(deriveMessages(kate.session).length, 2, 'model context: the snapshot + the message')
  console.log('ok  mount K: the first snapshot is a plain append, committed before the message (direct, not via the decision)')

  // Turn 2 (different recall): the previous full card is RETIRED in place
  // — a tiny `form: 'notice'` tombstone marker takes its slot (shadow-
  // priced by a log-only compaction/prune appended immediately before),
  // while the FULL new snapshot rides the pre-step decision and is
  // appended as a fresh card after this turn's message. The durable log
  // keeps every full snapshot.
  const d2 = await runStep(listener, kate, 1, [userMsg('how does kbuild compile?')])
  assert.equal(d2.messages.length, 2, 'the fresh full snapshot rides the decision; the retirement commits directly')
  const snaps2 = snapshots(kate.session)
  assert.equal(snaps2.length, 2, 'the durable log keeps both full snapshots')
  const oldSnap = snaps2[0]
  const newSnap = snaps2[1]
  assert.ok(!onSurface(kate.session, oldSnap), 'the old full card is retired from the surface')
  assert.ok(onSurface(kate.session, newSnap), 'the fresh full card is on the surface')
  assert.equal(newSnap.surfaceOp, 'append', 'the fresh card is a plain append at its own turn')
  assert.match(newSnap.data.content[0].text, /compiles with strict pnpm/)
  assert.equal(kate.session.surface.nodes[kate.session.surface.nodes.length - 1], newSnap.seq, 'the fresh card lands AFTER the triggering message')
  const tombstones = kate.session.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'plugin' && event.data.source.form === 'notice')
  assert.equal(tombstones.length, 1, 'one tombstone for one retirement')
  const tomb = tombstones[0]
  assert.deepEqual(tomb.surfaceOp, { op: 'replace', startSeq: oldSnap.seq, endSeq: oldSnap.seq }, 'the tombstone takes the old card\'s slot')
  assert.deepEqual(tomb.sourceEventSeqs, [oldSnap.seq], 'the replace cites the shadowed node')
  assert.ok(onSurface(kate.session, tomb))
  assert.equal(kate.session.surface.nodes[0], tomb.seq, 'the tombstone sits in place — before both messages, at the turn that recalled')
  assert.equal(tomb.data.source.plugin, 'hindsight-advanced')
  assert.match(tomb.data.content[0].text, /preserve-off/, 'the tombstone names the bank')
  assert.match(tomb.data.content[0].text, /refreshed/)
  assert.ok(typeof tomb.data.source.summary === 'string' && tomb.data.source.summary.length > 0 && tomb.data.source.summary.length <= 120, 'the collapsed row\'s one-line account, bounded')
  assert.equal(kate.session.surface.nodes.length, 4, 'the surface: tombstone, both user messages, fresh full card')
  const prunes = kate.session.events.filter(event => event.type === 'compaction/prune')
  assert.equal(prunes.length, 1, 'one shadow price for one retirement')
  assert.deepEqual(prunes[0].data, {
    shadowedRange: { start: oldSnap.seq, end: oldSnap.seq },
    shadowedSeqs: [oldSnap.seq],
    shadowedTokenCount: 7,
  })
  assert.equal(kate.session.events.indexOf(prunes[0]), kate.session.events.indexOf(tomb) - 1, 'the price is appended immediately before the tombstone (the meter fold requires the adjacency)')
  assert.equal(kate.session.surface.nodes.includes(prunes[0].seq), false, 'the price is log-only, never a surface node')
  console.log('ok  mount K: a new recall retires the old card in place (tombstone, shadow-priced) and lands fresh at its own turn (log keeps both)')

  // Turn 3 (identical recall): nothing is committed — the full card is
  // already current, and retiring it would be churn (a second tombstone
  // would dangle, pointing at the card it just removed).
  const d3 = await runStep(listener, kate, 1, [userMsg('how does kbuild compile?')])
  assert.equal(d3.messages.length, 1, 'no duplicate card, no dangling tombstone')
  assert.equal(snapshots(kate.session).length, 2, 'an unchanged recall commits nothing in replace mode')
  assert.equal(kate.session.events.filter(event => event.data.source?.kind === 'plugin' && event.data.source.form === 'notice').length, 1, 'no second tombstone either')
  assert.equal(kate.session.events.filter(event => event.type === 'compaction/prune').length, 1, 'no second price either')
  assert.equal(kate.session.surface.nodes.length, 5, 'only the turn\'s message was appended')
  assert.equal(kate.session.surface.nodes[0], tomb.seq, 'the tombstone stays in place')
  assert.equal(kate.session.surface.nodes[3], newSnap.seq, 'the current full card stays at its turn (before the new message)')
  console.log('ok  mount K: an unchanged recall commits nothing (the snapshot is already current)')

  // Degrade: a session that refuses the replace append falls back to the
  // append-only path (the turn never breaks): no tombstone lands, the old
  // full card stays, and the fresh full card rides the decision; the
  // orphaned compaction/prune left behind is harmless (the meter drops
  // the claim on the next event).
  const flaky = makeSession('sess-k2')
  const realAppend = flaky.append.bind(flaky)
  flaky.append = (type, data, opts = {}) => {
    if (typeof opts.surfaceOp === 'object') throw new Error('surface: replace refused')
    return realAppend(type, data, opts)
  }
  const den = { session: flaky }
  await runStep(listener, den, 1, [userMsg('which editor does user K prefer?')])
  const denSnaps = snapshots(flaky)
  assert.equal(denSnaps.length, 1)
  assert.equal(denSnaps[0].surfaceOp, 'append', 'turn 1 (no prior snapshot) is a plain append')
  assert.ok(onSurface(flaky, denSnaps[0]))
  const d2den = await runStep(listener, den, 1, [userMsg('how does kbuild compile?')])
  assert.equal(d2den.messages.length, 2, 'the failed retirement degrades: the full snapshot rides the decision')
  const denSnaps2 = snapshots(flaky)
  assert.equal(denSnaps2.length, 2)
  assert.ok(onSurface(flaky, denSnaps2[0]), 'the old full card stays')
  assert.ok(onSurface(flaky, denSnaps2[1]), 'the degraded fresh card is appended, both on the surface')
  assert.equal(denSnaps2[1].surfaceOp, 'append')
  assert.equal(flaky.events.filter(event => event.data.source?.kind === 'plugin' && event.data.source.form === 'notice').length, 0, 'no tombstone when the replace is refused')
  assert.equal(flaky.events.filter(event => event.type === 'compaction/prune').length, 1, 'the orphaned price stays in the log (harmless)')
  assert.equal(flaky.surface.nodes.length, 4, 'old card, message, fresh card, message')
  console.log('ok  mount K: a refused retirement degrades to the append path (turn never breaks, orphaned price harmless)')
}

// ── mount L: mid-step agent-output recall (recallAfterText / recallAfterReasoning) ──
{
  // L-main: recallAfterText on. A LATER step whose claim carries no human
  // message recalls, anchored on the previous step's committed TEXT blocks:
  // the row is labeled recall:text, the anchor's own line is dropped from
  // the context, the current turn's human line stays.
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'midstep', prefetch: false, recallAfterText: true })
  const listener = ctx.listeners[0].fn
  const tool = ctx.tools.registered[0]
  const lynn = { session: makeSession('sess-l1') }
  const midstepRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/midstep/memories/recall')
  await tool.execute({ action: 'retain', text: 'The lint config forbids var declarations.' }, { signal: baseSignal })

  const d1 = await runStepAt(listener, lynn, 1, 1, [userMsg('check the lint config')])
  assert.equal(d1.kind, 'enter')
  assert.equal(d1.messages.length, 2, 'turn 1 (step 1) recalls synchronously; the snapshot rides the decision')
  assert.equal(snapshots(lynn.session).length, 1)
  assert.match(snapshots(lynn.session)[0].data.source.label, /^recall - \d+ms$/, 'the turn-1 row keeps the plain label')

  // Step 1 commits thinking, visible text, and a tool call.
  asstStep(lynn.session, 1, 1, [
    thinkBlock('I should check the var declarations across the repo files.'),
    textBlock('Reading the lint config to check for var declarations.'),
    toolCallBlock('read'),
  ])

  // Step 2, empty claim: the mid-step recall anchors on the step-1 TEXT.
  const d2 = await runStepAt(listener, lynn, 1, 2, [])
  assert.equal(d2.kind, 'enter')
  assert.equal(d2.messages.length, 1, 'the claim was empty; only the mid-step snapshot rides the decision')
  const snaps2 = snapshots(lynn.session)
  assert.equal(snaps2.length, 2)
  assert.match(snaps2[1].data.source.label, /^recall:text - \d+ms$/, 'the mid-step row is labeled by the anchor kind')
  assert.equal(snaps2[1].data.source.plugin, 'hindsight-advanced', 'the plugin stays the attribution identity')
  assert.equal(midstepRecalls().length, 2, 'exactly one new recall for the mid-step')
  assert.equal(
    midstepRecalls().at(-1).body.query,
    'Prior context:\n\nuser: check the lint config\n\nReading the lint config to check for var declarations.',
    'the anchor is the query tail: its own line is dropped, the turn human line kept',
  )

  // Step 2 commits reasoning only: no enabled kind present, no anchor, the
  // step passes through.
  asstStep(lynn.session, 1, 2, [thinkBlock('Only reasoning, nothing visible yet.'), toolCallBlock('read')])
  const d3 = await runStepAt(listener, lynn, 1, 3, [])
  assert.equal(d3.messages.length, 0, 'no anchor kind present: the step passes through')
  assert.equal(snapshots(lynn.session).length, 2, 'no snapshot committed')
  assert.equal(midstepRecalls().length, 2, 'no bank call')

  // Step 4, a human steer: the intervention wins the precedence over the
  // mid-step anchor (the synchronous path, anchored on the steer itself).
  const d4 = await runStepAt(listener, lynn, 1, 4, [userMsg('stop, the lint check must cover the docs folder too')])
  assert.equal(d4.messages.length, 2, 'the steer claim plus the intervention snapshot ride the decision')
  const snaps4 = snapshots(lynn.session)
  assert.equal(snaps4.length, 3)
  assert.match(snaps4[2].data.source.label, /^recall - \d+ms$/, 'the intervention row keeps the plain label')
  assert.equal(
    midstepRecalls().at(-1).body.query,
    'Prior context:\n\nuser: check the lint config\nassistant: Reading the lint config to check for var declarations.\n\nstop, the lint check must cover the docs folder too',
    'the intervention anchors on the steer itself; its anchor line is NOT dropped (the synchronous path)',
  )
  console.log("ok  mount L: a no-human mid-step recalls the previous step's text (label recall:text, anchor line dropped, the steer wins the precedence)")

  // L2: recallAfterReasoning on: the anchor is the previous step's
  // REASONING (a reasoning-only assistant message contributes no context
  // line, so the context is the human line alone).
  const ctx2 = makeCtx()
  plugin.apply(ctx2, { ...standard.value, baseUrl: stubUrl, bank: 'midstep2', prefetch: false, recallAfterReasoning: true })
  const listener2 = ctx2.listeners[0].fn
  const tool2 = ctx2.tools.registered[0]
  const marge = { session: makeSession('sess-l2') }
  const midstep2Recalls = () => state.requests.filter(request => request.path === '/v1/default/banks/midstep2/memories/recall')
  await tool2.execute({ action: 'retain', text: 'The CI cache is keyed on the commit hash and the lockfile.' }, { signal: baseSignal })

  const e1 = await runStepAt(listener2, marge, 1, 1, [userMsg('why does CI rebuild the cache')])
  assert.equal(e1.messages.length, 2, 'the turn-1 recall lands')

  asstStep(marge.session, 1, 1, [
    thinkBlock('The CI cache key is the commit hash plus the lockfile, so a new commit rebuilds it.'),
    toolCallBlock('read'),
  ])

  const e2 = await runStepAt(listener2, marge, 1, 2, [])
  assert.equal(e2.messages.length, 1)
  const snapsE = snapshots(marge.session)
  assert.equal(snapsE.length, 2)
  assert.match(snapsE[1].data.source.label, /^recall:think - \d+ms$/, 'the reasoning anchor is labeled recall:think')
  assert.equal(
    midstep2Recalls().at(-1).body.query,
    'Prior context:\n\nuser: why does CI rebuild the cache\n\nThe CI cache key is the commit hash plus the lockfile, so a new commit rebuilds it.',
    'the reasoning is the query tail; the reasoning-only assistant message adds no context line',
  )
  console.log('ok  mount L: recallAfterReasoning anchors the mid-step recall on the reasoning (label recall:think)')

  // L3: both keys on: ONE composed anchor (the reasoning first, then the
  // text), ONE recall, labeled recall:think+text; subagent sessions stay
  // silent at every step.
  const ctx3 = makeCtx()
  plugin.apply(ctx3, { ...standard.value, baseUrl: stubUrl, bank: 'midstep3', prefetch: false, recallAfterText: true, recallAfterReasoning: true })
  const listener3 = ctx3.listeners[0].fn
  const tool3 = ctx3.tools.registered[0]
  const nora = { session: makeSession('sess-l3') }
  const midstep3Recalls = () => state.requests.filter(request => request.path === '/v1/default/banks/midstep3/memories/recall')
  await tool3.execute({ action: 'retain', text: 'The build flags for release are set in the Makefile targets.' }, { signal: baseSignal })

  const f1 = await runStepAt(listener3, nora, 1, 1, [userMsg('check the release build flags')])
  assert.equal(f1.messages.length, 2, 'the turn-1 recall lands')

  asstStep(nora.session, 1, 1, [
    thinkBlock('The release flags live in the Makefile release targets; I need to read the Makefile.'),
    textBlock('Reading the Makefile to check the release build flags.'),
    toolCallBlock('read'),
  ])

  const f2 = await runStepAt(listener3, nora, 1, 2, [])
  assert.equal(f2.messages.length, 1)
  const snapsF = snapshots(nora.session)
  assert.equal(snapsF.length, 2)
  assert.match(snapsF[1].data.source.label, /^recall:think\+text - \d+ms$/, 'both kinds compose one anchor, labeled recall:think+text')
  assert.equal(midstep3Recalls().length, 2, 'ONE recall for the composed anchor, never two lookups')
  assert.equal(
    midstep3Recalls().at(-1).body.query,
    'Prior context:\n\nuser: check the release build flags\n\nThe release flags live in the Makefile release targets; I need to read the Makefile.\nReading the Makefile to check the release build flags.',
    'reasoning first, then text, as the composed anchor tail',
  )

  // A subagent session inherits the mount but stays silent at every step.
  const sub = { session: makeSession('sess-l3s', { origin: 'subagent' }) }
  const s1 = await runStepAt(listener3, sub, 1, 1, [userMsg('subagent task: check the release build flags')])
  assert.equal(s1.messages.length, 1, 'the subagent step-1 passes through (no snapshot)')
  asstStep(sub.session, 1, 1, [textBlock('Reading the Makefile to check the release build flags.')])
  const s2 = await runStepAt(listener3, sub, 1, 2, [])
  assert.equal(s2.messages.length, 0, 'the subagent mid-step passes through too')
  assert.equal(snapshots(sub.session).length, 0)
  assert.equal(midstep3Recalls().length, 2, 'no subagent bank call')
  console.log('ok  mount L: both keys compose ONE think+text anchor (one recall, label recall:think+text); subagent steps stay silent')

  // L4: the keys are OFF by default: a no-human mid-step is untouched.
  const ctx4 = makeCtx()
  plugin.apply(ctx4, { ...standard.value, baseUrl: stubUrl, bank: 'midstepoff', prefetch: false })
  const listener4 = ctx4.listeners[0].fn
  const tool4 = ctx4.tools.registered[0]
  const ola = { session: makeSession('sess-l4') }
  const offRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/midstepoff/memories/recall')
  await tool4.execute({ action: 'retain', text: 'The lint config forbids var declarations.' }, { signal: baseSignal })

  const g1 = await runStepAt(listener4, ola, 1, 1, [userMsg('check the lint config')])
  assert.equal(g1.messages.length, 2, 'the turn-1 recall still lands')
  asstStep(ola.session, 1, 1, [textBlock('Reading the lint config to check for var declarations.')])
  const g2 = await runStepAt(listener4, ola, 1, 2, [])
  assert.equal(g2.messages.length, 0, 'the default-off mid-step passes through (the claim was empty)')
  assert.equal(snapshots(ola.session).length, 1, 'no mid-step snapshot')
  assert.equal(offRecalls().length, 1, 'no mid-step bank call')
  console.log('ok  mount L: default-off keys leave a no-human mid-step untouched (pass-through, no bank call)')

  // L5: recallPreserve false + recallAfterText: the mid-step snapshot
  // retires the previous full card in place (tombstone + shadow price); an
  // unchanged mid-step recall is a pure no-op.
  const ctx5 = makeCtx({ tokenMeter: { estimateMessage: () => 7 } })
  plugin.apply(ctx5, { ...standard.value, baseUrl: stubUrl, bank: 'midstep4', prefetch: false, recallPreserve: false, recallAfterText: true, recallContextTurns: 1 })
  const listener5 = ctx5.listeners[0].fn
  const tool5 = ctx5.tools.registered[0]
  const pete = { session: makeSession('sess-l5') }
  const midstep4Recalls = () => state.requests.filter(request => request.path === '/v1/default/banks/midstep4/memories/recall')
  await tool5.execute({ action: 'retain', text: 'The build flags for release are set in the Makefile targets.' }, { signal: baseSignal })
  await tool5.execute({ action: 'retain', text: 'The linter runs before every merge commit.' }, { signal: baseSignal })

  const h1 = await runStepAt(listener5, pete, 1, 1, [userMsg('check the release build flags')])
  assert.equal(h1.messages.length, 1, 'the first snapshot commits directly, never riding the decision')
  const snapsH1 = snapshots(pete.session)
  assert.equal(snapsH1.length, 1)
  assert.equal(pete.session.surface.nodes[0], snapsH1[0].seq, 'the snapshot lands before the triggering message')

  asstStep(pete.session, 1, 1, [textBlock('Running the linter before the merge commit.')])

  const h2 = await runStepAt(listener5, pete, 1, 2, [])
  assert.equal(h2.messages.length, 1, 'the claim was empty; the full mid-step card rides the decision')
  const snapsH2 = snapshots(pete.session)
  assert.equal(snapsH2.length, 2, 'the durable log keeps both full snapshots')
  const oldCard = snapsH2[0]
  const newCard = snapsH2[1]
  assert.match(newCard.data.source.label, /^recall:text - \d+ms$/, 'the mid-step card is labeled by the anchor kind')
  assert.ok(!onSurface(pete.session, oldCard), 'the old full card is retired from the surface')
  assert.ok(onSurface(pete.session, newCard), 'the fresh full card is on the surface')
  assert.equal(pete.session.surface.nodes[pete.session.surface.nodes.length - 1], newCard.seq, 'the fresh card lands after the triggering message')
  const tombs = pete.session.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'plugin' && event.data.source.form === 'notice')
  assert.equal(tombs.length, 1, 'one tombstone for one retirement')
  const tomb = tombs[0]
  assert.deepEqual(tomb.surfaceOp, { op: 'replace', startSeq: oldCard.seq, endSeq: oldCard.seq }, 'the tombstone takes the old card\'s slot')
  assert.deepEqual(tomb.sourceEventSeqs, [oldCard.seq], 'the replace cites the shadowed node')
  assert.ok(onSurface(pete.session, tomb))
  const prunes = pete.session.events.filter(event => event.type === 'compaction/prune')
  assert.equal(prunes.length, 1, 'one shadow price for one retirement')
  assert.deepEqual(prunes[0].data, {
    shadowedRange: { start: oldCard.seq, end: oldCard.seq },
    shadowedSeqs: [oldCard.seq],
    shadowedTokenCount: 7,
  })
  assert.equal(pete.session.events.indexOf(prunes[0]), pete.session.events.indexOf(tomb) - 1, 'the price is appended immediately before the tombstone')
  assert.equal(
    midstep4Recalls().at(-1).body.query,
    'Running the linter before the merge commit.',
    'recallContextTurns 1: the mid-step anchor alone is the query',
  )

  // Step 3, an identical anchor: the unchanged recall is a pure no-op.
  asstStep(pete.session, 1, 2, [textBlock('Running the linter before the merge commit.')])
  const h3 = await runStepAt(listener5, pete, 1, 3, [])
  assert.equal(h3.messages.length, 0, 'an unchanged mid-step recall commits nothing')
  assert.equal(snapshots(pete.session).length, 2, 'still both full snapshots in the durable log')
  assert.equal(pete.session.events.filter(event => event.data.source?.kind === 'plugin' && event.data.source.form === 'notice').length, 1, 'no second tombstone')
  assert.equal(pete.session.events.filter(event => event.type === 'compaction/prune').length, 1, 'no second price')
  assert.equal(midstep4Recalls().length, 3, 'the lookup still ran (deterministic stub); nothing was committed')
  console.log('ok  mount L: recallPreserve false retires the previous card for a mid-step snapshot (tombstone, shadow price); unchanged = no-op')
}

// ── degraded behavior: server unreachable, bounded, never blocks ────────────
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: 'http://127.0.0.1:1', autoContextTimeoutMs: 250 })
  const tool = ctx.tools.registered[0]
  const listener = ctx.listeners[0].fn

  // the tool surfaces a clean error
  await assert.rejects(
    () => tool.execute({ action: 'recall', query: 'anything' }, { signal: baseSignal }),
    /hindsight: .*failed/,
  )
  // pre-step swallows the failure and returns the base decision untouched
  const base = { kind: 'enter', messages: [userMsg('x')] }
  const decision = await listener(
    { agent, messages: [userMsg('x')], step: 1, signal: baseSignal },
    async () => base,
  )
  assert.equal(decision, base)
  console.log('ok  degraded: unreachable server → tool error, pre-step passes through')
}

await stub.stop()
console.log('\nall hindsight plugin smoke tests passed')
