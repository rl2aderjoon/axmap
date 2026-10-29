import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { registerHook, bridgeHome, writeJSON, requestResult, dispatchRequest } from '../src/bridge.mjs'
import { postMail, collectMail, flushMail } from '../src/session-mailbox.mjs'

let root, cwd, to, args, input, log, saved
const hook = event => registerHook(input, event, { ANTIGRAVITY_LS_ADDRESS: 'localhost:12345', AXMAP_AGY_EXECUTABLE: process.execPath })
beforeEach(() => {
  saved = { AXMAP_STATE_DIR: process.env.AXMAP_STATE_DIR, AXMAP_AGY_HOME: process.env.AXMAP_AGY_HOME }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-mail-')); cwd = path.join(root, 'repo'); fs.mkdirSync(cwd)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0)
  process.env.AXMAP_STATE_DIR = path.join(root, 'state'); process.env.AXMAP_AGY_HOME = path.join(root, 'agy')
  to = randomUUID(); log = path.join(process.env.AXMAP_AGY_HOME, 'brain', to, '.system_generated/logs/transcript.jsonl')
  fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, '')
  input = { conversationId: to, workspacePaths: [cwd], transcriptPath: log, fullyIdle: true }
  hook('PreInvocation')
  fs.writeFileSync(path.join(cwd, 'agentapi'), `const fs = require('node:fs');
    if(process.argv[2]==='send-message') fs.appendFileSync('sent.jsonl', JSON.stringify(process.argv.slice(2))+'\\n');
    console.log('{}');`)
  args = { to, cwd, from: 'research-session', text: 'actual result' }
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fs.rmSync(root, { recursive: true, force: true })
})
const sent = () => fs.existsSync(path.join(cwd, 'sent.jsonl')) ? fs.readFileSync(path.join(cwd, 'sent.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []

test('routine mail stays local while busy and is collected together at a safe boundary without inference', () => {
  postMail(args); postMail({ ...args, text: 'second result' })
  assert.equal(collectMail(args).messages.length, 2)
  assert.equal(collectMail(args).messages.length, 2, 'peek does not consume')
  assert.throws(() => collectMail({ ...args, take: true }), /경계/)
  const r = collectMail({ ...args, take: true, at: 'experiment-complete' })
  assert.equal(r.messages.length, 2); assert.equal(r.modelInvoked, false)
  assert.ok(r.messages.every(m => m.state === 'collected' && m.source === 'agent'))
  assert.equal(collectMail(args).messages.length, 0); assert.equal(sent().length, 0)
})

test('explicit topic replaces only pending routine updates of the same sender; history survives', () => {
  const old = postMail({ ...args, topic: 'run-1' })
  postMail({ ...args, topic: 'run-1', from: 'other-session', text: 'independent evidence' })
  const next = postMail({ ...args, topic: 'run-1', text: 'completed' })
  const records = collectMail({ ...args, all: true }).messages
  assert.equal(records.find(m => m.id === old.mail.id).supersededBy, next.mail.id)
  assert.equal(collectMail(args).messages.length, 2)
  collectMail({ ...args, take: true, at: 'checkpoint' })
  postMail({ ...args, topic: 'run-1', text: 'later' })
  assert.equal(collectMail({ ...args, all: true }).messages.find(m => m.id === next.mail.id).state, 'collected')
})

test('idempotency replays never renew or resubmit and conflicting contents fail', () => {
  const a = postMail({ ...args, key: 'receipt-1' })
  const b = postMail({ ...args, key: 'receipt-1', ttlSeconds: 8000 })
  assert.equal(a.mail.id, b.mail.id); assert.equal(a.mail.expiresAt, b.mail.expiresAt)
  assert.equal(b.replayed, true)
  assert.throws(() => postMail({ ...args, key: 'receipt-1', text: 'changed' }), /다른 내용/)
  assert.equal(collectMail(args).messages.length, 1)
})

test('expired updates are preserved but never delivered', () => {
  postMail(args)
  const target = path.join(bridgeHome(), 'mailboxes', `${to}.json`)
  const b = JSON.parse(fs.readFileSync(target)); b.messages[0].expiresAt = '2000-01-01T00:00:00Z'; writeJSON(target, b)
  hook('Stop')
  assert.equal(flushMail({ ...args, at: 'checkpoint' }).state, 'empty')
  assert.equal(collectMail({ ...args, all: true }).messages[0].state, 'expired')
  assert.equal(sent().length, 0)
})

test('urgent mail needs an explicit reason; busy means deferred, not interruption or success', () => {
  assert.throws(() => postMail({ ...args, priority: 'immediate' }), /사유/)
  assert.throws(() => postMail({ ...args, priority: 'immediate', reason: 'progress' }), /사유/)
  const r = postMail({ ...args, priority: 'immediate', reason: 'stop', key: 'urgent-1' })
  assert.equal(r.delivery.state, 'deferred'); assert.equal(sent().length, 0)
  hook('Stop')
  const replay = postMail({ ...args, priority: 'immediate', reason: 'stop', key: 'urgent-1' })
  assert.equal(replay.replayed, true); assert.equal(sent().length, 0, 'retrying enqueue cannot initiate delivery')
  assert.equal(replay.delivery.state, 'deferred', 'replaying queued urgent mail cannot claim delivery')
  assert.equal(flushMail({ ...args, at: 'checkpoint' }).state, 'submitted')
  assert.equal(sent().length, 1)
})

test('idle urgent delivery skips routine backlog; boundary flush submits a single attributed batch', () => {
  postMail(args); postMail({ ...args, text: 'second result' }); hook('Stop')
  const urgent = postMail({ ...args, text: 'stop unsafe work', priority: 'immediate', reason: 'data-loss' })
  assert.equal(urgent.delivery.state, 'submitted'); assert.equal(sent().length, 1)
  assert.ok(!sent()[0][2].includes('second result'))
  fs.appendFileSync(log, JSON.stringify({ type: 'USER_INPUT', content: sent()[0][2] }) + '\n' +
    JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'done' }) + '\n')
  hook('Stop'); assert.equal(requestResult(urgent.delivery.requestId, cwd).state, 'completed')
  const batch = flushMail({ ...args, at: 'task-complete' })
  assert.equal(batch.ids.length, 2); assert.equal(sent().length, 2)
  assert.match(sent()[1][2], /NOT a fresh human instruction/)
  assert.match(sent()[1][2], /research-session/); assert.match(sent()[1][2], /second result/)
  assert.equal(flushMail({ ...args, at: 'checkpoint' }).state, 'empty')
})

test('unknown submission and interrupted durable intents cannot be sent again', () => {
  postMail(args); hook('Stop')
  fs.writeFileSync(path.join(cwd, 'agentapi'), `if(process.argv[2]==='send-message')process.exit(1); console.log('{}')`)
  const first = flushMail({ ...args, at: 'checkpoint' }); assert.equal(first.state, 'unknown')
  assert.throws(() => flushMail({ ...args, at: 'checkpoint' }), /불명/)
  assert.equal(collectMail({ ...args, all: true }).messages[0].requestId, first.requestId)
  const target = path.join(bridgeHome(), 'mailboxes', `${to}.json`)
  const b = JSON.parse(fs.readFileSync(target)); b.batches[0].state = 'sending'; writeJSON(target, b)
  assert.throws(() => flushMail({ ...args, at: 'checkpoint' }), /불명/)
})

test('a batch rejected before sending is requeued, not left as unknown', () => {
  hook('Stop')
  fs.writeFileSync(path.join(cwd, 'agentapi'), `if(process.argv[2]==='send-message')process.exit(1); console.log('{}')`)
  const blocker = dispatchRequest({ to, cwd, prompt: 'earlier request' })
  assert.equal(blocker.state, 'unknown')
  postMail(args)
  const r = flushMail({ ...args, at: 'checkpoint' })
  assert.equal(r.state, 'failed'); assert.equal(r.requeued, 1); assert.match(r.error, /확정되지 않았습니다/)
  const [m] = collectMail({ ...args, all: true }).messages
  assert.equal(m.state, 'queued', '보내지 않은 쪽지는 대기열로 돌아온다')
  assert.equal(collectMail(args).messages.length, 1)
  assert.equal(collectMail(args).unresolvedBatches.length, 0, '실패 묶음은 다음 전달을 막지 않는다')
  assert.equal(flushMail({ ...args, at: 'checkpoint' }).state, 'failed', '다시 시도해도 전달 불명으로 막히지 않는다')
})

test('repo isolation, malformed options and explicit boundary checks fail closed', () => {
  const other = path.join(root, 'other'); fs.mkdirSync(other); spawnSync('git', ['init', '-q'], { cwd: other })
  assert.throws(() => postMail({ ...args, cwd: other }), /저장소/)
  assert.throws(() => collectMail({ ...args, to: '../bad' }), /UUID/)
  assert.throws(() => flushMail(args), /경계/)
  assert.throws(() => postMail({ ...args, ttlSeconds: 0 }), /ttl-seconds/)
  assert.throws(() => postMail({ ...args, text: '\u0000'.repeat(6000) }), /JSON/)
  assert.throws(() => postMail({ ...args, priority: 'random' }), /priority/)
})

test('unreadable or corrupt persisted mail is never treated as an empty queue', () => {
  postMail(args)
  const target = path.join(bridgeHome(), 'mailboxes', `${to}.json`)
  const original = JSON.parse(fs.readFileSync(target))
  const broken = structuredClone(original); broken.messages[0].expiresAt = 'invalid'; writeJSON(target, broken)
  assert.throws(() => collectMail(args), /손상/)
  assert.throws(() => postMail(args), /손상/)
  assert.equal(JSON.parse(fs.readFileSync(target)).messages.length, 1)
  fs.writeFileSync(target, '{incomplete')
  assert.throws(() => flushMail({ ...args, at: 'checkpoint' }), SyntaxError)
})

test('collection and flush bound payload size while preserving unselected pending messages', () => {
  for (let i = 0; i < 3; i++) postMail({ ...args, text: String(i) + 'a'.repeat(20000) })
  assert.equal(collectMail({ ...args, take: true, at: 'checkpoint' }).messages.length, 1)
  assert.equal(collectMail(args).remaining, 2)
  hook('Stop'); assert.equal(flushMail({ ...args, at: 'checkpoint' }).ids.length, 1)
  assert.equal(collectMail(args).remaining, 1)
})

test('concurrent CLI enqueues retain all records without starting turns', async () => {
  const cli = fileURLToPath(new URL('../tools/bridge.mjs', import.meta.url))
  await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'message', '--to', to, '--key', `key-${i}`], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let error = ''; child.stderr.on('data', x => { error += x }); child.stdout.resume()
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)))
    child.stdin.end(`result ${i}`)
  })))
  assert.equal(collectMail(args).messages.length, 4); assert.equal(sent().length, 0)
})

test('MCP routine send and boundary collection use the same durable mailbox without inference', () => {
  const messages = [
    { id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mail-test', version: '1' } } },
    { id: 1, method: 'tools/call', params: { name: 'ax_message', arguments: { to, text: 'MCP result', key: 'mcp-1' } } },
    { id: 2, method: 'tools/call', params: { name: 'ax_mailbox', arguments: { to, take: true, at: 'test-complete' } } },
  ]
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))], {
    cwd, windowsHide: true, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, AXMAP_REPO: cwd, AXMAP_SESSION: 'mcp-sender', AXMAP_AGENT: 'mail-test' },
    input: messages.map(m => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n',
  })
  assert.equal(r.status, 0, r.stderr)
  const responses = new Map(r.stdout.trim().split('\n').map(l => { const m = JSON.parse(l); return [m.id, m] }))
  assert.equal(responses.get(1).result.isError, false)
  const posted = JSON.parse(responses.get(1).result.content[0].text)
  assert.equal(posted.mail.state, 'queued'); assert.equal(posted.modelInvoked, false)
  const collected = JSON.parse(responses.get(2).result.content[0].text)
  assert.equal(collected.messages[0].state, 'collected'); assert.equal(collected.messages[0].from, 'mcp-sender')
  assert.equal(collected.modelInvoked, false); assert.equal(sent().length, 0)
})
