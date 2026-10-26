import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const html = fs.readFileSync(fileURLToPath(new URL('../mcp/pipeline.html', import.meta.url)), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const snapshot = (state = 'submitted', cwd = '/work/repo') => ({ schemaVersion: 1, type: 'pipeline', cwd, checkedAt: '2026-10-26T00:00:00Z',
  sessions: [{ id: 'session-id', provider: 'agy', state: 'unknown', connection: 'connected' }],
  requests: [{ id: 'request-id', to: 'session-id', from: 'codex', state, task: '<script>must stay text</script>' }], events: [], issues: [] })

async function host({ capabilities = { serverTools: {} }, failInitialize = false, alias = false } = {}) {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.dataset = {}; this.handlers = {}; this.style = { setProperty() {} } }
    append(...elements) { this.children.push(...elements) }
    replaceChildren(...elements) { this.children = elements; this.textContent = '' }
    setAttribute() {}
    addEventListener(name, action) { this.handlers[name] = action }
    getBoundingClientRect() { return { height: 300 } }
  }
  const nodes = Object.fromEntries(['axmap-pipeline','status','scope','sessions','jobs','issue','events','checked','pause'].map(id => [id, new Element('div')]))
  const windowEvents = {}, documentEvents = {}, sent = [], timers = new Map()
  let sequence = 0, data = snapshot(), error = false, calls = 0, aliasCalls = 0
  const document = { hidden: false, body: new Element('body'), documentElement: new Element('html'),
    getElementById: id => nodes[id], createElement: tag => new Element(tag), addEventListener: (name, action) => { documentEvents[name] = action } }
  const reply = message => windowEvents.message({ source: parent, data: message })
  const parent = { postMessage(message) {
    sent.push(message)
    if (message.method === 'ui/initialize') queueMicrotask(() => reply({ jsonrpc: '2.0', id: message.id,
      ...(failInitialize ? { error: { message: 'unsupported' } } : { result: { hostCapabilities: capabilities, hostContext: { theme: 'dark' } } }) }))
    if (message.method === 'tools/call') {
      calls++
      queueMicrotask(() => reply({ jsonrpc: '2.0', id: message.id, result: error ? { isError: true, content: [{ text: 'disconnected' }] } : { structuredContent: data } }))
    }
  } }
  const window = { parent, addEventListener: (name, action) => { windowEvents[name] = action } }
  if (alias) window.openai = { callTool: async () => { aliasCalls++; return { structuredContent: data } } }
  const context = { document, window, setTimeout(action, ms) { const id = ++sequence; timers.set(id, { action, ms }); return id },
    clearTimeout(id) { timers.delete(id) }, ResizeObserver: class { observe() {} disconnect() {} } }
  vm.runInNewContext(script, context)
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  await flush()
  return { nodes, document, sent, timers, windowEvents, documentEvents, flush, reply,
    calls: () => calls, aliasCalls: () => aliasCalls, setData: value => { data = value }, setError: value => { error = value },
    async refresh() { const item = [...timers.entries()].find(([,timer]) => timer.ms === 1200); assert.ok(item); timers.delete(item[0]); item[1].action(); await flush() } }
}
const content = node => [node.textContent, ...node.children.map(content)].join(' ')

test('portable host handshake drives actual state updates, pauses and never turns text into HTML', async () => {
  const ui = await host()
  assert.equal(ui.sent[0].method, 'ui/initialize')
  assert.equal(ui.sent[1].method, 'ui/notifications/initialized')
  assert.equal(ui.sent[2].method, 'tools/call')
  assert.equal(ui.sent[2].params.name, 'ax_pipeline_state')
  assert.equal(ui.document.documentElement.dataset.theme, 'dark')
  assert.equal(ui.document.body.dataset.live, 'true')
  assert.match(content(ui.nodes.jobs), /응답 대기/)
  assert.match(content(ui.nodes.jobs), /<script>must stay text<\/script>/)
  ui.setData(snapshot('completed')); await ui.refresh()
  assert.ok(ui.nodes.jobs.children[0].children[1].children.every(s => s.className.includes('done')))
  const calls = ui.calls(); ui.nodes.pause.handlers.click()
  assert.equal(ui.document.body.dataset.live, 'false')
  assert.ok(![...ui.timers.values()].some(timer => timer.ms === 1200))
  ui.nodes.pause.handlers.click(); await ui.flush(); assert.equal(ui.calls(), calls + 1)
  ui.document.hidden = true; ui.documentEvents.visibilitychange()
  assert.equal(ui.document.body.dataset.live, 'false')
  assert.ok(![...ui.timers.values()].some(timer => timer.ms === 1200))
  assert.ok(!html.includes('innerHTML'))
  assert.ok(!html.includes('fetch('))
})
test('unsupported and disconnected hosts do not pretend to be live; scope stays bound', async () => {
  const unsupported = await host({ capabilities: {} })
  assert.equal(unsupported.calls(), 0)
  assert.equal(unsupported.document.body.dataset.live, 'false')
  assert.match(unsupported.nodes.issue.textContent, /ax_pipeline_watch/)
  const ui = await host(); ui.setError(true); await ui.refresh()
  assert.equal(ui.document.body.dataset.live, 'false')
  assert.match(ui.nodes.issue.textContent, /disconnected/)
  ui.setError(false); ui.setData(snapshot('completed', '/another/repo')); await ui.refresh()
  assert.equal(ui.nodes.scope.textContent, '/work/repo')
  assert.match(ui.nodes.issue.textContent, /다른 저장소/)
})
test('OpenAI compatibility is capability detected rather than tied to a client name', async () => {
  const ui = await host({ failInitialize: true, alias: true })
  assert.equal(ui.aliasCalls(), 1)
  assert.equal(ui.document.body.dataset.live, 'true')
  assert.match(content(ui.nodes.jobs), /응답 대기/)
})
