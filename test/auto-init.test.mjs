import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/axmap.mjs', import.meta.url))
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-auto-'))
after(() => fs.rmSync(box, { recursive: true, force: true }))
const env = { ...process.env, AXMAP_AGENT: 'auto-tester', AXMAP_SESSION: 'auto-session', AXMAP_NO_UPDATE_CHECK: '1', AXMAP_REMOTE: '' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function repo(name) {
  const dir = path.join(box, name)
  fs.mkdirSync(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'auto-tester')
  git(dir, 'config', 'user.email', 'auto@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'app.js'), 'one\n')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')
  return dir
}
const ax = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', windowsHide: true })
function asyncAx(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd, env, windowsHide: true })
    let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('error', reject)
    p.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

test('first status is valid JSON, leaves project files clean, then claim works', () => {
  const dir = repo('fresh')
  const head = git(dir, 'rev-parse', 'HEAD')
  const status = ax(dir, 'status', '--json')
  assert.equal(status.status, 0, status.stderr)
  assert.deepEqual(JSON.parse(status.stdout).active, [])
  assert.equal(git(dir, 'status', '--porcelain'), '')
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n')
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
  const claimed = ax(dir, 'claim', 'app.js', '--intent', 'first task')
  assert.equal(claimed.status, 0, claimed.stderr)
  assert.equal(JSON.parse(ax(dir, 'status', '--json').stdout).active.length, 1)
})

test('first use from a linked worktree and concurrent startup share one ledger', async () => {
  const dir = repo('parallel')
  const linked = path.join(box, 'linked')
  git(dir, 'worktree', 'add', '-qb', 'side', linked)
  const results = await Promise.all([asyncAx(linked, 'status', '--json'), asyncAx(dir, 'status', '--json'), asyncAx(linked, 'status', '--json')])
  for (const r of results) {
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).active, [])
  }
  assert.ok(fs.existsSync(path.join(dir, '.axmap', 'ledger', '.git')))
  assert.equal(fs.existsSync(path.join(linked, '.axmap', 'ledger')), false)
  assert.equal(git(dir, 'worktree', 'list', '--porcelain').split('branch refs/heads/axmap/claims').length - 1, 1)
  assert.equal(fs.existsSync(path.join(dir, '.git', 'axmap-init.lock')), false)
})

test('unreachable remote fails without creating a ledger; corrected config retries cleanly', () => {
  const dir = repo('offline')
  git(dir, 'remote', 'add', 'origin', path.join(box, 'missing.git'))
  const r = ax(dir, 'status', '--json')
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /새 장부를 만들지 않습니다/)
  assert.equal(fs.existsSync(path.join(dir, '.axmap', 'ledger', '.git')), false)
  assert.equal(fs.existsSync(path.join(dir, '.git', 'axmap-init.lock')), false)
  git(dir, 'remote', 'remove', 'origin')
  assert.equal(ax(dir, 'status', '--json').status, 0)
})

test('ambiguous remotes fail until the caller explicitly selects a remote', () => {
  const dir = repo('ambiguous')
  const remote = path.join(box, 'explicit.git')
  git(box, 'init', '--bare', '-q', remote)
  git(dir, 'remote', 'add', 'team', remote)
  git(dir, 'remote', 'add', 'fork', remote)
  const r = ax(dir, 'status', '--json')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /원격이 둘 이상/)
  const chosen = ax(dir, 'status', '--json', '--remote', 'team')
  assert.equal(chosen.status, 0, chosen.stderr)
  assert.deepEqual(JSON.parse(chosen.stdout).active, [])
  assert.equal(git(dir, 'config', '--get', 'axmap.remote'), 'team')
})

test('a second clone automatically reuses remote claims and rejects overlap', () => {
  const dir = repo('team-a')
  const remote = path.join(box, 'team.git')
  git(box, 'init', '--bare', '-q', remote)
  git(dir, 'remote', 'add', 'origin', remote)
  const first = ax(dir, 'claim', 'app.js', '--agent', 'alice')
  assert.equal(first.status, 0, first.stderr)
  const second = repo('team-b')
  git(second, 'remote', 'add', 'origin', remote)
  const status = ax(second, 'status', '--json')
  assert.equal(status.status, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).active[0].agent, 'alice')
  const overlap = ax(second, 'claim', 'app.js', '--agent', 'bob')
  assert.equal(overlap.status, 2, overlap.stderr)
})
