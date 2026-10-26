import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { repoKey, writeJSON } from '../src/bridge.mjs'

const server = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
const mime = 'text/html;profile=mcp-app'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-pipeline-mcp-'))
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd, windowsHide: true }).status, 0)
  try { await run({ root, cwd, repo: repoKey(cwd), env: { ...process.env, AXMAP_REPO: cwd,
    AXMAP_AGENT: 'pipeline-test', AXMAP_STATE_DIR: path.join(root, 'state'), AXMAP_AGY_HOME: path.join(root, 'agy') } }) }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}
function client(cwd, env) {
  const process = spawn(globalThis.process.execPath, [server], { cwd, env, windowsHide: true })
  let sequence = 0, buffer = '', stderr = ''
  const waiting = new Map(), progress = []
  process.stderr.on('data', d => { stderr += d })
  process.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      const message = JSON.parse(line)
      if (message.method === 'notifications/progress') progress.push(message.params)
      else if (waiting.has(message.id)) { const done = waiting.get(message.id); waiting.delete(message.id); done(message) }
    }
  })
  const send = message => process.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const rpc = (method, params = {}) => {
    const id = ++sequence
    const pending = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP timeout: ${method}\n${stderr}`)) }, 15000)
      waiting.set(id, message => { clearTimeout(timer); resolve(message) }); send({ id, method, params })
    })
    pending.requestId = id
    return pending
  }
  const exit = new Promise(resolve => process.once('exit', resolve))
  return { rpc, progress, notify: (method, params) => send({ method, params }), close: async () => { process.stdin.end(); process.kill(); await exit } }
}
const initialize = (c, name, ui = false) => c.rpc('initialize', { protocolVersion: '2024-11-05',
  clientInfo: { name, version: 'contract-test' }, capabilities: ui ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [mime] } } } : {} })
const call = (c, name, args = {}, token) => c.rpc('tools/call', { name, arguments: args, ...(token === undefined ? {} : { _meta: { progressToken: token } }) })

for (const [name, ui] of [['chatgpt', true], ['claude-desktop', true], ['agy', false]]) {
  test(`${name}: capability-based UI or text fallback returns the same scoped pipeline`, async () => fixture(async ({ root, cwd, repo, env }) => {
    const id = randomUUID()
    writeJSON(path.join(root, 'state', 'bridge', 'requests', `${id}.json`), { id, to: randomUUID(), from: 'codex', repo,
      prompt: '검토 요청', createdAt: new Date().toISOString(), baseline: 0, state: 'completed', result: 'ok' })
    const c = client(cwd, env)
    try {
      const init = await initialize(c, name, ui)
      assert.ok(init.result.capabilities.resources)
      const listed = (await c.rpc('tools/list')).result.tools
      const view = listed.find(t => t.name === 'ax_pipeline')
      assert.ok(view)
      assert.equal(!!view._meta.ui?.resourceUri, ui)
      assert.equal(listed.some(t => t.name === 'ax_pipeline_state'), ui)
      const result = (await call(c, 'ax_pipeline')).result
      assert.equal(result.isError, false)
      assert.equal(result.structuredContent.display.mode, ui ? 'mcp-app' : 'text-progress')
      assert.equal(result.structuredContent.requests[0].id, id)
      assert.match(result.content[0].text, /완료 확인 ✓/)
      assert.ok(!JSON.stringify(result).includes('token-secret'))
      const resources = (await c.rpc('resources/list')).result.resources
      assert.equal(resources[0].mimeType, mime)
      const html = (await c.rpc('resources/read', { uri: resources[0].uri })).result.contents[0]
      assert.equal(html.mimeType, mime)
      assert.match(html.text, /ui\/initialize/)
      assert.match(html.text, /ax_pipeline_state/)
      assert.match(html.text, /Pretendard/)
      assert.deepEqual(html._meta.ui.csp.connectDomains, [])
      const invalid = await c.rpc('resources/read', { uri: 'file:///C:/secret' })
      assert.equal(invalid.error.code, -32602)
      assert.equal(fs.existsSync(path.join(cwd, '.axmap')), false)
    } finally { await c.close() }
  }))
}

test('agy-compatible progress uses the supplied token, increases, and stops at the response', async () => fixture(async ({ cwd, env }) => {
  const c = client(cwd, env)
  try {
    await initialize(c, 'agy')
    const response = await call(c, 'ax_pipeline_watch', { duration_ms: 1100, interval_ms: 500 }, 'watch-token')
    assert.equal(response.result.isError, false)
    assert.ok(c.progress.length >= 2)
    c.progress.forEach((event, index) => { assert.equal(event.progressToken, 'watch-token'); assert.equal(event.progress, index + 1); assert.equal(event.total, undefined); assert.match(event.message, /axMap/) })
    const count = c.progress.length; await pause(150); assert.equal(c.progress.length, count)
    await call(c, 'ax_pipeline_watch', { duration_ms: 25000 })
    assert.equal(c.progress.length, count, 'no made-up progress token without client opt-in')
  } finally { await c.close() }
}))

test('pipeline refresh stays responsive while an actual request result waits; no model re-submission', async () => fixture(async ({ root, cwd, repo, env }) => {
  const id = randomUUID(), jobId = randomUUID(), conversationId = randomUUID()
  const transcript = path.join(env.AXMAP_AGY_HOME, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
  fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, '')
  const sessionFile = path.join(env.AXMAP_STATE_DIR, 'bridge', 'sessions', `${id}.json`)
  const session = { id, provider: 'agy', transport: 'agentapi', conversationId, transcript, repos: [repo], workspaces: [cwd],
    event: 'PreInvocation', fullyIdle: false, registeredAt: new Date().toISOString(), token: 'token-secret' }
  writeJSON(sessionFile, session)
  writeJSON(path.join(env.AXMAP_STATE_DIR, 'bridge', 'requests', `${jobId}.json`), { id: jobId, to: id, repo, from: 'test', prompt: 'read only', createdAt: new Date().toISOString(), baseline: 0, state: 'submitted' })
  const c = client(cwd, env)
  try {
    await initialize(c, 'claude-desktop', true)
    let finished = false
    const waiting = call(c, 'ax_result', { id: jobId, wait_ms: 8000 }, 0).then(result => { finished = true; return result })
    const deadline = Date.now() + 5000
    while (!c.progress.length && Date.now() < deadline) await pause(20)
    assert.ok(c.progress.length)
    const snapshot = (await call(c, 'ax_pipeline_state', { cwd })).result
    assert.equal(snapshot.isError, false)
    assert.equal(snapshot.structuredContent.requests[0].state, 'submitted')
    assert.ok(!JSON.stringify(snapshot).includes('token-secret'))
    assert.equal(finished, false)
    fs.appendFileSync(transcript, JSON.stringify({ type: 'USER_INPUT', content: `[axMap request ${jobId}]` }) + '\n' + JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'done' }) + '\n')
    writeJSON(sessionFile, { ...session, event: 'Stop', fullyIdle: true, registeredAt: new Date(Date.now() + 1).toISOString() })
    const response = (await waiting).result
    assert.equal(JSON.parse(response.content[0].text).state, 'completed')
    assert.ok(c.progress.some(p => p.progressToken === 0 && p.message.includes('완료 확인')))
    assert.equal(fs.readdirSync(path.join(env.AXMAP_STATE_DIR, 'bridge', 'requests')).filter(f => f.endsWith('.json')).length, 1)
  } finally { await c.close() }
}))

test('cancelling a watch stops its progress, and invalid dispatch waits never submit work', async () => fixture(async ({ cwd, env }) => {
  const c = client(cwd, env)
  try {
    await initialize(c, 'agy')
    const watching = call(c, 'ax_pipeline_watch', { duration_ms: 15000, interval_ms: 500 }, 'cancel-watch')
    const deadline = Date.now() + 5000
    while (!c.progress.length && Date.now() < deadline) await pause(20)
    c.notify('notifications/cancelled', { requestId: watching.requestId, reason: 'test' })
    const ended = await watching
    assert.equal(ended.result.isError, true)
    const count = c.progress.length; await pause(600); assert.equal(c.progress.length, count)
    const invalid = (await call(c, 'ax_dispatch', { to: randomUUID(), prompt: 'never sent', wait_ms: 30001 }, 'invalid')).result
    assert.equal(invalid.isError, true)
    assert.match(invalid.content[0].text, /wait-ms/)
    assert.equal(fs.existsSync(path.join(env.AXMAP_STATE_DIR, 'bridge', 'requests')), false)
  } finally { await c.close() }
}))

test('cancellation during submission preserves the receipt and releases the dispatch lock', async () => fixture(async ({ cwd, repo, env }) => {
  const id = randomUUID(), conversationId = randomUUID()
  const transcript = path.join(env.AXMAP_AGY_HOME, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')
  fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, '')
  fs.writeFileSync(path.join(cwd, 'agentapi'), "const fs=require('fs');if(process.argv[2]==='send-message'){fs.appendFileSync('sent.log','sent\\n');console.log('{}')}else{setTimeout(()=>console.log('{}'),300)}")
  writeJSON(path.join(env.AXMAP_STATE_DIR, 'bridge', 'sessions', `${id}.json`), { id, provider: 'agy', transport: 'agentapi', executable: process.execPath,
    address: 'localhost:12345', repos: [repo], workspaces: [cwd], conversationId, transcript, event: 'Stop', fullyIdle: true, registeredAt: new Date().toISOString() })
  const c = client(cwd, env)
  try {
    await initialize(c, 'agy')
    const submission = call(c, 'ax_dispatch', { to: id, prompt: 'one submission', wait_ms: 10000 }, 'submit-token')
    const deadline = Date.now() + 5000
    while (!c.progress.length && Date.now() < deadline) await pause(10)
    assert.ok(c.progress.length)
    c.notify('notifications/cancelled', { requestId: submission.requestId })
    const answer = (await submission).result
    assert.equal(answer.isError, false)
    assert.equal(JSON.parse(answer.content[0].text).state, 'submitted')
    assert.equal(answer.structuredContent.observationCancelled, true)
    assert.equal(fs.readFileSync(path.join(cwd, 'sent.log'), 'utf8'), 'sent\n')
    const records = fs.readdirSync(path.join(env.AXMAP_STATE_DIR, 'bridge', 'requests'))
    assert.equal(records.filter(n => n.endsWith('.json')).length, 1)
    assert.equal(records.some(n => n.endsWith('.lock')), false)
  } finally { await c.close() }
}))
