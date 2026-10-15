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
// surface carries only the LATEST full snapshot per bank — each new one
// retires the previous full card of its own bank in place (a tiny
// `form: 'notice'` tombstone marker at the old turn, shadow-priced by
// an adjacent log-only compaction/prune) and lands fresh as a full card
// at its own turn (the durable log keeps every full snapshot; an
// unchanged recall commits nothing — the snapshot is already current;
// mount P: a second mount on the same session, a different bank, keeps
// its own latest card alongside, and a card predating the bank field on
// the message source is attributed from the bank its rendered text
// names);
// in preserve mode an identical recall commits a marker row — naming the
// applied memories one compact line each — instead of a duplicate block,
// so every applied recall has a visible row.
// The recall starts AHEAD of the turn that pays for it (the turn-stopping
// prefetch): the detached job queries the turn's own human message while
// the user is reading or typing, the next step consumes the cache with no
// bank call, a failed or too-slow job falls back to the original bounded
// synchronous path, subagent turns never prefetch, prefetch: false gates
// the job off (every turn queries its current message synchronously), and
// disposal clears the slot,
// plus the post-compaction recall (recallAfterCompaction, default off): on
// a successful compaction/end (no error) the bank is queried for the last
// HUMAN message on the durable log (the prefetch composition: the anchor's
// replies as context lines) and the snapshot is committed DIRECTLY to the
// surface (row label recall:compact) - a failed compaction (error set)
// commits nothing, the default-off key stays silent, subagent sessions are
// skipped, an unchanged recall commits the marker row (or nothing under
// recallPreserve: false), and the recallPreserve: false direct commit
// retires the previous full card in place (tombstone + adjacent shadow
// price, fresh card appended), and the lookup rides its own
// recallCompactTimeoutMs bound (a delay outliving the shared
// autoContextTimeoutMs still commits the snapshot, while the same
// delay on the synchronous path times out),
// plus the pre-execution lesson gate (lessonGate, default off): a pending
// call to a tool named in lessonGateTools anchors a bounded experience-only
// recall on the call itself; a hit at or above lessonGateMinScore DENIES
// the call before the tool body runs (the rendered lessons travel in the
// reason), a sub-threshold hit allows, and a timeout / unanchored call /
// subagent session / non-gated tool passes with no bank call at all;
// plus dual-mount ownership (mount seventeen: a profile-wide row and a
// preset row both reaching one session - the session's PRESET mount
// owns its auto-recall: one snapshot per turn start, the owner bank's
// card with the shadowed host bank's standing directives merged in as
// their own per-bank section, while the host row stays silent on every
// automatic surface for that session (no snapshot, no prefetch, no
// mid-step or post-compaction recall, no gate lookup); a session no
// preset mount covers keeps the host row's full behavior; a failing
// shadow directive listing is merged away (the snapshot still lands);
// and disposing the preset generation ends its ownership, the host row
// resuming the session).
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
  recallAfterCompaction: false,
  recallPreserve: true,
  retainAsync: false,
  maxRecallTokens: 4096,
  autoContextTimeoutMs: 2500,
  recallCompactTimeoutMs: 8000,
  actionLessons: false,
  actionLessonCandidates: 10,
  lessonGate: false,
  lessonGateMinScore: 0.3,
  lessonGateTools: ['bash', 'run_code'],
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

// recallAfterCompaction: off by default (the post-compaction recall is
// opt-in); opt-in + validation
const postCompact = validate({ bank: 'x', recallAfterCompaction: true })
assert.ok('value' in postCompact, JSON.stringify(postCompact))
assert.equal(postCompact.value.recallAfterCompaction, true)
const badPostCompact = validate({ bank: 'x', recallAfterCompaction: 'yes' })
assert.ok('issues' in badPostCompact && badPostCompact.issues.some(issue => issue.path?.[0] === 'recallAfterCompaction'), JSON.stringify(badPostCompact))

// recallCompactTimeoutMs: 8000 by default (the detached post-compaction
// lookup's own bound); opt-in + validation
const compactTuned = validate({ bank: 'x', recallCompactTimeoutMs: 12000 })
assert.ok('value' in compactTuned, JSON.stringify(compactTuned))
assert.equal(compactTuned.value.recallCompactTimeoutMs, 12000)
const badCompactTimeout = validate({ bank: 'x', recallCompactTimeoutMs: 'soon' })
assert.ok('issues' in badCompactTimeout && badCompactTimeout.issues.some(issue => issue.path?.[0] === 'recallCompactTimeoutMs'), JSON.stringify(badCompactTimeout))

// lessonGate / lessonGateMinScore / lessonGateTools: off by default
// (the pre-execution gate is opt-in); opt-in + validation
const gateOn = validate({ bank: 'x', lessonGate: true })
assert.ok('value' in gateOn, JSON.stringify(gateOn))
assert.equal(gateOn.value.lessonGate, true)
assert.equal(gateOn.value.lessonGateMinScore, 0.3)
assert.deepEqual(gateOn.value.lessonGateTools, ['bash', 'run_code'])
const gateTuned = validate({ bank: 'x', lessonGate: true, lessonGateMinScore: 0.7, lessonGateTools: ['bash'] })
assert.ok('value' in gateTuned, JSON.stringify(gateTuned))
assert.equal(gateTuned.value.lessonGateMinScore, 0.7)
assert.deepEqual(gateTuned.value.lessonGateTools, ['bash'])
const badGate = validate({ bank: 'x', lessonGate: 'yes' })
assert.ok('issues' in badGate && badGate.issues.some(issue => issue.path?.[0] === 'lessonGate'), JSON.stringify(badGate))
const badGateScore = validate({ bank: 'x', lessonGateMinScore: 1.5 })
assert.ok('issues' in badGateScore && badGateScore.issues.some(issue => issue.path?.[0] === 'lessonGateMinScore'), JSON.stringify(badGateScore))
const badGateScoreNeg = validate({ bank: 'x', lessonGateMinScore: -0.2 })
assert.ok('issues' in badGateScoreNeg && badGateScoreNeg.issues.some(issue => issue.path?.[0] === 'lessonGateMinScore'))
const badGateTools = validate({ bank: 'x', lessonGateTools: ['bash', 7] })
assert.ok('issues' in badGateTools && badGateTools.issues.some(issue => issue.path?.[0] === 'lessonGateTools'), JSON.stringify(badGateTools))

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
// `root` stands in for the app's root context: every context of one
// runtime inherits it (cordis's Context.root), so cross-runtime-registry
// state lives on the shared object the fakes pass around. `plugin`/`extend`
// mirror cordis's standing-scope fiber shape (Object.create keeps the
// API and root on the prototype chain, exactly like Context.extend), and
// `effect` runs the body immediately, keeping the returned disposer on the
// calling context's own effectDisposers (a fiber disposal runs them).
function makeCtx(extra = {}, root) {
  const ctx = {
    tools: {
      registered: [],
      register(tool) { this.registered.push(tool) },
    },
    listeners: [],
    on(event, fn, options) { this.listeners.push({ event, fn, options }) },
    get(name) { return extra[name] },
    root: root ?? Object.create(null),
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
  && event.data.source?.kind === 'hindsight'
  && event.data.source.form === 'snapshot'
const snapshots = (session) => session.events.filter(isSnapshot)
const onSurface = (session, event) => session.surface.nodes.includes(event.seq)

// Mirrors deriveEventMessage over the stand-in's surface: each surface
// event derives to its message.
const deriveMessages = (session) => session.surface.nodes
  .map(seq => session.events[seq - 1])
  .map(event => event.data)
const derivedSnapshots = (session) => deriveMessages(session).filter(message =>
  message.source?.kind === 'hindsight' && message.source.form === 'snapshot',
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
  assert.match(snaps1[0].data.source.sections[0].name, /^recall - \d+ms$/, 'the section name is the lookup wall clock, e.g. "recall - 3ms"')
  assert.equal(snaps1[0].data.source.kind, 'hindsight', 'the hindsight kind is the attribution identity')
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
  assert.match(d4.messages.at(-1).source.sections[0].name, /^recall - \d+ms$/, 'the intervention row carries the same section name')
  assert.equal(d4.messages.at(-1).source.kind, 'hindsight', 'the hindsight kind is the attribution identity')
  const interventionReq = state.requests.filter(request =>
    request.path === '/v1/default/banks/hermes/memories/recall'
    && request.body.query === 'wait, the demo build must run on Node 22',
  ).at(-1)
  assert.ok(interventionReq, 'the intervention recall queried the steer itself')
  const afterIntervention = snapshots(agent.session).length
  assert.equal(afterIntervention, afterMarker + 1, 'the intervention commits its snapshot')
  // A step-2 claim WITHOUT a human message (plugin-injected context alone)
  // is not an intent: no recall, no snapshot.
  const injectedContext = { id: `inj${Math.random()}`, role: 'user', content: [{ type: 'text', text: 'injected plugin context' }], source: { kind: 'other-plugin', form: 'notice' } }
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

  // the pre-step listing is tier-scoped like recall; the tier filter runs
  // client-side (the server's `tags` parameter takes one literal tag, not
  // the two-tag tier list), so the listing is fetched unfiltered and
  // reduced to the session's visible tiers; same preset sees the preset
  // rule + the global one
  await runStep(listener, alice, 1, [userMsg('what formatting rule applies here?')])
  const rulesReq = state.requests.filter(request => request.path === '/v1/default/banks/rules/directives').at(-1)
  assert.ok(rulesReq.query.includes('active_only=true'))
  assert.ok(!rulesReq.query.includes('tags='), 'the listing fetches unfiltered (the tier filter is client-side)')
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
    ['agent/pre-step', 'agent/turn-stopping', 'session/event', 'tools/pre-execute', 'agent/disposed'],
    'the mount registers pre-step (consumer), turn-stopping (producer), session-event (post-compaction recall), tools/pre-execute (the lesson gate), disposed (cleanup)',
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
  assert.match(second.data.source.sections[0].name, /^recall - \d+ms$/, 'the cached snapshot carries the job wall clock as its section name')
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
  const disposed = ctx4.listeners[4].fn
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
  const tombstones = kate.session.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice')
  assert.equal(tombstones.length, 1, 'one tombstone for one retirement')
  const tomb = tombstones[0]
  assert.deepEqual(tomb.surfaceOp, { op: 'replace', startSeq: oldSnap.seq, endSeq: oldSnap.seq }, 'the tombstone takes the old card\'s slot')
  assert.deepEqual(tomb.sourceEventSeqs, [oldSnap.seq], 'the replace cites the shadowed node')
  assert.ok(onSurface(kate.session, tomb))
  assert.equal(kate.session.surface.nodes[0], tomb.seq, 'the tombstone sits in place — before both messages, at the turn that recalled')
  assert.equal(tomb.data.source.kind, 'hindsight')
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
  assert.equal(kate.session.events.filter(event => event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice').length, 1, 'no second tombstone either')
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
  assert.equal(flaky.events.filter(event => event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice').length, 0, 'no tombstone when the replace is refused')
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
  assert.match(snapshots(lynn.session)[0].data.source.sections[0].name, /^recall - \d+ms$/, 'the turn-1 row keeps the plain section name')

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
  assert.match(snaps2[1].data.source.sections[0].name, /^recall:text - \d+ms$/, 'the mid-step row is named by the anchor kind')
  assert.equal(snaps2[1].data.source.kind, 'hindsight', 'the hindsight kind is the attribution identity')
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
  assert.match(snaps4[2].data.source.sections[0].name, /^recall - \d+ms$/, 'the intervention row keeps the plain section name')
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
  assert.match(snapsE[1].data.source.sections[0].name, /^recall:think - \d+ms$/, 'the reasoning anchor is named recall:think')
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
  assert.match(snapsF[1].data.source.sections[0].name, /^recall:think\+text - \d+ms$/, 'both kinds compose one anchor, named recall:think+text')
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
  assert.match(newCard.data.source.sections[0].name, /^recall:text - \d+ms$/, 'the mid-step card is named by the anchor kind')
  assert.ok(!onSurface(pete.session, oldCard), 'the old full card is retired from the surface')
  assert.ok(onSurface(pete.session, newCard), 'the fresh full card is on the surface')
  assert.equal(pete.session.surface.nodes[pete.session.surface.nodes.length - 1], newCard.seq, 'the fresh card lands after the triggering message')
  const tombs = pete.session.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice')
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
  assert.equal(pete.session.events.filter(event => event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice').length, 1, 'no second tombstone')
  assert.equal(pete.session.events.filter(event => event.type === 'compaction/prune').length, 1, 'no second price')
  assert.equal(midstep4Recalls().length, 3, 'the lookup still ran (deterministic stub); nothing was committed')
  console.log('ok  mount L: recallPreserve false retires the previous card for a mid-step snapshot (tombstone, shadow price); unchanged = no-op')
}

// ── mount M: action lessons (experience recall anchored on the previous step's tool call) ─
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'lessons', prefetch: false, actionLessons: true })
  const listener = ctx.listeners[0].fn
  const tool = ctx.tools.registered[0]
  const max = { session: makeSession('sess-m1') }
  const sub = { session: makeSession('sess-m2', { origin: 'subagent' }) }
  const lessonRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/lessons/memories/recall')
  const lessonRows = session => session.events.filter(event =>
    event.type === 'user/message'
    && event.data.source?.kind === 'hindsight'
    && event.data.source.form === 'notice',
  )
  const bashCall = (id, command) => ({ id, type: 'tool-call', name: 'bash', arguments: JSON.stringify({ command }) })
  const commitCommand = 'git commit -m "use the quoted heredoc form for the message"'

  // Twelve near-identical stress-run lessons: they share words with the
  // turn-1 command and none with the commit command below. Seeded first so
  // their insertion order is the render order (the stub returns hits
  // unsorted, the plugin never sorts).
  for (let n = 1; n <= 12; n += 1) {
    await tool.execute({ action: 'retain', text: `[experience] stressbenchmark probe payload workload run finished on attempt number ${n}.` }, { signal: baseSignal })
  }
  // The two commit lessons, plus a world memory that must never surface in a
  // lesson row (the lookup is experience-only).
  await tool.execute({ action: 'retain', text: '[experience] git commit without a quoted heredoc form breaks the shell when the message carries an apostrophe.' }, { signal: baseSignal })
  await tool.execute({ action: 'retain', text: '[experience] the heredoc form of the commit message must be quoted or the shell breaks.' }, { signal: baseSignal })
  await tool.execute({ action: 'retain', text: 'The heredoc tooling documentation lives in the repo.' }, { signal: baseSignal })
  const seedA = state.memories.find(memory => memory.text.startsWith('git commit without a quoted heredoc'))
  const seedB = state.memories.find(memory => memory.text.startsWith('the heredoc form of the commit message'))

  // Turn 1: the previous step's bash action anchors the lookup; the twelve
  // near-identical hits cap at actionLessonCandidates (10).
  await runStepAt(listener, max, 1, 1, [userMsg('warm up the bank')])
  asstStep(max.session, 1, 1, [bashCall('tc-m1', 'stressbenchmark probe payload workload run')])
  await runStepAt(listener, max, 1, 2, [])
  let rows = lessonRows(max.session)
  assert.equal(rows.length, 1, 'one lesson row for the action step')
  assert.equal(rows[0].data.source.form, 'notice', 'the lesson row is a plain notice (no label, just a summary)')
  const capBody = rows[0].data.content[0].text
  assert.ok(capBody.includes("matching the previous step's bash action:"))
  assert.equal(capBody.split('\n').filter(line => line.startsWith('- ')).length, 10, 'the render cap keeps the first 10 of 12 hits')
  assert.ok(capBody.includes('number 10'))
  assert.ok(!capBody.includes('number 11') && !capBody.includes('number 12'), 'the last two hits are cut')
  assert.ok(capBody.includes('(match 4.000)'))
  assert.equal(rows[0].data.source.summary, 'bank lessons: 10 past failure lessons for bash action')

  // Turn 2: the git commit action matches the two commit lessons (the world
  // memory stays out); the lookup is experience-only, low-budget, and
  // anchored on the previous step's bash command.
  await runStepAt(listener, max, 2, 1, [userMsg('commit the changes with a heredoc quoted message')])
  asstStep(max.session, 2, 1, [bashCall('tc-m2', commitCommand)])
  const beforeMain = lessonRecalls().length
  await runStepAt(listener, max, 2, 2, [])
  rows = lessonRows(max.session)
  assert.equal(rows.length, 2, 'a second lesson row for the commit action')
  const mainRow = rows[1]
  const mainBody = mainRow.data.content[0].text
  assert.equal(mainBody.split('\n').filter(line => line.startsWith('- ')).length, 2, 'exactly the two commit lessons')
  assert.ok(mainBody.includes(`id:${seedA.id}`))
  assert.ok(mainBody.includes(`id:${seedB.id}`))
  assert.ok(!mainBody.includes('tooling documentation'), 'the world memory is filtered out')
  assert.equal(mainBody.match(/\(match 5\.000\)/g).length, 2, 'each hit carries its deterministic stub score')
  assert.equal(mainRow.data.source.summary, 'bank lessons: 2 past failure lessons for bash action')
  const mainRequest = lessonRecalls()[beforeMain]
  assert.deepStrictEqual(mainRequest.body.types, ['experience'], 'experience-only lookup')
  assert.equal(mainRequest.body.budget, 'low')
  assert.equal(mainRequest.body.max_tokens, 512)
  assert.ok(String(mainRequest.body.query).startsWith('bash: git commit'), 'the query is anchored on the previous step\'s bash command')

  // De-duplication: the same action later in the turn re-runs the lookup but
  // commits nothing new.
  asstStep(max.session, 2, 2, [bashCall('tc-m3', commitCommand)])
  const beforeDedupe = lessonRecalls().length
  await runStepAt(listener, max, 2, 3, [])
  assert.equal(lessonRows(max.session).length, 2, 'every hit was already surfaced this turn')
  assert.equal(lessonRecalls().length, beforeDedupe + 1, 'the lookup still ran (budget spent)')

  // A new turn resets the per-turn set.
  await runStepAt(listener, max, 4, 1, [userMsg('commit the changes again')])
  asstStep(max.session, 4, 1, [bashCall('tc-m4', commitCommand)])
  await runStepAt(listener, max, 4, 2, [])
  assert.equal(lessonRows(max.session).length, 3, 'a new turn re-surfaces the same lessons')

  // A previous step without a tool call anchors nothing: step 2 adds no bank
  // call (only step 1's standard recall ran).
  const beforePassthrough = lessonRecalls().length
  await runStepAt(listener, max, 5, 1, [userMsg('no action this turn')])
  asstStep(max.session, 5, 1, [textBlock('Just text, no action.')])
  await runStepAt(listener, max, 5, 2, [])
  assert.equal(lessonRows(max.session).length, 3)
  assert.equal(lessonRecalls().length, beforePassthrough + 1, 'only the first step\'s standard recall ran')

  // Subagent sessions stay silent at every step (no recall of any kind).
  const beforeSub = lessonRecalls().length
  await runStepAt(listener, sub, 1, 1, [userMsg('warm up the bank')])
  asstStep(sub.session, 1, 1, [bashCall('tc-m5', commitCommand)])
  await runStepAt(listener, sub, 1, 2, [])
  assert.equal(lessonRows(sub.session).length, 0, 'subagent steps commit no lesson rows')
  assert.equal(lessonRecalls().length, beforeSub, 'subagent steps issue no lookups at all')

  // Default off: with the key absent the mid-step is untouched.
  const ctxOff = makeCtx()
  plugin.apply(ctxOff, { ...standard.value, baseUrl: stubUrl, bank: 'lessons', prefetch: false })
  const offListener = ctxOff.listeners[0].fn
  const off = { session: makeSession('sess-m4') }
  const beforeOff = lessonRecalls().length
  await runStepAt(offListener, off, 1, 1, [userMsg('commit the changes')])
  asstStep(off.session, 1, 1, [bashCall('tc-m6', commitCommand)])
  await runStepAt(offListener, off, 1, 2, [])
  assert.equal(lessonRows(off.session).length, 0, 'the default-off key leaves the mid-step untouched')
  assert.equal(lessonRecalls().length, beforeOff + 1, 'only the first step\'s standard recall ran')
  console.log("ok  mount M: actionLessons - the previous step's tool call anchors an experience-only lesson recall (capped, de-duplicated per turn, notice row)")
}

// ── mount N: post-compaction recall (recallAfterCompaction, off by default) ──
{
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const waitFor = async (predicate, ms = 1000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(5)
    }
    return predicate()
  }
  const fireCompaction = (fn, session, data) => fn(session, { type: 'compaction/end', data })

  // N-main: a SUCCESSFUL compaction (no error) queries the bank for the
  // last HUMAN message on the durable log (the prefetch composition: the
  // anchor's own turn composed in, its own line dropped) and commits the
  // snapshot DIRECTLY to the surface, labeled recall:compact.
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'compact', prefetch: false, recallAfterCompaction: true })
  const preStep = ctx.listeners[0].fn
  const sessionEvent = ctx.listeners[2].fn
  const tool = ctx.tools.registered[0]
  const nina = { session: makeSession('sess-n1') }
  const compactRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/compact/memories/recall')
  await tool.execute({ action: 'retain', text: 'The deploy target is the staging cluster.' }, { signal: baseSignal })

  await runStep(preStep, nina, 1, [userMsg('where do we deploy')])
  assert.equal(snapshots(nina.session).length, 1, 'the turn-1 snapshot lands (synchronous path)')
  assert.equal(compactRecalls().length, 1, 'turn 1 is one recall')
  assert.equal(compactRecalls().at(-1).body.query, 'where do we deploy', 'the turn-1 query is the current message (no prior turns yet)')

  // The turn closes; a manual compaction succeeds at the turn boundary.
  asstStep(nina.session, 1, 1, [textBlock('Staging: the deploy target is the staging cluster.')])
  assert.equal(
    fireCompaction(sessionEvent, nina.session, { compactionId: 'c-n1', turn: null }),
    undefined,
    'the session/event listener returns immediately (fire-and-forget)',
  )
  assert.ok(await waitFor(() => compactRecalls().length === 2), 'the successful compaction issued its recall')
  assert.equal(
    compactRecalls().at(-1).body.query,
    'Prior context:\n\nassistant: Staging: the deploy target is the staging cluster.\n\nwhere do we deploy',
    'the anchor is the log\'s last human message; its assistant reply composes as context',
  )
  assert.ok(await waitFor(() => snapshots(nina.session).length === 2), 'the snapshot is committed directly on the surface')
  const compactSnap = snapshots(nina.session)[1]
  assert.match(compactSnap.data.source.sections[0].name, /^recall:compact - \d+ms$/, 'the post-compaction row is labeled recall:compact')
  assert.ok(onSurface(nina.session, compactSnap), 'the direct commit lands on the model surface')

  // A second successful compaction recalls the same memory: under the
  // recallPreserve: true default the marker row commits instead of a
  // duplicate block.
  fireCompaction(sessionEvent, nina.session, { compactionId: 'c-n2', turn: null })
  assert.ok(await waitFor(() => snapshots(nina.session).length === 3), 'the unchanged recall commits its marker row')
  assert.match(snapshots(nina.session)[2].data.content[0].text, /still in effect/, 'the marker names the memories still in effect')
  console.log('ok  mount N: a successful compaction commits the recall:compact snapshot directly (log-anchored, prefetch composition)')

  // N-fail: a FAILED compaction (error set) commits nothing.
  const before = state.requests.length
  fireCompaction(sessionEvent, nina.session, { compactionId: 'c-n3', turn: 2, error: 'compaction failed' })
  await sleep(50)
  assert.equal(state.requests.length, before, 'a failed compaction issues no recall')
  assert.equal(snapshots(nina.session).length, 3, 'a failed compaction commits nothing')
  console.log('ok  mount N: a failed compaction (error set) commits nothing')

  // N-off: with the key at its default (off), a successful compaction
  // stays silent.
  const ctxOff = makeCtx()
  plugin.apply(ctxOff, { ...standard.value, baseUrl: stubUrl, bank: 'compact', prefetch: false })
  const ninaOff = { session: makeSession('sess-n4') }
  await runStep(ctxOff.listeners[0].fn, ninaOff, 1, [userMsg('where do we deploy')])
  const offBefore = state.requests.length
  fireCompaction(ctxOff.listeners[2].fn, ninaOff.session, { compactionId: 'c-n5', turn: null })
  await sleep(50)
  assert.equal(state.requests.length, offBefore, 'default-off: a compaction issues no recall')
  assert.equal(snapshots(ninaOff.session).length, 1, 'default-off: no post-compaction snapshot')
  console.log('ok  mount N: recallAfterCompaction is off by default')

  // N-sub: subagent sessions are skipped.
  const ninaSub = { session: makeSession('sess-n6', { origin: 'subagent' }) }
  fireCompaction(sessionEvent, ninaSub.session, { compactionId: 'c-n6', turn: null })
  await sleep(50)
  assert.equal(snapshots(ninaSub.session).length, 0, 'subagent sessions are skipped')
  console.log('ok  mount N: subagent sessions stay silent after compaction')

  // N-keep: recallPreserve: false - the direct commit retires the
  // previous full card in place (tombstone + adjacent shadow price) and
  // appends the fresh full card; an identical recall commits nothing.
  const ctxKeep = makeCtx({ tokenMeter: { estimateMessage: () => 7 } })
  plugin.apply(ctxKeep, { ...standard.value, baseUrl: stubUrl, bank: 'compact-nokeep', prefetch: false, recallAfterCompaction: true, recallPreserve: false })
  const keepPreStep = ctxKeep.listeners[0].fn
  const keepEvents = ctxKeep.listeners[2].fn
  const keepTool = ctxKeep.tools.registered[0]
  const otto = { session: makeSession('sess-n5') }
  const keepRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/compact-nokeep/memories/recall')
  await keepTool.execute({ action: 'retain', text: 'The lint config forbids var declarations.' }, { signal: baseSignal })

  await runStep(keepPreStep, otto, 1, [userMsg('check the lint config')])
  const firstKeep = snapshots(otto.session)[0]
  assert.ok(onSurface(otto.session, firstKeep), 'the first snapshot is committed directly (no prior card to retire)')

  // The bank gains a memory between the turn recall and the compaction,
  // so the refresh recalls DIFFERENT text (the stub ignores the query:
  // without a state change the refresh would be identical and a no-op).
  await keepTool.execute({ action: 'retain', text: 'The lint config also caps line length at 120.' }, { signal: baseSignal })
  asstStep(otto.session, 1, 1, [textBlock('Reading the config for var declarations.')])
  fireCompaction(keepEvents, otto.session, { compactionId: 'c-n7', turn: null })
  assert.ok(await waitFor(() => snapshots(otto.session).length === 2), 'the refresh commits the fresh card')
  const secondKeep = snapshots(otto.session)[1]
  assert.match(secondKeep.data.source.sections[0].name, /^recall:compact - \d+ms$/)
  assert.ok(!onSurface(otto.session, firstKeep), 'the old full card is retired')
  assert.ok(onSurface(otto.session, secondKeep), 'the fresh full card is on the surface')
  const tombstone = otto.session.events.find(event =>
    event.type === 'user/message' && event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice',
  )
  assert.ok(tombstone, 'the retired slot holds a tombstone notice')
  assert.ok(onSurface(otto.session, tombstone), 'the tombstone is on the surface in the old slot')
  const prune = otto.session.events.find(event => event.type === 'compaction/prune')
  assert.ok(prune, 'the shadow price is recorded')
  assert.equal(otto.session.events.indexOf(prune), otto.session.events.indexOf(tombstone) - 1, 'the prune is adjacent (immediately before) the replace')
  assert.deepEqual(prune.data.shadowedSeqs, [firstKeep.seq], 'the prune prices the retired card')

  // A second successful compaction recalls the same memory: the newest
  // full card already carries that text, so nothing is committed.
  fireCompaction(keepEvents, otto.session, { compactionId: 'c-n8', turn: null })
  await sleep(50)
  assert.equal(snapshots(otto.session).length, 2, 'an identical refresh commits nothing (no churn)')
  assert.equal(keepRecalls().length, 3, 'the lookup still ran on the identical refresh (turn recall, refresh, identical)')
  console.log('ok  mount N: recallPreserve: false retires the previous full card in place on the direct commit (tombstone + shadow price)')

  // N-budget: the post-compaction lookup rides its OWN bound
  // (recallCompactTimeoutMs), decoupled from autoContextTimeoutMs: a
  // delay that outlives the shared bound still commits the
  // recall:compact snapshot, while the same delay on the loop-blocking
  // synchronous path times out (the turn proceeds without memory).
  const ctxBudget = makeCtx()
  plugin.apply(ctxBudget, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'compact-budget',
    prefetch: false,
    recallAfterCompaction: true,
    autoContextTimeoutMs: 50,
    recallCompactTimeoutMs: 5000,
  })
  const budgetPreStep = ctxBudget.listeners[0].fn
  const budgetEvents = ctxBudget.listeners[2].fn
  const budgetTool = ctxBudget.tools.registered[0]
  const ninaB = { session: makeSession('sess-n9') }
  const budgetRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/compact-budget/memories/recall')
  await budgetTool.execute({ action: 'retain', text: 'The deploy target is the staging cluster.' }, { signal: baseSignal })

  state.recallDelayMs = 200
  await runStep(budgetPreStep, ninaB, 1, [userMsg('where do we deploy')])
  await sleep(50)
  assert.equal(budgetRecalls().length, 1, 'the turn issued its recall')
  assert.equal(snapshots(ninaB.session).length, 0, 'the 200ms delay outlives the 50ms shared bound: the synchronous turn recall times out, no snapshot')

  asstStep(ninaB.session, 1, 1, [textBlock('Staging: the deploy target is the staging cluster.')])
  fireCompaction(budgetEvents, ninaB.session, { compactionId: 'c-n9', turn: null })
  assert.ok(await waitFor(() => budgetRecalls().length === 2, 2000), 'the compaction issued its recall')
  assert.ok(await waitFor(() => snapshots(ninaB.session).length === 1, 2000), 'the post-compaction lookup outlives the shared bound: its own budget admits it')
  assert.match(snapshots(ninaB.session)[0].data.source.sections[0].name, /^recall:compact - \d+ms$/, 'the row is labeled recall:compact')
  state.recallDelayMs = 0
  console.log('ok  mount N: the post-compaction lookup rides recallCompactTimeoutMs (decoupled from autoContextTimeoutMs)')
}

// ── mount O: the pre-execution lesson gate (lessonGate, default off) ───────
{
  const gateRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/gate/memories/recall')
  const allowNext = async () => ({ kind: 'allow' })
  const call = (name, argumentsX, agentX) => ({ name, arguments: argumentsX, agent: agentX, signal: baseSignal })

  // O-off: the default-off key delegates to next() with no bank call at all.
  const ctxOff = makeCtx()
  plugin.apply(ctxOff, { ...standard.value, baseUrl: stubUrl, bank: 'gate', prefetch: false })
  const offGate = ctxOff.listeners[3].fn
  assert.deepEqual(await offGate(call('bash', { command: 'whatever' }, agent), allowNext), { kind: 'allow' })
  assert.equal(gateRecalls().length, 0, 'default-off: no gate lookup')
  console.log('ok  mount O: lessonGate is off by default (next() delegated, no lookup)')

  // O-gate: on. Seed the failure lessons the pending calls will match.
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl, bank: 'gate', prefetch: false, lessonGate: true })
  const gate = ctx.listeners[3].fn
  const tool = ctx.tools.registered[0]
  await tool.execute({ action: 'retain', text: '[experience] the deploy script needs the RELEASE_CHANNEL env set or it ships the dev build.' }, { signal: baseSignal })
  await tool.execute({ action: 'retain', text: '[experience] the pinned score probe failed on the fixture run.' }, { signal: baseSignal })
  await tool.execute({ action: 'retain', text: 'The gate documentation lives in the repo.' }, { signal: baseSignal })
  const seed = state.memories.find(memory => memory.text.startsWith('the deploy script needs'))
  const g1 = { session: makeSession('sess-g1') }

  // O-deny: a pending bash call whose anchor words overlap the lesson
  // (the score is above the default 0.3) is denied BEFORE execution; the
  // lookup is experience-only, the anchor is the pending call itself, and
  // the reason carries the rendered lesson (score + id). Nothing is
  // committed to the session.
  const beforeDeny = gateRecalls().length
  const denied = await gate(call('bash', { command: 'deploy script ships the dev build' }, g1), allowNext)
  assert.equal(gateRecalls().length, beforeDeny + 1, 'one gate lookup for the pending call')
  assert.deepEqual(state.requests.at(-1).body.types, ['experience'], 'the gate lookup is experience-only')
  assert.ok(state.requests.at(-1).body.query.startsWith('bash: deploy script'), 'the anchor is the pending call itself')
  assert.equal(denied.kind, 'deny', 'a strong match denies the call')
  assert.ok(denied.reason.startsWith('denied by the hindsight lesson gate:'), 'the denial carries the gate header')
  assert.ok(denied.reason.includes(`id:${seed.id}`), 'the denial carries the lesson id')
  assert.ok(denied.reason.includes('(match 4.000)'), 'the denial carries the match score')
  assert.ok(!denied.reason.includes('gate documentation'), 'the world seed never surfaces through the gate')
  assert.equal(g1.session.events.length, 0, 'the gate commits nothing to the session')
  console.log('ok  mount O: a strong lesson match denies the pending call (reason carries the lesson)')

  // O-boundary: a hit AT lessonGateMinScore denies (>=, not >); a hit
  // UNDER it allows - the lookup ran, the threshold filtered the hit.
  const beforeEdge = gateRecalls().length
  assert.equal((await gate(call('bash', { command: 'pinned score:0.3' }, g1), allowNext)).kind, 'deny', 'a hit at the threshold denies')
  const beforeBelow = gateRecalls().length
  assert.deepEqual(await gate(call('bash', { command: 'pinned score:0.1' }, g1), allowNext), { kind: 'allow' }, 'a sub-threshold hit allows')
  assert.equal(beforeBelow, beforeEdge + 1, 'the edge lookup ran; the sub-threshold lookup ran too')
  console.log('ok  mount O: the threshold is inclusive (at denies, under allows)')

  // O-run_code: run_code is in the default lessonGateTools and pays the
  // lookup (its args line anchors the same lesson).
  const beforeCode = gateRecalls().length
  const codeDenied = await gate(call('run_code', { code: 'deploy script ships the dev build' }, g1), allowNext)
  assert.equal(codeDenied.kind, 'deny', 'run_code is gated by default')
  assert.ok(state.requests.at(-1).body.query.startsWith('run_code code='), 'the run_code anchor is the args line')
  assert.equal(gateRecalls().length, beforeCode + 1)
  console.log('ok  mount O: run_code is gated by the default lessonGateTools')

  // O-filter: a tool outside lessonGateTools pays no lookup at all.
  const beforeFilter = gateRecalls().length
  assert.deepEqual(await gate(call('read', { path: 'deploy script ships' }, g1), allowNext), { kind: 'allow' })
  assert.equal(gateRecalls().length, beforeFilter, 'non-gated tools pay no lookup')
  console.log('ok  mount O: tools outside lessonGateTools pass without a lookup')

  // O-timeout: a slow bank allows the call (no bank, no gate).
  state.recallDelayMs = 400
  try {
    const ctxSlow = makeCtx()
    plugin.apply(ctxSlow, { ...standard.value, baseUrl: stubUrl, bank: 'gate', prefetch: false, lessonGate: true, autoContextTimeoutMs: 120 })
    const slowGate = ctxSlow.listeners[3].fn
    assert.deepEqual(await slowGate(call('bash', { command: 'deploy script ships the dev build' }, g1), allowNext), { kind: 'allow' }, 'a timeout allows the call')
  } finally {
    state.recallDelayMs = 0
  }
  console.log('ok  mount O: a timeout allows the call (failure isolation)')

  // O-subagent: subagent sessions are skipped before the lookup (total
  // silence).
  const beforeSub = gateRecalls().length
  assert.deepEqual(await gate(call('bash', { command: 'deploy script ships the dev build' }, subagent), allowNext), { kind: 'allow' })
  assert.equal(gateRecalls().length, beforeSub, 'subagent: no gate lookup')
  console.log('ok  mount O: subagent sessions stay silent')

  // O-args: arguments that anchor nothing (non-object) allow without a
  // lookup.
  const beforeArgs = gateRecalls().length
  assert.deepEqual(await gate(call('bash', null, g1), allowNext), { kind: 'allow' })
  assert.equal(gateRecalls().length, beforeArgs, 'unanchored arguments pay no lookup')
  console.log('ok  mount O: unanchored arguments pass without a lookup')
}

// ── mount P: recallPreserve: false on TWO mounts, one session — retirement is per-bank ──
{
  // The sanctioned dual-mount deployment: a host row and a preset row on
  // the same session, different banks, one shared surface. Under
  // recallPreserve: false each mount keeps its own LATEST full card, so a
  // refresh must never retire the other mount's snapshot (the pre-fix
  // burst: each recall buried the other bank's card, and got buried back).
  // A legacy card predating the bank field on the message source is
  // attributed from the bank its rendered text names.
  const ctx = makeCtx({ tokenMeter: { estimateMessage: () => 7 } })
  plugin.apply(ctx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'perbank-a',
    recallPreserve: false,
    recallContextTurns: 1,
    prefetch: false,
  })
  plugin.apply(ctx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'perbank-b',
    recallPreserve: false,
    recallContextTurns: 1,
    prefetch: false,
  })
  // each apply registers pre-step / turn-stopping / session-event /
  // pre-execute / disposed in order: mount A's pre-step is listener 0,
  // mount B's listener 5
  const listenerA = ctx.listeners[0].fn
  const listenerB = ctx.listeners[5].fn
  const toolA = ctx.tools.registered[0]
  const toolB = ctx.tools.registered[1]
  const pal = { session: makeSession('sess-p') }

  // Disjoint vocabularies per bank and per recall state: each query hits
  // exactly one memory, never the other.
  await toolA.execute({ action: 'retain', text: 'The verdant probe mounts on the north rail.' }, { signal: baseSignal })
  await toolA.execute({ action: 'retain', text: 'The crimson gauge reads the south rail.' }, { signal: baseSignal })
  await toolB.execute({ action: 'retain', text: 'The zephyr relay rides the north tower.' }, { signal: baseSignal })
  await toolB.execute({ action: 'retain', text: 'The quartz filament weaves the south loom.' }, { signal: baseSignal })

  // A legacy card: an A-bank snapshot from a session resumed across a
  // plugin upgrade. Its source carries no bank field (predating the
  // attribution); only the rendered text names the bank.
  const legacyText = 'Relevant memories from the Hindsight bank "perbank-a":\n- the brass gear turns clockwise on the second shaft.'
  const legacy = pal.session.append('user/message', {
    id: 'legacy-p',
    role: 'user',
    content: [{ type: 'text', text: legacyText }],
    source: { kind: 'hindsight', form: 'snapshot', sections: [{ name: 'recall - 3ms', text: legacyText }] },
  }, { surfaceOp: 'append' })

  // Turn 1, mount A: the legacy card is A's latest on the surface, so A's
  // first refresh retires it (attributed from its text, not a field),
  // shadow-priced, and the fresh card rides the decision.
  const d1 = await runStep(listenerA, pal, 1, [userMsg('where does the verdant probe mount?')])
  assert.equal(d1.messages.length, 2, 'A: the fresh full card rides the decision; the retirement commits directly')
  let tombstones = pal.session.events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice')
  assert.equal(tombstones.length, 1, 'one tombstone for the legacy card')
  const tomb1 = tombstones[0]
  assert.deepEqual(tomb1.surfaceOp, { op: 'replace', startSeq: legacy.seq, endSeq: legacy.seq }, 'the tombstone takes the legacy card\'s slot')
  assert.deepEqual(tomb1.sourceEventSeqs, [legacy.seq], 'the replace cites the shadowed node')
  assert.equal(tomb1.data.source.bank, 'perbank-a', 'the retiring mount attributes the marker to its own bank')
  assert.match(tomb1.data.content[0].text, /perbank-a/, 'the tombstone names its own bank')
  assert.ok(!onSurface(pal.session, legacy), 'the legacy card is off the surface')
  let snapsA = pal.session.events.filter(event => event.data.source?.bank === 'perbank-a' && event.data.source.form === 'snapshot')
  assert.equal(snapsA.length, 1)
  assert.ok(onSurface(pal.session, snapsA[0]), 'A: the fresh card is on the surface')
  assert.match(snapsA[0].data.content[0].text, /Hindsight bank "perbank-a"/, 'the card names its own bank')
  assert.match(snapsA[0].data.content[0].text, /verdant probe/, 'A: the card carries its own bank\'s hit')
  assert.equal(pal.session.events.filter(event => event.type === 'compaction/prune').length, 1, 'the legacy retirement is shadow-priced')
  console.log('ok  mount P: a legacy card (no bank field) is attributed from its rendered text and retired by its own bank')

  // Turn 2, mount B: B's first snapshot is a direct append, and it must
  // NOT retire A's card: the other mount's bank is not B's to bury.
  const d2 = await runStep(listenerB, pal, 1, [userMsg('where does the zephyr relay tower stand?')])
  assert.equal(d2.messages.length, 1, 'B: the first snapshot commits directly, never riding the decision')
  let snapsB = pal.session.events.filter(event => event.data.source?.bank === 'perbank-b' && event.data.source.form === 'snapshot')
  assert.equal(snapsB.length, 1)
  assert.ok(onSurface(pal.session, snapsB[0]), 'B: the fresh card is on the surface')
  assert.ok(onSurface(pal.session, snapsA[0]), 'A: its card survives B\'s recall (no cross-bank retirement)')
  assert.equal(pal.session.events.filter(event => event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice').length, 1, 'no second tombstone for B\'s first card')
  assert.equal(pal.session.events.filter(event => event.type === 'compaction/prune').length, 1, 'no second shadow price either')
  assert.equal(pal.session.surface.nodes.length, 5, 'tombstone, A card, A message, B card, B message (both banks\' cards side by side)')
  console.log('ok  mount P: a recall never retires the other bank\'s card (the two snapshots land side by side)')

  // Turn 3, mount A: a different recall retires A's OWN latest card only;
  // B's card stays exactly where it landed.
  const d3 = await runStep(listenerA, pal, 1, [userMsg('where does the crimson gauge read?')])
  assert.equal(d3.messages.length, 2, 'A: the fresh full card rides the decision')
  snapsA = pal.session.events.filter(event => event.data.source?.bank === 'perbank-a' && event.data.source.form === 'snapshot')
  assert.equal(snapsA.length, 2, 'the durable log keeps A\'s both full snapshots')
  assert.ok(!onSurface(pal.session, snapsA[0]), 'A: its previous card is retired')
  assert.ok(onSurface(pal.session, snapsA[1]), 'A: its fresh card is on the surface')
  assert.match(snapsA[1].data.content[0].text, /crimson gauge/, 'A: the fresh card carries its own bank\'s hit')
  assert.ok(onSurface(pal.session, snapsB[0]), 'B: its card survives A\'s refresh (no cross-bank retirement)')
  const tomb2 = pal.session.events.filter(event => event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice')[1]
  assert.deepEqual(tomb2.sourceEventSeqs, [snapsA[0].seq], 'the retirement targets A\'s own card')
  assert.equal(tomb2.data.source.bank, 'perbank-a', 'the marker is attributed to the retiring mount\'s bank')
  console.log('ok  mount P: a refresh retires only the mounting bank\'s latest card (the other bank\'s card stays)')

  // Turn 4, mount B: mirrored. B retires its own first card; A's current
  // card is untouched. The surface now holds exactly the two latest full
  // cards, one per bank, plus the three in-place tombstones.
  const d4 = await runStep(listenerB, pal, 1, [userMsg('where does the quartz filament weave?')])
  assert.equal(d4.messages.length, 2, 'B: the fresh full card rides the decision')
  snapsB = pal.session.events.filter(event => event.data.source?.bank === 'perbank-b' && event.data.source.form === 'snapshot')
  assert.equal(snapsB.length, 2)
  assert.ok(!onSurface(pal.session, snapsB[0]), 'B: its previous card is retired')
  assert.ok(onSurface(pal.session, snapsB[1]), 'B: its fresh card is on the surface')
  assert.match(snapsB[1].data.content[0].text, /quartz filament/, 'B: the fresh card carries its own bank\'s hit')
  assert.ok(onSurface(pal.session, snapsA[1]), 'A: its current card survives B\'s refresh')
  const tomb3 = pal.session.events.filter(event => event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice')[2]
  assert.deepEqual(tomb3.sourceEventSeqs, [snapsB[0].seq], 'the retirement targets B\'s own card')
  assert.equal(tomb3.data.source.bank, 'perbank-b')
  assert.equal(pal.session.events.filter(event => event.type === 'compaction/prune').length, 3, 'three shadow prices for three retirements')

  // End state: one full card per bank on the surface, nothing cross-bank
  // ever buried.
  const surfaceSnaps = derivedSnapshots(pal.session)
  assert.equal(surfaceSnaps.length, 2, 'the surface carries one full card per bank')
  assert.deepEqual(surfaceSnaps.map(message => message.source.bank).sort(), ['perbank-a', 'perbank-b'])
  const surfaceTombstones = pal.session.surface.nodes.map(seq => pal.session.events[seq - 1]).filter(event => event.data.source?.kind === 'hindsight' && event.data.source.form === 'notice')
  assert.equal(surfaceTombstones.length, 3)
  assert.deepEqual(surfaceTombstones.map(event => event.data.source.bank).sort(), ['perbank-a', 'perbank-a', 'perbank-b'])
  const bankRecalls = (bank) => state.requests.filter(request => request.path === `/v1/default/banks/${bank}/memories/recall`)
  assert.equal(bankRecalls('perbank-a').length, 2, 'A recalled twice (turns 1 and 3), on its own bank only')
  assert.equal(bankRecalls('perbank-b').length, 2, 'B recalled twice (turns 2 and 4), on its own bank only')
  console.log('ok  mount P: the dual-mount surface holds the latest full card per bank (complementary snapshots, no cross-bank churn)')
}

// ── mount seventeen: dual-mount ownership - the preset row owns the session's auto-recall ──
{
  // The gpu-kernels shape: a profile-wide row (bank owner-host) and a
  // preset row (bank owner-kernel) both reach a kernel-dev session. The
  // preset's mount is the session's OWNER: one snapshot per turn start
  // (the owner bank's card, the shadowed host bank's standing directives
  // merged in as their own section), and the host mount stays silent on
  // every automatic surface for that session - no second snapshot, no
  // prefetch, no mid-step or post-compaction recall, no lesson gate. A
  // session no preset mount covers is served by both mounts as before;
  // a shadow bank whose directive listing fails is simply omitted from
  // the merge; disposing the preset generation ends its ownership and
  // the host row resumes.
  const { createScope } = await import('@deepseek-ai/dsh-scope')
  const hostCtx = makeCtx({ tokenMeter: { estimateMessage: () => 7 } })
  plugin.apply(hostCtx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'owner-host',
    recallContextTurns: 1,
    prefetch: true,
    recallAfterCompaction: true,
    actionLessons: true,
    lessonGate: true,
  })
  // The preset row applies under its preset's standing scope: the real
  // createScope mints the scope fiber and tags the scoped context with
  // the scope key carrying the agent preset id (the same wiring the
  // real preset-plane apply takes; the scoped context inherits the host
  // context's root, where the shared registry lives).
  const kernelScope = createScope(hostCtx, { agentPreset: 'kernel-dev' })
  const presetCtx = kernelScope.ctx
  plugin.apply(presetCtx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'owner-kernel',
    recallContextTurns: 1,
    prefetch: true,
    recallAfterCompaction: true,
    actionLessons: true,
    lessonGate: true,
  })
  const hostPreStep = hostCtx.listeners[0].fn
  const hostTurnStopping = hostCtx.listeners[1].fn
  const hostSessionEvent = hostCtx.listeners[2].fn
  const hostGate = hostCtx.listeners[3].fn
  const hostTool = hostCtx.tools.registered[0]
  const presetPreStep = presetCtx.listeners[0].fn
  const presetTurnStopping = presetCtx.listeners[1].fn
  const presetSessionEvent = presetCtx.listeners[2].fn
  const presetGate = presetCtx.listeners[3].fn
  // The fake's tools registry is inherited along the context chain, so
  // BOTH applies appended to the host context's array: each apply
  // registers exactly one tool, index them in apply order.
  const presetTool = presetCtx.tools.registered[1]

  // The shared registry (root level): the host row under the host key,
  // the preset row under its preset id.
  const registry = hostCtx.root[Symbol.for('dsh-plugin-hindsight-advanced.mounts')]
  assert.deepEqual(registry.get(Symbol.for('dsh-plugin-hindsight-advanced.host-mount')).map(record => record.bank), ['owner-host'])
  assert.deepEqual(registry.get('kernel-dev').map(record => record.bank), ['owner-kernel'])

  const hostRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/owner-host/memories/recall').length
  const kernelRecalls = () => state.requests.filter(request => request.path === '/v1/default/banks/owner-kernel/memories/recall').length
  const hostDirectiveGets = () => state.requests.filter(request => request.method === 'GET' && request.path === '/v1/default/banks/owner-host/directives').length
  const tick = () => new Promise(resolve => setTimeout(resolve, 25))

  // Disjoint vocabularies per bank; standing directives on both; failure
  // lessons on both (the gate surface's canaries).
  await hostTool.execute({ action: 'retain', text: 'The amber coil winds the east bus.' }, { signal: baseSignal })
  await presetTool.execute({ action: 'retain', text: 'The cobalt pin bridges the west rack.' }, { signal: baseSignal })
  await hostTool.execute({ action: 'retain', kind: 'directive', name: 'host-rule', text: 'Host standing rule: keep the amber coil warm.' }, { signal: baseSignal })
  await presetTool.execute({ action: 'retain', kind: 'directive', name: 'kernel-rule', text: 'Kernel standing rule: never open the west rack.' }, { signal: baseSignal })
  await hostTool.execute({ action: 'retain', text: '[experience] Never flash the amber relay without guarding the east bus.' }, { signal: baseSignal })
  await presetTool.execute({ action: 'retain', text: '[experience] Never flash the cobalt relay without a pull-up on the west rack.' }, { signal: baseSignal })

  const kernel = { session: makeSession('sess-owner-kernel', { agentPreset: 'kernel-dev' }) }
  const hostBase = hostRecalls()
  const kernelBase = kernelRecalls()
  const hostDirsBase = hostDirectiveGets()

  // Turn 1, the owner mount: ONE snapshot, the owner bank's card, with
  // BOTH banks' standing directives in their own per-bank sections.
  const decision = await runStep(presetPreStep, kernel, 1, [userMsg('wire the amber coil and the cobalt pin')])
  const card = decision.messages.find(message => message.source?.kind === 'hindsight')
  assert.ok(card, 'the owner mount commits the session snapshot')
  const cardText = card.content[0].text
  assert.ok(cardText.includes('Hindsight bank "owner-kernel"'), 'the card names the owner bank')
  assert.ok(cardText.includes('cobalt pin bridges'), 'the card carries the owner bank hit')
  assert.ok(!cardText.includes('amber coil winds'), 'the shadow bank hits stay out of the owner card')
  assert.ok(cardText.includes('Hindsight bank "owner-kernel" - follow them'), 'the owner bank rules section')
  assert.ok(cardText.includes('Hindsight bank "owner-host" - follow them'), 'the merged shadow bank rules section')
  assert.ok(cardText.includes('Kernel standing rule'), 'the owner bank rule text')
  assert.ok(cardText.includes('Host standing rule'), 'the merged shadow bank rule text')
  assert.equal(kernelRecalls(), kernelBase + 1, 'one owner recall for the turn start')
  assert.equal(hostRecalls(), hostBase, 'the host mount made no recall for the kernel session')
  assert.equal(hostDirectiveGets(), hostDirsBase + 1, 'the owner merged the host directives (the one extra GET)')
  console.log('ok  mount seventeen: one snapshot per turn start, both banks rules merged')

  // The host mount, driven for the same kernel session, is silent on
  // every automatic surface: no second snapshot, no prefetch, no
  // post-compaction recall, no gate lookup - and no bank call at all.
  const silentDecision = await hostPreStep(
    { agent: kernel, messages: [userMsg('steer: protect the amber coil')], turn: 2, step: 2, signal: baseSignal },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(silentDecision.messages.length, 0, 'no host mid-step recall for the kernel session')
  assert.equal(hostRecalls(), hostBase, 'the mid-step claim pays no host lookup')
  hostTurnStopping({ agent: kernel, turn: 2, signal: baseSignal })
  await tick()
  assert.equal(hostRecalls(), hostBase, 'no host prefetch for the kernel session')
  hostSessionEvent(kernel.session, { type: 'compaction/end', data: { compactionId: 'c-k1', turn: null } })
  await tick()
  assert.equal(hostRecalls(), hostBase, 'no host post-compaction recall for the kernel session')
  const allowNext = async () => ({ kind: 'allow' })
  const gateCall = (name, argumentsX, agentX) => ({ name, arguments: argumentsX, agent: agentX, signal: baseSignal })
  const hostGateResult = await hostGate(gateCall('bash', { command: 'flash the amber relay' }, kernel), allowNext)
  assert.deepEqual(hostGateResult, { kind: 'allow' }, 'the host gate is silent for the kernel session')
  assert.equal(hostRecalls(), hostBase, 'no host gate lookup for the kernel session')
  console.log('ok  mount seventeen: the host row is silent on every kernel surface')

  // The owner's own surfaces are untouched: its prefetch runs for the
  // kernel session (and merges the host directives into its cached
  // result), and its gate DENIES from the owner bank's lessons.
  presetTurnStopping({ agent: kernel, turn: 2, signal: baseSignal })
  await tick()
  assert.equal(kernelRecalls(), kernelBase + 2, 'the owner prefetch ran for the kernel session')
  assert.equal(hostDirectiveGets(), hostDirsBase + 2, 'the prefetch merged the host directives too')
  const consumed = await runStep(presetPreStep, kernel, 1, [userMsg('re-check the west rack pull-up')])
  const consumedCard = consumed.messages.find(message => message.source?.kind === 'hindsight')
  assert.ok(consumedCard, 'the cached prefetch lands on the turn (unchanged recall: the marker row)')
  assert.ok(consumedCard.content[0].text.includes('no new memories this turn'), 'the marker names the unchanged recall')
  assert.ok(consumedCard.content[0].text.includes('Standing rules from the bank unchanged'), 'the marker keeps the rules pointer')
  const kernelGateResult = await presetGate(gateCall('bash', { command: 'flash the cobalt relay' }, kernel), allowNext)
  assert.equal(kernelGateResult.kind, 'deny', 'the owner bank gate is active for the kernel session')
  assert.ok(kernelGateResult.reason.includes('cobalt relay'), 'the denial carries the owner bank lesson')
  console.log('ok  mount seventeen: the owner mount keeps its full behavior')

  // The owner's post-compaction recall commits for the kernel session
  // (directly to the surface, its own label); the host's stays silent.
  presetSessionEvent(kernel.session, { type: 'compaction/end', data: { compactionId: 'c-k2', turn: null } })
  await tick()
  const compactSnapshots = snapshots(kernel.session).filter(snapshot =>
    snapshot.data.source.sections[0].name.startsWith('recall:compact'),
  )
  assert.equal(compactSnapshots.length, 1, 'the owner commits the post-compaction snapshot')
  assert.equal(compactSnapshots[0].data.source.bank, 'owner-kernel')
  assert.equal(hostRecalls(), hostBase, 'the host mount still made zero recalls')
  console.log('ok  mount seventeen: post-compaction recall is the owner alone')

  // A session no preset mount covers: the host row serves it unchanged
  // (host bank only - no kernel section, no kernel rules).
  const plain = { session: makeSession('sess-owner-plain') }
  const plainDecision = await runStep(hostPreStep, plain, 1, [userMsg('wind the amber coil tighter')])
  const plainCard = plainDecision.messages.find(message => message.source?.kind === 'hindsight')
  assert.ok(plainCard, 'the host row serves a no-preset session as before')
  assert.ok(plainCard.content[0].text.includes('Hindsight bank "owner-host"'), 'the host card names the host bank')
  assert.ok(!plainCard.content[0].text.includes('owner-kernel'), 'no kernel section on the host card')
  assert.ok(!plainCard.content[0].text.includes('Kernel standing rule'), 'no kernel rules on the host card')
  console.log('ok  mount seventeen: no-preset sessions keep the host row behavior')

  // The preset generation dies: its record unregisters from the shared
  // registry and the host row resumes serving the kernel session (full
  // behavior, no merge - the kernel bank is registered nowhere).
  for (const dispose of [...presetCtx.effectDisposers]) dispose()
  assert.equal(registry.get('kernel-dev'), undefined, 'the dead generation unregisters its record')
  const hostResumed = await runStep(hostPreStep, kernel, 1, [userMsg('stand up the amber coil again')])
  const hostCard = hostResumed.messages.find(message => message.source?.kind === 'hindsight')
  assert.ok(hostCard, 'the host row resumes serving the kernel session')
  assert.ok(hostCard.content[0].text.includes('Host standing rule'), 'the host rules section on the resumed card')
  assert.ok(!hostCard.content[0].text.includes('owner-kernel'), 'no kernel section after the generation died')
  console.log('ok  mount seventeen: a dead preset generation ends its ownership')

  // Failure isolation of the merge: a shadow bank whose directive
  // listing fails is simply omitted - the owner card still lands with
  // its own rules (the shadow's failure never discards the snapshot).
  const failCtx = makeCtx()
  plugin.apply(failCtx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'no-dir',
    recallContextTurns: 1,
    prefetch: false,
  })
  const failScope = createScope(failCtx, { agentPreset: 'fail-preset' })
  plugin.apply(failScope.ctx, {
    ...standard.value,
    baseUrl: stubUrl,
    bank: 'fail-owner',
    recallContextTurns: 1,
    prefetch: false,
  })
  const failPreStep = failScope.ctx.listeners[0].fn
  const failTool = failScope.ctx.tools.registered[1] // same inherited array: [0] is the no-dir host tool
  await failTool.execute({ action: 'retain', text: 'The verdant lens focuses the south grid.' }, { signal: baseSignal })
  await failTool.execute({ action: 'retain', kind: 'directive', name: 'fail-rule', text: 'Fail owner rule: focus the south lens.' }, { signal: baseSignal })
  const failer = { session: makeSession('sess-fail', { agentPreset: 'fail-preset' }) }
  const failDecision = await runStep(failPreStep, failer, 1, [userMsg('aim the verdant lens')])
  const failCard = failDecision.messages.find(message => message.source?.kind === 'hindsight')
  assert.ok(failCard, 'a failed shadow listing does not discard the owner snapshot')
  assert.ok(failCard.content[0].text.includes('Hindsight bank "fail-owner" - follow them'), 'the owner rules section is intact')
  assert.ok(!failCard.content[0].text.includes('no-dir'), 'the failing shadow bank contributes no section')
  console.log('ok  mount seventeen: a failing shadow listing is merged away, the snapshot lands')
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
