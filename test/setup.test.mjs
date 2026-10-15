import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/axmap.mjs', import.meta.url))
const box = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-setup-'))
const home = path.join(box, 'home')
fs.mkdirSync(home)
const config = path.join(home, '.gitconfig')
fs.writeFileSync(config, '[user]\nname = global-person\nemail = global@example.com\n')
const env = { ...process.env, USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, '.codex'),
  GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', AXMAP_NO_UPDATE_CHECK: '1' }
after(() => fs.rmSync(box, { recursive: true, force: true }))
const setup = (cwd, ...args) => spawnSync(process.execPath, [CLI, 'setup', ...args], { cwd, env, encoding: 'utf8', windowsHide: true })
function repo(name) {
  const cwd = path.join(box, name)
  fs.mkdirSync(cwd)
  for (const args of [['init', '-q'], ['config', 'user.name', 'local-person'], ['config', 'user.email', 'local@example.com']]) {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr)
  }
  return cwd
}

test('setup from a non-Git folder is global and requires no repository', () => {
  const r = setup(home, '--no-register', '--commands', 'none')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /이 PC 전체/)
  assert.match(r.stdout, /global-person/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.axmap', 'profile.json'), 'utf8')).name, 'global-person')
  assert.equal(fs.existsSync(path.join(home, '.axmap', 'ledger')), false)
})

test('setup inside a repo still does not initialize it or use its local identity', () => {
  const cwd = repo('default-in-repo')
  const r = setup(cwd, '--no-register', '--commands', 'none')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /global-person/)
  assert.doesNotMatch(r.stdout, /local-person/)
  assert.equal(fs.existsSync(path.join(cwd, '.axmap')), false)
  assert.equal(fs.existsSync(path.join(cwd, '.git', 'hooks', 'pre-commit')), false)
})

test('dry-run anywhere plans global registration without repo bootstrap', () => {
  const r = setup(home, '--dry-run', '--commands', 'none')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /mcp[\\/]install/)
  assert.doesNotMatch(r.stdout, /init  ·  hook install/)
})

test('an explicit --repo can prepare its ledger and hook from another folder', () => {
  const cwd = repo('explicit')
  const r = setup(home, '--repo', cwd, '--no-register', '--commands', 'none', '--dest', path.join(box, 'uninstalled'))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(fs.existsSync(path.join(cwd, '.axmap', 'ledger', '.git')))
  assert.ok(fs.existsSync(path.join(cwd, '.git', 'hooks', 'pre-commit')))
  assert.equal(fs.existsSync(path.join(home, '.axmap', 'ledger')), false)
})

test('an invalid explicit repo fails before registration', () => {
  const r = setup(home, '--repo', home, '--dry-run', '--commands', 'none')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Git 저장소가 아닙니다/)
  assert.doesNotMatch(r.stdout, /mcp[\\/]install/)
})

test('setup stores a Unicode display name and preserves it on reinstall without changing Git', () => {
  const cwd = repo('display-name')
  const r = setup(cwd, '--name', '장효준', '--no-register', '--commands', 'none')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const p = path.join(home, '.axmap', 'profile.json')
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).name, '장효준')
  assert.match(setup(home, '--no-register', '--commands', 'none').stdout, /장효준/)
  const g = spawnSync('git', ['config', 'user.name'], { cwd, env, encoding: 'utf8', windowsHide: true })
  assert.equal(g.stdout.trim(), 'local-person')
  const dry = setup(home, '--name', 'John Smith', '--dry-run', '--commands', 'none')
  assert.equal(dry.status, 0, dry.stderr)
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).name, '장효준')
})
