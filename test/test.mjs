// Smoke test for the userland hindsight plugin, driven against the stub
// Hindsight server: export shape, Config validation (one mount, one bank,
// the retainScope tier default, the apiKeyRef grammar + mutual exclusion
// with apiKey), per-mount bank behavior (banks are the OUTER isolation;
// inside a bank, the three visibility tiers), authorization (literal key,
// credential ref via the seam, ref via the environment fallback), tool
// execution (retain / recall / reflect, with tier tags, plus standing
// directives: kind: directive, tier-scoped listing, rules-on-empty-recall),
// and the automatic pre-step recall: snapshot rows ride the pre-step
// decision (landing AFTER the triggering message) and are only ever
// appended — the plugin never replaces or erases a previous snapshot.
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
  retainAsync: false,
  maxRecallTokens: 1024,
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
// semantics modeled here are the ones the plugin relies on: a replace
// shadows every node in [start, end] and the new node joins the surface.
function makeSession(id, header = {}) {
  let seq = 0
  const session = {
    id,
    header,
    events: [],
    surface: { nodes: [] },
    append(type, data, opts = {}) {
      seq += 1
      const op = opts.surfaceOp ?? 'append'
      const event = { seq, type, data }
      if (op !== 'append') {
        for (let i = session.surface.nodes.length - 1; i >= 0; i -= 1) {
          if (session.surface.nodes[i] >= op.start && session.surface.nodes[i] <= op.end) {
            session.surface.nodes.splice(i, 1)
          }
        }
      }
      session.surface.nodes.push(seq)
      event.surfaceOp = op
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
{
  const ctx = makeCtx()
  plugin.apply(ctx, { ...standard.value, baseUrl: stubUrl })
  assert.equal(ctx.tools.registered.length, 1)
  const tool = ctx.tools.registered[0]
  const listener = ctx.listeners[0].fn
  assert.equal(tool.name, 'hindsight')
  assert.deepEqual(tool.parameters.properties.action.enum, ['retain', 'recall', 'reflect'])
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

  // recall — the stored memory comes back; without an agent in the
  // execution there is no session context, hence no tier filter
  const recallResult = await tool.execute({ action: 'recall', query: 'which editor does the user prefer?' }, { signal: baseSignal })
  assert.match(recallResult.text, /prefers tabs over spaces/)
  const recallReq = state.requests.at(-1)
  assert.equal(recallReq.path, '/v1/default/banks/hermes/memories/recall')
  assert.equal(recallReq.body.max_tokens, 1024)
  assert.equal(recallReq.body.tags, undefined, 'no agent context: no tier filter')
  console.log('ok  mount A: recall returns the stored memory (no agent → whole bank visible)')

  // reflect — synthesized answer
  const reflectResult = await tool.execute({ action: 'reflect', query: 'what do we know about their editor?' }, { signal: baseSignal })
  assert.match(reflectResult.text, /^FAKE-REFLECT:/)
  console.log('ok  mount A: reflect → POST .../reflect {query}')

  // argument validation still runs through defineTool
  await assert.rejects(() => tool.execute({ action: 'retain' }, { signal: baseSignal }), /text/)
  await assert.rejects(() => tool.execute({ action: 'recall' }, { signal: baseSignal }), /query/)
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

  // Unchanged snapshot: identical hits are not re-committed (no churn, no
  // duplicate row) — the still-accurate snapshot stays where it is.
  const snapsUnchanged = snapshots(agent.session).length
  const d4unchanged = await runStep(listener, agent, 1, [userMsg('which node runtime does the demo build use?')])
  assert.equal(d4unchanged.messages.length, 1, 'an unchanged recall appends no row')
  assert.equal(snapshots(agent.session).length, snapsUnchanged, 'an unchanged snapshot is not re-committed')
  console.log('ok  mount A: an unchanged snapshot is not re-committed')

  // step 2 and subagents pass through unchanged, without committing snapshots
  const d4 = await runStep(listener, agent, 2, [userMsg('steering mid-turn')])
  assert.equal(d4.messages.length, 1)
  assert.equal(snapshots(agent.session).length, snapsUnchanged, 'step 2 commits no snapshot')
  const d5 = await runStep(listener, subagent, 1, [userMsg('subagent work')])
  assert.equal(d5.messages.length, 1)
  assert.equal(snapshots(subagent.session).length, 0, 'subagents get no snapshot')
  // rejections pass through untouched
  const reject = await listener({ agent, messages: [userMsg('x')], turn: 9, step: 1, signal: baseSignal }, async () => ({ kind: 'reject' }))
  assert.equal(reject.kind, 'reject')
  console.log('ok  mount A: step 2, subagents, and rejections pass through')
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
