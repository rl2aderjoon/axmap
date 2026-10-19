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
import { normalizeUsage, usageDelta, sumUsage } from '../src/session-usage.mjs'
import { sessions, dispatchRequest, sessionLeasePath } from '../src/bridge.mjs'
import { runDialogue, startBackgroundDialogue, dialogueResult, stopDialogue } from '../src/session-dialogue.mjs'

const wait = ms => new Promise(r => setTimeout(r, ms))
async function until(fn) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await wait(20) }
  throw new Error('fixture did not settle')
}
async function withRepo(fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-managed-'))
  const saved = process.env.AXMAP_STATE_DIR
  process.env.AXMAP_STATE_DIR = path.join(cwd, 'state')
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0)
  try { await fn(cwd) } finally {
    if (saved === undefined) delete process.env.AXMAP_STATE_DIR; else process.env.AXMAP_STATE_DIR = saved
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

test('provider totals do not double-count cached input or reasoning; missing/regressing usage stays unknown', () => {
  const codex = normalizeUsage('codex', { inputTokens: 150, cachedInputTokens: 50, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 160 })
  const agy = normalizeUsage('agy', { input_tokens: 100, cache_read_tokens: 50, output_tokens: 10, thinking_tokens: 2, total_tokens: 110 })
  assert.equal(agy.totalTokens, codex.totalTokens)
  assert.equal(agy.inputTokens, 150)
  assert.equal(agy.providerTotalTokens, 110)
  assert.equal(sumUsage([codex, agy]).totalTokens, 320)
  assert.equal(sumUsage([codex, null]), null)
  assert.equal(normalizeUsage('agy', {}), null)
  assert.equal(usageDelta(codex, { ...codex, totalTokens: 200 }), null)
})

for (const provider of ['codex', 'agy']) test(`${provider}: persistent protocol, request identity, usage deltas, auth, busy rejection and idle cost`, async () => withRepo(async cwd => {
  const events = []
  const session = await startManagedSession({ provider, executable: process.execPath,
    prefix: [fileURLToPath(new URL('./fixtures/structured-cli.mjs', import.meta.url))],
    args: [provider], cwd, onEvent: e => events.push(e) })
  try {
    const initial = sessions(cwd)[0]
    assert.equal(initial.transport, 'stdio')
    assert.equal(initial.usage, null)
    assert.ok(!JSON.stringify(initial).includes('token'))
    await assert.rejects(sendTerminal(session.id, { action: 'status' }, 'bad'), /인증 실패/)
    for (const prompt of ['remember 731', 'recall']) {
      const request = { id: randomUUID(), to: session.id, prompt, from: 'test' }
      await sendTerminal(session.id, { action: 'submit', request })
      await assert.rejects(sendTerminal(session.id, { action: 'submit', request: { ...request, id: randomUUID() } }), /대기 중이 아닙니다/)
      const result = await until(async () => {
        const r = await sendTerminal(session.id, { action: 'result', id: request.id }); return r.state === 'completed' ? r : null
      })
      assert.equal(result.result, prompt === 'recall' ? '731' : 'ok')
      assert.equal(result.usage.totalTokens, 160, 'each turn is the delta, not the cumulative counter')
      assert.equal(result.conversationId, session.conversationId)
    }
    assert.equal(sessions(cwd)[0].usage.totalTokens, 320)
    await wait(100)
    assert.equal(events.filter(e => e.event === 'result').length, 2, 'idle does not generate another turn')
  } finally { session.close(); await session.exited }
}))

test('Codex approval remains pending until the exact request receives a decision', async () => withRepo(async cwd => {
  const s = await startManagedSession({ provider: 'codex', executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/structured-cli.mjs', import.meta.url)), 'codex', 'approval'], cwd })
  try {
    const id = randomUUID()
    await sendTerminal(s.id, { action: 'submit', request: { id, to: s.id, prompt: 'example' } })
    await until(async () => (await sendTerminal(s.id, { action: 'status' })).state === 'awaiting_user')
    await assert.rejects(sendTerminal(s.id, { action: 'answer', id: 'old', decision: 'accept' }), /현재 대기/)
    assert.equal((await sendTerminal(s.id, { action: 'result', id })).state, 'submitted')
    await sendTerminal(s.id, { action: 'answer', id: 'approval-1', decision: 'decline' })
    await until(async () => (await sendTerminal(s.id, { action: 'result', id })).state === 'completed')
  } finally { s.close(); await s.exited }
}))

test('wrong provider conversation closes the session with an uncertain outcome', async () => withRepo(async cwd => {
  const s = await startManagedSession({ provider: 'agy', executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/structured-cli.mjs', import.meta.url)), 'agy', 'wrong-id'], cwd })
  const id = randomUUID()
  await sendTerminal(s.id, { action: 'submit', request: { id, to: s.id, prompt: 'example' } })
  await s.exited
  assert.equal(sessions(cwd)[0].state, 'closed')
}))

test('missing measured usage blocks subsequent dispatch rather than treating it as free', async () => withRepo(async cwd => {
  const s = await startManagedSession({ provider: 'agy', executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/structured-cli.mjs', import.meta.url)), 'agy', 'no-usage'], cwd })
  try {
    const id = randomUUID()
    await sendTerminal(s.id, { action: 'submit', request: { id, to: s.id, prompt: 'example' } })
    const r = await until(async () => { const r = await sendTerminal(s.id, { action: 'result', id }); return r.state === 'completed' ? r : null })
    assert.equal(r.usage, null)
    await assert.rejects(sendTerminal(s.id, { action: 'submit', request: { id: randomUUID(), to: s.id, prompt: 'again' } }), /사용량을 확인하지/)
  } finally { s.close(); await s.exited }
}))

test('background controller persists results, reserves both sessions, checks repo and stops further relay', async () => withRepo(async cwd => {
  const started = []
  try {
    for (const provider of ['codex', 'agy']) started.push(await startManagedSession({ provider, executable: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/structured-cli.mjs', import.meta.url)), provider, 'slow-dialogue'], cwd }))
    const [left, right] = started.map(s => s.id)
    const options = { left, right, cwd, prompt: 'Review.', maxTurns: 2 }
    const receipt = await startBackgroundDialogue(options)
    assert.equal(receipt.state, 'queued')
    await until(() => dialogueResult(receipt.id, cwd).turns.length === 1)
    assert.throws(() => dispatchRequest({ to: right, cwd, prompt: 'unrelated' }), /自動|자동 대화/)
    const finished = await until(() => { const d = dialogueResult(receipt.id, cwd); return d.state === 'completed' ? d : null })
    assert.equal(finished.turns.length, 2)
    assert.equal(finished.usage.totalTokens, 320)
    await until(() => !fs.existsSync(sessionLeasePath(left)) && !fs.existsSync(sessionLeasePath(right)))
    const other = path.join(cwd, 'other'); fs.mkdirSync(other); spawnSync('git', ['init', '-q'], { cwd: other })
    assert.throws(() => dialogueResult(receipt.id, other), /현재 repo/)
    const second = await startBackgroundDialogue(options)
    await until(() => dialogueResult(second.id, cwd).turns.length === 1)
    stopDialogue(second.id, cwd)
    const stopped = await until(() => { const d = dialogueResult(second.id, cwd); return d.state === 'cancelled' ? d : null })
    assert.equal(stopped.turns.length, 1)
    assert.equal(stopped.usagePending, false)
    assert.equal(stopped.usage.totalTokens, 160, 'stopping still accounts for the already accepted turn')
    await until(() => !fs.existsSync(sessionLeasePath(left)))
  } finally { for (const s of started) { s.close(); await s.exited } }
}))

test('dialogue stops before another model call on budget, missing usage, bad envelopes and terminal completion', async () => withRepo(async cwd => {
  const left = randomUUID(), right = randomUUID()
  const inventory = () => [left, right].map(id => ({ id, transport: 'stdio', state: 'idle' }))
  const usage = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12, providerTotalTokens: 12 }
  for (const [expected, envelope, measured, budget] of [
    ['token_limit', { message: 'next', done: false }, usage, 10],
    ['usage_unavailable', { message: 'next', done: false }, null, 100],
    ['completed', { message: 'done', done: true }, usage, 100],
    ['invalid_response', { wrong: true }, usage, 100],
    ['message_limit', { message: 'x'.repeat(101), done: false }, usage, 100],
  ]) {
    const calls = []
    const d = await runDialogue({ left, right, cwd, prompt: 'task', maxTokens: budget, maxMessageChars: 100, inventory,
      dispatch: request => { calls.push(request); return { id: randomUUID(), state: 'submitted' } },
      result: () => ({ state: 'completed', result: JSON.stringify(envelope), usage: measured }) })
    assert.equal(d.state, expected)
    assert.equal(calls.length, 1)
    assert.equal(d.usage?.totalTokens ?? null, measured ? 12 : null)
  }
  const calls = []
  const d = await runDialogue({ left, right, cwd, prompt: 'task', maxTurns: 3, inventory,
    dispatch: request => { calls.push(request); return { id: randomUUID(), state: 'submitted' } },
    result: () => ({ state: 'completed', result: '{"message":"next","done":false}', usage }) })
  assert.equal(d.state, 'turn_limit')
  assert.deepEqual(calls.map(c => c.to), [left, right, left])
  assert.equal(d.usage.totalTokens, 36)
}))
