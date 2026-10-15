import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/axmap.mjs', import.meta.url))
const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-mail-profile-'))
after(() => fs.rmSync(box, { recursive: true, force: true }))
const baseEnv = { ...process.env, AXMAP_REMOTE: '', AXMAP_REPO: '', AXMAP_AGENT_EMAIL: '', AXMAP_BUS_DIR: '',
  AXMAP_NO_UPDATE_CHECK: '1', GIT_CONFIG_NOSYSTEM: '1', AXMAP_BUS_ROWS: '0' }
function person(id, name, email) {
  const home = path.join(box, id)
  fs.mkdirSync(path.join(home, '.axmap'), { recursive: true })
  const config = path.join(home, '.gitconfig')
  fs.writeFileSync(config, `[user]\nname = ${id}\nemail = ${email}\n[commit]\ngpgsign = false\n`)
  fs.writeFileSync(path.join(home, '.axmap', 'profile.json'), JSON.stringify({ version: 1, name }))
  return { ...baseEnv, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: config, AXMAP_AGENT: id, AXMAP_SESSION: `session-${id}` }
}
function git(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  return r.stdout.trim()
}
function ax(cwd, env, args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, input, encoding: 'utf8', windowsHide: true })
}
function success(r) { assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout }
function shared(id, env) {
  const remote = path.join(box, `${id}.git`)
  const cwd = path.join(box, id)
  fs.mkdirSync(cwd)
  git(cwd, env, 'init', '--bare', '-q', remote)
  git(cwd, env, 'init', '-q')
  git(cwd, env, 'commit', '--allow-empty', '-qm', 'project')
  git(cwd, env, 'remote', 'add', 'origin', remote)
  git(cwd, env, 'push', '-qu', 'origin', 'HEAD:main')
  git(remote, env, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  return { cwd, remote }
}
function clone(remote, id, env) {
  const cwd = path.join(box, id)
  git(box, env, 'clone', '-q', remote, cwd)
  return cwd
}
const state = (cwd, email) => JSON.parse(fs.readFileSync(path.join(cwd, '.axmap', 'users', 'users', `${email}.json`), 'utf8'))
function rename(env, name) {
  fs.writeFileSync(path.join(env.HOME, '.axmap', 'profile.json'), JSON.stringify({ version: 1, name }))
}

test('first CLI use shares a noncommitter, and Unicode recipients survive a corrected name', () => {
  const alice = person('mail-alice', 'Alice Smith', 'alice@example.com')
  const bob = person('mail-bob', '장효쥰', 'bob@example.com')
  const staleBob = person('mail-bob-old-pc', '장효쥰', 'bob@example.com')
  const { cwd, remote } = shared('mail-project', alice)
  const other = clone(remote, 'mail-bob-clone', bob)
  const oldPC = clone(remote, 'mail-bob-old-clone', staleBob)
  const tip = git(other, bob, 'rev-parse', 'HEAD')
  success(ax(other, bob, ['status', '--json']))
  assert.equal(git(other, bob, 'rev-parse', 'HEAD'), tip)
  assert.equal(git(other, bob, 'status', '--porcelain'), '')
  const contacts = success(ax(cwd, alice, ['bus', 'contacts']))
  assert.match(contacts, /장효쥰\s+bob@example.com/)
  success(ax(cwd, alice, ['bus', 'post', '--to', '장효쥰', '--subject', 'name correction'], 'hello'))
  const messages = path.join(cwd, '.axmap', 'bus', 'messages')
  const file = fs.readdirSync(messages).find((n) => n.endsWith('.md'))
  assert.match(fs.readFileSync(path.join(messages, file), 'utf8'), /^to: bob@example.com$/m)
  rename(bob, '장효준')
  const inbox = success(ax(other, bob, ['bus', 'list', '--mine', '--unread']))
  assert.match(inbox, /name correction/)
  const updated = state(other, 'bob@example.com')
  assert.equal(updated.name, '장효준')
  assert.ok(updated.aliases.includes('장효쥰'))
  assert.ok(updated.seen)
  success(ax(oldPC, staleBob, ['status', '--json']))
  assert.equal(state(oldPC, 'bob@example.com').name, '장효준', 'an older PC reverted the corrected name')
  assert.equal(state(oldPC, 'bob@example.com').seen, updated.seen)
  assert.doesNotMatch(success(ax(other, bob, ['bus', 'list', '--mine', '--unread'])), /name correction/)
  assert.equal(git(other, bob, 'status', '--porcelain'), '')
})

test('a new repository uses its own Git email without changing the global label', () => {
  const env = person('mail-multi', 'John Smith', 'global@example.com')
  const { cwd } = shared('mail-local-email', env)
  git(cwd, env, 'config', 'user.email', 'work@example.com')
  success(ax(cwd, env, ['status', '--json']))
  assert.equal(state(cwd, 'work@example.com').name, 'John Smith')
  assert.equal(fs.existsSync(path.join(cwd, '.axmap', 'users', 'users', 'global@example.com.json')), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.HOME, '.axmap', 'profile.json'), 'utf8')), { version: 1, name: 'John Smith' })
})

test('same display name does not merge people and requires an email to send', () => {
  const alice = person('same-alice', 'Alex Kim', 'first@example.com')
  const bob = person('same-bob', 'Alex Kim', 'second@example.com')
  const { cwd, remote } = shared('same-project', alice)
  success(ax(cwd, alice, ['status', '--json']))
  const other = clone(remote, 'same-bob-clone', bob)
  success(ax(other, bob, ['status', '--json']))
  fs.rmSync(path.join(cwd, '.axmap', '.users-lastfetch'), { force: true })
  const ambiguous = ax(cwd, alice, ['bus', 'post', '--to', 'Alex Kim', '--subject', 'ambiguous'], 'hello')
  assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr)
  assert.match(ambiguous.stderr, /first@example.com/)
  assert.match(ambiguous.stderr, /second@example.com/)
  success(ax(cwd, alice, ['bus', 'post', '--to', 'second@example.com', '--subject', 'specific'], 'hello'))
  assert.match(success(ax(other, bob, ['bus', 'list', '--mine', '--unread'])), /specific/)
})

function asyncAx(cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, 'status', '--json'], { cwd, env, windowsHide: true })
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('error', reject)
    p.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('concurrent profiles from separate clones are both retained on the orphan branch', async () => {
  const alice = person('race-alice', '이예승', 'race-a@example.com')
  const bob = person('race-bob', '고지혁', 'race-b@example.com')
  const { cwd, remote } = shared('race-project', alice)
  const other = clone(remote, 'race-bob-clone', bob)
  const results = await Promise.all([asyncAx(cwd, alice), asyncAx(other, bob)])
  for (const r of results) { success(r); assert.doesNotMatch(r.stderr, /프로필.*못했습니다/) }
  const tree = git(remote, alice, 'ls-tree', '-r', '--name-only', 'axmap/users')
  assert.match(tree, /race-a@example.com.json/)
  assert.match(tree, /race-b@example.com.json/)
})

test('MCP inbox follows the Git email even when its agent alias is absent from history', () => {
  const alice = person('mcp-mail-alice', 'Alice', 'mcp-a@example.com')
  const bob = person('mcp-mail-bob', '진미리', 'mcp-b@example.com')
  const { cwd, remote } = shared('mcp-mail-project', alice)
  const other = clone(remote, 'mcp-mail-bob-clone', bob)
  success(ax(cwd, alice, ['bus', 'post', '--to', 'mcp-b@example.com', '--subject', 'email inbox'], 'hello'))
  const input = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {} } },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ax_inbox', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ax_inbox', arguments: {} } },
  ].map(JSON.stringify).join('\n') + '\n'
  const r = spawnSync(process.execPath, [SERVER], { cwd: other, env: { ...bob, AXMAP_AGENT: 'unknown-agent-alias' }, input, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  const out = r.stdout.trim().split('\n').map(JSON.parse)
  assert.equal(out.find((v) => v.id === 1).result.isError, false)
  assert.match(out.find((v) => v.id === 1).result.content[0].text, /email inbox/)
  assert.doesNotMatch(out.find((v) => v.id === 2).result.content[0].text, /email inbox/)
  assert.equal(state(other, 'mcp-b@example.com').name, '진미리')
})

test('rejected profile push is reported, retains local data, and retries successfully', () => {
  const env = person('rejected-profile', '박재현', 'reject@example.com')
  const { cwd, remote } = shared('rejected-project', env)
  const hook = path.join(remote, 'hooks', 'pre-receive')
  fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/axmap/users" ]; then exit 1; fi\ndone\n', { mode: 0o755 })
  const denied = ax(cwd, env, ['bus', 'profile'])
  assert.equal(denied.status, 1, denied.stdout + denied.stderr)
  assert.match(denied.stderr, /프로필.*공유하지 못했습니다/)
  assert.equal(state(cwd, 'reject@example.com').name, '박재현')
  fs.unlinkSync(hook)
  success(ax(cwd, env, ['bus', 'profile']))
  const published = JSON.parse(git(remote, env, 'show', 'axmap/users:users/reject@example.com.json'))
  assert.equal(published.name, '박재현')
})

test('linked worktrees reuse the same messaging profile and leave project files untouched', async () => {
  const env = person('linked-profile', '모진성', 'linked@example.com')
  const { cwd } = shared('linked-project', env)
  const linked = path.join(box, 'linked-checkout')
  git(cwd, env, 'worktree', 'add', '-qb', 'side', linked)
  const results = await Promise.all([asyncAx(cwd, env), asyncAx(linked, env)])
  for (const r of results) { success(r); assert.doesNotMatch(r.stderr, /프로필.*못했습니다/) }
  assert.match(success(ax(linked, env, ['bus', 'contacts'])), /모진성\s+linked@example.com/)
  assert.equal(fs.existsSync(path.join(linked, '.axmap', 'users')), false)
  assert.equal(git(linked, env, 'status', '--porcelain'), '')
  assert.equal(git(cwd, env, 'status', '--porcelain'), '')
})
