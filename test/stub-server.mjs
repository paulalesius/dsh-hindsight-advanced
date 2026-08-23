// A stub Hindsight REST server: just enough of retain/recall/reflect to
// exercise the plugin end-to-end, plus a request log for shape assertions.
import http from 'node:http'

export const state = {
  memories: [],
  directives: [],
  requests: [],
  nextId: 1,
  bankConfigs: {},
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
      // retain
      const items = Array.isArray(data.items) ? data.items : []
      for (const item of items) {
        state.memories.push({
          id: `m${state.nextId++}`,
          bank,
          text: String(item.content ?? ''),
          tags: Array.isArray(item.tags) ? [...item.tags] : [],
        })
      }
      return json(200, { success: true, bank_id: bank, items_count: items.length, async: Boolean(data.async) })
    }
    if (req.method === 'POST' && rest[0] === 'memories' && rest[1] === 'recall') {
      // recall
      let hits = state.memories.filter(memory => memory.bank === bank)
      if (Array.isArray(data.tags) && data.tags.length > 0) {
        const strict = String(data.tags_match ?? 'any').endsWith('_strict')
        hits = hits.filter(memory => strict
          ? data.tags.every(tag => memory.tags.includes(tag))
          : memory.tags.length === 0 || data.tags.some(tag => memory.tags.includes(tag)))
      }
      const words = String(data.query ?? '').toLowerCase().split(/\W+/).filter(word => word.length > 3)
      const results = hits
        .filter(memory => words.some(word => memory.text.toLowerCase().includes(word)))
        .map(memory => ({ id: memory.id, text: memory.text, type: 'world', tags: memory.tags }))
      return json(200, { results })
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
      const basedOn = state.memories.filter(memory => memory.bank === bank).map(memory => memory.id)
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
