import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startManagedSession } from '../src/managed-session.mjs'
import { sendTerminal } from '../src/terminal-bridge.mjs'
import { websocketFrame } from '../src/codex-connection.mjs'
const fixture = fileURLToPath(new URL('./fixtures/codex-proxy.mjs', import.meta.url))
async function repo(mode, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-codex-connect-'))
  const saved = { AXMAP_STATE_DIR: process.env.AXMAP_STATE_DIR, AXMAP_PROXY_TEST_MODE: process.env.AXMAP_PROXY_TEST_MODE }
  process.env.AXMAP_STATE_DIR = path.join(root, 'state'); process.env.AXMAP_PROXY_TEST_MODE = mode
  spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
  try { await run({ provider: 'codex', executable: process.execPath, prefix: [fixture], existingThreadId: randomUUID(), socketPath: path.join(root, 'control.sock'), cwd: root, maxTokens: 1000 }) }
  finally { for (const [k,v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
}
test('existing idle thread uses daemon proxy, keeps context/config and measures later deltas without counting old usage', async () => repo('idle', async options => {
  const session = await startManagedSession(options)
  try {
    assert.equal(session.conversationId, options.existingThreadId)
    for (let i = 0; i < 2; i++) {
      const id = randomUUID(); await sendTerminal(session.id, { action: 'submit', request: { id, to: session.id, prompt: 'hello', from: 'test' } })
      let r; const deadline = Date.now() + 3000
      do { r = await sendTerminal(session.id, { action: 'result', id }); if (r.state === 'completed') break; await new Promise(resolve => setTimeout(resolve, 15)) } while (Date.now() < deadline)
      assert.equal(r.state, 'completed'); assert.equal(r.result, 'same-thread reply'); assert.equal(r.conversationId, options.existingThreadId)
      assert.equal(r.usage?.totalTokens ?? null, i === 0 ? null : 110)
    }
  } finally { session.close(); await session.exited }
}))
for (const [mode, error] of [['busy', /idle/], ['wrong-thread', /ID/], ['bad-handshake', /handshake/]]) test(`existing session rejects ${mode} without new-thread fallback`, async () => repo(mode, async options => {
  await assert.rejects(startManagedSession(options), error)
}))
test('active observation attaches without a model turn and refuses submission', async () => repo('busy', async options => {
  const session = await startManagedSession({ ...options, observeActive: true })
  try {
    const status = await sendTerminal(session.id, { action: 'status' }); assert.equal(status.state, 'running')
    const notice = await sendTerminal(session.id, { action: 'notice', text: 'User-requested routing policy; no reply requested.' }); assert.equal(notice.modelInvoked, false); assert.equal(notice.state, 'context_recorded')
    await assert.rejects(sendTerminal(session.id, { action: 'submit', request: { id: randomUUID(), to: session.id, prompt: 'must not run' } }), /대기 중이 아닙니다/)
  } finally { session.close(); await session.exited }
}))
test('outgoing WebSocket frames are bounded, masked and preserve non-ASCII payloads', () => {
  for (const n of [5, 200, 70000]) {
    const p = Buffer.alloc(n, 0xe3), f = websocketFrame(p); assert.ok(f[1] & 128)
    const h = n < 126 ? 2 : n < 65536 ? 4 : 10, m = f.subarray(h, h + 4), body = Buffer.from(f.subarray(h + 4))
    for (let i = 0; i < n; i++) body[i] ^= m[i % 4]
    assert.deepEqual(body, p)
  }
  assert.throws(() => websocketFrame(Buffer.alloc(4 * 1024 * 1024 + 1)), /4MiB/)
})
