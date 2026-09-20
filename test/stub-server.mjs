// A stub Hindsight REST server: just enough of retain/recall/reflect/read/
// invalidate to exercise the plugin end-to-end, plus a request log for
// shape assertions.
import http from 'node:http'

// A memory unit's type: an experience marker stores a curatable raw fact,
// an observation is consolidated, everything else is a world fact.
const memoryType = memory => memory.experience ? 'experience' : memory.observation ? 'observation' : 'world'

export const state = {
  memories: [],
  directives: [],
  requests: [],
  nextId: 1,
  bankConfigs: {},
  // when > 0, recall responses are held this many ms before sending —
  // models a slow bank (the prefetch budget and the synchronous fallback
  // both depend on it).
  recallDelayMs: 0,
}

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const parts = url.pathname.split('/')
    // /v1/default/banks/{bank}/...
    const bank = parts[4]
    const rest = parts.slice(5)
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    let data = {}
    try { data = body.length > 0 ? JSON.parse(body) : {} } catch { data = { error: 'unparseable body' } }
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, bank, body: data, authorization: req.headers.authorization ?? null })

    if (req.method === 'POST' && rest[0] === 'memories' && rest.length === 1) {
      // retain. A retained text marked `[observation] ...` is stored as an
      // observation fact (marker stripped) so recall can exercise the
      // observation type and its source-fact provenance; `[experience] ...`
      // likewise stores an experience fact (a raw lesson, curatable).
      const items = Array.isArray(data.items) ? data.items : []
      for (const item of items) {
        const content = String(item.content ?? '')
        const isObservation = content.startsWith('[observation] ')
        const isExperience = content.startsWith('[experience] ')
        const memory = {
          id: `m${state.nextId++}`,
          bank,
          text: isObservation
            ? content.slice('[observation] '.length)
            : isExperience ? content.slice('[experience] '.length) : content,
          observation: isObservation,
          experience: isExperience,
          tags: Array.isArray(item.tags) ? [...item.tags] : [],
        }
        // Emulate consolidation: the observation is backed by the most
        // recent raw fact in the same bank — its curatable source fact.
        if (isObservation) {
          const backing = [...state.memories].reverse().find(candidate => candidate.bank === bank && !candidate.observation)
          memory.source_fact_ids = backing ? [backing.id] : []
        }
        state.memories.push(memory)
      }
      return json(200, { success: true, bank_id: bank, items_count: items.length, async: Boolean(data.async) })
    }
    if (req.method === 'POST' && rest[0] === 'memories' && rest[1] === 'recall') {
      // recall. A configured delay models a slow bank (the request is
      // logged NOW; the response is held).
      const respond = () => handleRecall(bank, data, json)
      if (state.recallDelayMs > 0) return setTimeout(respond, state.recallDelayMs)
      return respond()
    }
    function handleRecall(bank, data, json) {
      // the 'broken' bank always fails recall (the failed-prefetch check)
      if (bank === 'broken') return json(500, { error: 'stub: broken bank' })
      let hits = state.memories.filter(memory => memory.bank === bank && !memory.invalidated)
      if (Array.isArray(data.tags) && data.tags.length > 0) {
        const strict = String(data.tags_match ?? 'any').endsWith('_strict')
        hits = hits.filter(memory => strict
          ? data.tags.every(tag => memory.tags.includes(tag))
          : memory.tags.length === 0 || data.tags.some(tag => memory.tags.includes(tag)))
      }
      if (Array.isArray(data.types) && data.types.length > 0) {
        hits = hits.filter(memory => data.types.includes(memoryType(memory)))
      }
      const words = String(data.query ?? '').toLowerCase().split(/\W+/).filter(word => word.length > 3)
      const results = hits
        .filter(memory => words.some(word => memory.text.toLowerCase().includes(word)))
        .map(memory => {
          const hit = { id: memory.id, text: memory.text, type: memoryType(memory), tags: memory.tags }
          if (memory.observation) hit.source_fact_ids = memory.source_fact_ids
          // Deterministic score, like the real server: the query-word overlap,
          // exposed on every result under `scores` (the plugin renders
          // reranker ?? final from it).
          const text = memory.text.toLowerCase()
          const overlap = words.filter(word => text.includes(word)).length
          hit.scores = { final: overlap, reranker: overlap, semantic: overlap, keyword: overlap }
          return hit
        })
      // Provenance, like the real server: sent only when the client requests
      // it, and only observation hits are backed by source facts. An
      // invalidated backing fact is no longer a source fact (the client
      // skips the missing entry).
      const sourceFacts = {}
      if (data.include !== undefined && data.include !== null && data.include.source_facts !== undefined) {
        for (const hit of results) {
          for (const id of hit.source_fact_ids ?? []) {
            const backing = state.memories.find(candidate => candidate.id === id && !candidate.invalidated)
            if (backing !== undefined) sourceFacts[id] = { id, text: backing.text }
          }
        }
      }
      return json(200, Object.keys(sourceFacts).length > 0 ? { results, source_facts: sourceFacts } : { results })
    }
    if (req.method === 'GET' && rest[0] === 'memories' && rest.length === 2) {
      // Read one memory by id (the real server's GET /memories/{id}): the
      // unit's text and type, and — like the real server — for an
      // observation the source facts folded in (ids + texts). Invalidated
      // units still resolve (they keep their bookkeeping in the archive).
      const memory = state.memories.find(candidate => candidate.id === rest[1] && candidate.bank === bank)
      if (memory === undefined) return json(404, { error: `stub: Memory unit '${rest[1]}' not found` })
      const unit = {
        id: memory.id,
        text: memory.text,
        type: memoryType(memory),
        state: memory.invalidated ? 'invalidated' : 'valid',
      }
      if (memory.observation) {
        const sources = (memory.source_fact_ids ?? [])
          .map(id => state.memories.find(candidate => candidate.id === id))
          .filter(candidate => candidate !== undefined)
        unit.source_memory_ids = sources.map(candidate => candidate.id)
        unit.source_memories = sources.map(candidate => ({
          id: candidate.id,
          text: candidate.text,
          type: memoryType(candidate),
        }))
      }
      return json(200, unit)
    }
    if (req.method === 'PATCH' && rest[0] === 'memories' && rest.length === 2) {
      // update a memory (invalidation). Like the real server: soft — the
      // memory is archived, excluded from recall, and restorable.
      const memory = state.memories.find(candidate => candidate.id === rest[1] && candidate.bank === bank)
      if (memory === undefined) return json(404, { error: `stub: no memory ${rest[1]} in bank ${bank}` })
      // Like the real server: only raw facts can be curated; observations
      // are derived (their backing fact is the curatable handle). The real
      // server answers this with HTTP 400 ("is a observation; only
      // world/experience facts can be curated").
      if (memory.observation) return json(400, { error: `stub: ${memory.id} is a observation; only world/experience facts can be curated` })
      if (data.state === 'invalidated') {
        memory.invalidated = true
        memory.invalidate_reason = data.reason ?? null
        return json(200, { id: memory.id, bank_id: bank, state: 'invalidated', reason: data.reason ?? null })
      }
      if (data.state === 'valid') {
        memory.invalidated = false
        memory.invalidate_reason = null
        return json(200, { id: memory.id, bank_id: bank, state: 'valid' })
      }
      return json(422, { error: `stub: unknown state ${JSON.stringify(data.state)}` })
    }
    if (req.method === 'PATCH' && rest[0] === 'config') {
      // per-bank config update; the bank 'flaky' rejects it to exercise the
      // plugin's "a failed sync never blocks the operation, and the next
      // operation retries" path.
      if (bank === 'flaky') return json(500, { error: 'stub: flaky bank' })
      state.bankConfigs[bank] = { ...(state.bankConfigs[bank] ?? {}), ...(data.updates ?? {}) }
      return json(200, { bank_id: bank, overrides: state.bankConfigs[bank] })
    }
    if (req.method === 'GET' && rest[0] === 'directives') {
      // list active directives; like recall, untagged (global) directives are
      // included in every mode, and a tag filter selects matching tiers
      let items = state.directives.filter(directive => directive.bank === bank && directive.is_active !== false)
      const tagsParam = url.searchParams.get('tags')
      if (tagsParam !== null && tagsParam.length > 0) {
        const tags = tagsParam.split(',').filter(tag => tag.length > 0)
        items = items.filter(directive => directive.tags.length === 0 || tags.some(tag => directive.tags.includes(tag)))
      }
      return json(200, { items })
    }
    if (req.method === 'POST' && rest[0] === 'directives' && rest.length === 1) {
      // create directive
      state.directives.push({
        id: `d${state.nextId++}`,
        bank,
        name: String(data.name ?? ''),
        content: String(data.content ?? ''),
        priority: typeof data.priority === 'number' ? data.priority : 0,
        is_active: data.is_active !== false,
        tags: Array.isArray(data.tags) ? [...data.tags] : [],
      })
      const created = state.directives.at(-1)
      return json(200, { id: created.id, bank_id: bank, name: created.name })
    }
    if (req.method === 'POST' && rest[0] === 'reflect') {
      // reflect
      const basedOn = state.memories
        .filter(memory => memory.bank === bank && !memory.invalidated)
        .map(memory => memory.id)
      return json(200, { text: `FAKE-REFLECT:${data.query}`, based_on: basedOn })
    }
    json(404, { error: `stub: no route for ${req.method} ${url.pathname}` })
  })
})

export async function start(port = 18888) {
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  return {
    port,
    async stop() {
      await new Promise(resolve => server.close(resolve))
    },
  }
}
