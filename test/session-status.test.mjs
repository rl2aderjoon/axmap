import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startManagedSession } from '../src/managed-session.mjs'
import { sendTerminal } from '../src/terminal-bridge.mjs'
import { bridgeHome, repoKey, writeJSON } from '../src/bridge.mjs'
import { sessionStatus, formatSessionStatus } from '../src/session-status.mjs'

const exec = promisify(execFile)
const fixture = fileURLToPath(new URL('./fixtures/structured-cli.mjs', import.meta.url))
const cli = fileURLToPath(new URL('../bin/axmap.mjs', import.meta.url))

async function withRepo(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-activity-'))
  const saved = process.env.AXMAP_STATE_DIR
  process.env.AXMAP_STATE_DIR = path.join(cwd, 'state')
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0)
  try { await fn(cwd) } finally {
    if (saved === undefined) delete process.env.AXMAP_STATE_DIR; else process.env.AXMAP_STATE_DIR = saved
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

for (const provider of ['codex', 'agy']) test(`${provider}: local status observes idle, busy and closed without submitting work`, async () => withRepo(async cwd => {
  const events = []
  const s = await startManagedSession({ provider, executable: process.execPath, args: [fixture, provider, 'slow-dialogue'],
    cwd, role: '검토 담당', onEvent: event => events.push(event) })
  try {
    const [idle] = await sessionStatus(cwd)
    assert.equal(idle.state, 'idle')
    assert.equal(idle.connection, 'connected')
    assert.equal(idle.fullyIdle, true)
    const { stdout } = await exec(process.execPath, [cli, 'bridge', 'status', '--json'], { cwd, windowsHide: true })
    assert.equal(JSON.parse(stdout)[0].connection, 'connected')
    assert.ok(!stdout.includes('"token"'))
    assert.ok(!events.some(e => e.event === 'result'), 'status did not execute a model turn')
    assert.equal((await sessionStatus(cwd))[0].usage, null)
    await sendTerminal(s.id, { action: 'submit', request: { id: randomUUID(), to: s.id, prompt: 'Review.' } })
    const [busy] = await sessionStatus(cwd)
    assert.equal(busy.state, 'running')
    assert.equal(busy.connection, 'connected')
    assert.equal(busy.fullyIdle, false)
    assert.match(formatSessionStatus([busy]), /작업 중.*검토 담당/)
  } finally { s.close(); await s.exited }
  const [closed] = await sessionStatus(cwd)
  assert.equal(closed.state, 'closed')
  assert.equal(closed.connection, 'closed')
}))

test('pending approval is visible without answering it', async () => withRepo(async cwd => {
  const s = await startManagedSession({ provider: 'codex', executable: process.execPath, args: [fixture, 'codex', 'approval'], cwd })
  try {
    await sendTerminal(s.id, { action: 'submit', request: { id: randomUUID(), to: s.id, prompt: 'Review.' } })
    let status
    const deadline = Date.now() + 5000
    do {
      status = (await sessionStatus(cwd))[0]
      if (status.state === 'awaiting_user') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(status.state, 'awaiting_user')
    assert.equal(status.pendingApproval.id, 'approval-1')
    assert.match(formatSessionStatus([status]), /승인 대기/)
  } finally { s.close(); await s.exited }
}))

test('a silent local host times out instead of leaving status pending', async () => withRepo(async cwd => {
  const id = randomUUID(), sockets = new Set()
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\axmap-${id}` : path.join(bridgeHome(), `${id}.sock`)
  writeJSON(path.join(bridgeHome(), 'sessions', `${id}.json`), {
    id, provider: 'codex', transport: 'stdio', token: 'private', repos: [repoKey(cwd)], state: 'idle', fullyIdle: true,
  })
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve) })
  try {
    const [status] = await sessionStatus(cwd)
    assert.equal(status.connection, 'unreachable')
    assert.equal(status.state, 'unknown')
    assert.equal(status.fullyIdle, false)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}))

test('stale records and legacy hooks do not appear active; CLI remains repo scoped', async () => withRepo(async cwd => {
  const stale = { id: randomUUID(), provider: 'agy', transport: 'stdio', token: 'private-test-token',
    repos: [repoKey(cwd)], state: 'running', fullyIdle: false, registeredAt: new Date().toISOString() }
  writeJSON(path.join(bridgeHome(), 'sessions', `${stale.id}.json`), stale)
  const legacy = { ...stale, id: randomUUID(), transport: 'agentapi', state: 'idle', fullyIdle: true }
  writeJSON(path.join(bridgeHome(), 'sessions', `${legacy.id}.json`), legacy)
  const listed = await sessionStatus(cwd)
  assert.equal(listed.find(s => s.id === stale.id).connection, 'unreachable')
  assert.equal(listed.find(s => s.id === stale.id).state, 'unknown')
  assert.equal(listed.find(s => s.id === stale.id).lastKnownState, 'running')
  assert.equal(listed.find(s => s.id === legacy.id).connection, 'unverified')
  assert.ok(listed.every(s => s.state === 'unknown' && s.fullyIdle === false))
  const { stdout } = await exec(process.execPath, [cli, 'bridge', 'status'], { cwd, windowsHide: true })
  assert.match(stdout, /연결 확인 불가 · 상태 미확인/)
  assert.match(stdout, /확인 미지원 · 상태 미확인/)
  assert.ok(!stdout.includes(stale.token))
  const other = path.join(cwd, 'other'); fs.mkdirSync(other)
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: other }).status, 0)
  assert.deepEqual(await sessionStatus(other), [])
  assert.match(formatSessionStatus([]), /등록된 로컬 세션이 없습니다/)
  assert.ok(!formatSessionStatus([{ ...listed[0], role: '\x1b[2J\nnew line' }]).includes('\x1b'))
}))
