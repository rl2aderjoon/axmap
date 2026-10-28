import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createView, renderView } from '../src/view.mjs'
import { repoKey, writeJSON } from '../src/bridge.mjs'

test('view reads only queued, unexpired messages from the chosen repo without changing the mailbox', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-view-'))
  const old = process.env.AXMAP_STATE_DIR, cwd = path.join(root, 'repo')
  fs.mkdirSync(cwd); assert.equal(spawnSync('git', ['init', '-q'], { cwd, windowsHide: true }).status, 0)
  process.env.AXMAP_STATE_DIR = path.join(root, 'state')
  try {
    const id = randomUUID(), repo = repoKey(cwd)
    const mailFile = path.join(root, 'state', 'bridge', 'mailboxes', `${id}.json`)
    const mail = (overrides = {}) => ({ id: randomUUID(), repo, to: id, from: 'worker', text: '작업 완료', state: 'queued', expiresAt: '2099-01-01T00:00:00Z', ...overrides })
    writeJSON(mailFile, { version: 1, messages: [mail(), mail({ repo: 'other' }), mail({ state: 'collected' }), mail({ expiresAt: '2000-01-01T00:00:00Z' })], batches: [] })
    const before = fs.readFileSync(mailFile)
    const session = { id, provider: 'codex', workspaces: [cwd], registeredAt: '2026-01-01T00:00:00Z', state: 'idle', connection: 'connected', checkedAt: '2026-01-01T00:00:00Z' }
    const snapshot = await createView(cwd, { probe: async () => [session] })()
    assert.equal(snapshot.mail.length, 1)
    assert.equal(snapshot.mail[0].text, '작업 완료')
    assert.deepEqual(fs.readFileSync(mailFile), before)
    assert.match(renderView(snapshot), /대기 1건/)
    fs.writeFileSync(mailFile, '{bad')
    const broken = await createView(cwd, { probe: async () => [session] })()
    assert.ok(broken.mailIssues.length)
    assert.match(renderView(broken), /일부 확인 실패/)
    assert.doesNotMatch(renderView(broken), /대기 메시지 없음/)
  } finally {
    if (old === undefined) delete process.env.AXMAP_STATE_DIR; else process.env.AXMAP_STATE_DIR = old
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('view renders real content, strips terminal controls and handles narrow windows', () => {
  const snapshot = { cwd: '/repo', repo: '/repo', checkedAt: '2026-10-28T00:00:00Z', sessions: [], requests: [], dialogues: [], claims: [{ agent: 'codex\x1b[31m', paths: ['src/한글.ts'], expiresAt: Date.now()+1000 }], events: [], issues: [], mail: [], mailIssues: [] }
  const out = renderView(snapshot, { columns: 80, rows: 30 })
  assert.match(out, /LEDGER/); assert.match(out, /MAILBOX/); assert.match(out, /src\/한글.ts/)
  assert.doesNotMatch(out, /\x1b/)
  const colored = renderView(snapshot, { columns: 80, rows: 30, color: true })
  assert.match(colored, /\x1b\[38;2;78;82;94m/)
  assert.match(colored, /\x1b\[38;2;194;197;205m/)
  assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, ''), out)
  assert.ok(renderView(snapshot, { columns: 10, rows: 1 }).split('\n').length <= 1)
})

test('view CLI refreshes in a real terminal and restores it on q', { timeout: 20000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-view-pty-'))
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd, windowsHide: true }).status, 0)
    const tool = fileURLToPath(new URL('../tools/view.mjs', import.meta.url))
    const driver = path.join(cwd, 'driver.cjs')
    fs.writeFileSync(driver, `
      const {spawn}=require(${JSON.stringify(createRequire(import.meta.url).resolve('node-pty'))});
      const assert=require('node:assert/strict'); let output='';
      const term=spawn(process.execPath,[${JSON.stringify(tool)},'--interval','250','--no-color'],{cwd:process.cwd(),env:{...process.env,TERM:'xterm-256color'},cols:100,rows:36});
      term.onData(data=>{output+=data;if(output.includes('MAILBOX')&&!output.includes('EXIT_SENT')){output+='EXIT_SENT';term.write('q')}});
      const timeout=setTimeout(()=>{term.kill();process.exit(2)},12000);
      term.onExit(e=>{clearTimeout(timeout);assert.equal(e.exitCode,0);assert.ok(output.includes('LEDGER'));assert.ok(output.includes('\\x1b[?25h\\x1b[?1049l'));process.exit(0)});
    `)
    const result = spawnSync(process.execPath, [driver], { cwd, env: { ...process.env, AXMAP_STATE_DIR: path.join(cwd, 'state') }, encoding: 'utf8', windowsHide: true, timeout: 16000 })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    assert.equal(path.dirname(path.resolve(cwd)), path.resolve(os.tmpdir()))
    await fs.promises.rm(cwd, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
  }
})
