/**
 * Git 저장소가 아닌 작업 폴더(D30). 실제 사례: `robotable_hj_workspace` 아래 8개 폴더가
 * 모두 한 저장소의 worktree 였는데, 위로만 찾던 axMap 은 이 폴더를 "연결 안 됨"으로 봤다.
 *
 * 고정하는 성질:
 *   - 한 저장소의 worktree 들만 있으면 자동으로 그 저장소(메인 체크아웃)를 겨눈다
 *   - 서로 다른 저장소가 둘 이상이면 하나를 고르지 않고 후보를 모두 적어 멈춘다
 *   - `.axmap.json` 수동 설정이 모호함을 이긴다. 설정이 틀리면 조용히 넘어가지 않는다
 *   - MCP 서버는 다시 켜지 않아도 다음 도구 호출부터 새 설정을 따른다
 *   - CLI·로컬 세션 연결이 같은 규칙을 쓴다
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectTarget, resolveTarget, writeWorkspaceChoice } from '../src/workspace.mjs'
import { repoKey, sessions, writeJSON } from '../src/bridge.mjs'

const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(SELF, 'mcp', 'server.mjs')
const CLI = path.join(SELF, 'bin', 'axmap.mjs')
const norm = (p) => fs.realpathSync(p).split(path.sep).join('/').toLowerCase()

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'ws-tester')
  git(dir, 'config', 'user.email', 'ws@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

/** 메인 체크아웃은 작업 폴더 밖, 작업 폴더에는 그 worktree 들 + Git 아닌 폴더 + 숨김 폴더. */
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-ws-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const main = makeRepo(path.join(root, 'main'))
  const ws = path.join(root, 'workspace')
  fs.mkdirSync(ws)
  git(main, 'worktree', 'add', '-q', path.join(ws, 'feature-a'), '-b', 'feature-a')
  git(main, 'worktree', 'add', '-q', path.join(ws, 'feature-b'), '-b', 'feature-b')
  fs.mkdirSync(path.join(ws, 'notes'))
  // 숨김 폴더와 node_modules 는 보지 않는다. 여기에 다른 저장소가 있어도 모호해지면 안 된다.
  makeRepo(path.join(ws, '.cache-repo'))
  makeRepo(path.join(ws, 'node_modules', 'pkg'))
  fs.mkdirSync(path.join(ws, 'node_modules', '.git'))
  return { root, main, ws }
}

test('한 저장소의 worktree 만 있는 작업 폴더는 메인 체크아웃을 자동으로 겨눈다', (t) => {
  const { main, ws } = fixture(t)
  const r = inspectTarget(ws)
  assert.equal(r.kind, 'auto')
  assert.equal(norm(r.repo), norm(main))
  assert.deepEqual(r.group.members.map(m => m.name), ['feature-a', 'feature-b'])
  // 로컬 세션 연결도 같은 저장소 키를 쓴다 — 작업 폴더에서 연 세션과 저장소 안의 MCP 가 만난다.
  assert.equal(repoKey(ws), repoKey(main))
  assert.equal(repoKey(path.join(ws, 'feature-a')), repoKey(main))
})

test('서로 다른 저장소가 둘이면 고르지 않고 둘 다 적은 오류를 낸다', (t) => {
  const { main, ws } = fixture(t)
  const other = makeRepo(path.join(ws, 'other-repo'))
  const r = inspectTarget(ws)
  assert.equal(r.kind, 'ambiguous')
  assert.deepEqual(r.groups.map(g => norm(g.target)).sort(), [norm(main), norm(other)].sort())
  assert.throws(() => resolveTarget(ws), (e) => {
    assert.match(e.message, /서로 다른 Git 저장소가 2개/)
    assert.match(e.message, /feature-a, feature-b/)
    assert.match(e.message, /other-repo/)
    assert.match(e.message, /cwd/)
    assert.match(e.message, /\.axmap\.json/)
    assert.match(e.message, /axmap workspace use/)
    return true
  })
  assert.throws(() => repoKey(ws), /서로 다른 Git 저장소/)
})

test('.axmap.json 수동 설정이 모호함을 이기고, 틀린 설정은 자동 탐색으로 넘어가지 않는다', (t) => {
  const { ws } = fixture(t)
  makeRepo(path.join(ws, 'other-repo'))
  const w = writeWorkspaceChoice(ws, 'other-repo')
  assert.equal(w.value, 'other-repo', '작업 폴더 안의 저장소는 상대 경로로 적는다')
  assert.equal(norm(resolveTarget(ws)), norm(path.join(ws, 'other-repo')))
  // 하위의 Git 아닌 폴더에서도 조상의 설정을 따른다.
  assert.equal(norm(resolveTarget(path.join(ws, 'notes'))), norm(path.join(ws, 'other-repo')))

  fs.writeFileSync(path.join(ws, '.axmap.json'), JSON.stringify({ repo: 'notes' }))
  assert.throws(() => resolveTarget(ws), /설정의 저장소가 Git 저장소가 아닙니다/)
  fs.writeFileSync(path.join(ws, '.axmap.json'), '{ broken')
  assert.throws(() => resolveTarget(ws), /설정을 읽지 못했습니다/)
  assert.throws(() => writeWorkspaceChoice(ws, 'feature-a'), /읽지 못해 바꾸지 않았습니다/, '읽지 못한 설정을 덮어썼다')
  fs.writeFileSync(path.join(ws, '.axmap.json'), JSON.stringify({ note: 'no repo' }))
  assert.throws(() => resolveTarget(ws), /"repo" 경로가 없습니다/)
  assert.throws(() => writeWorkspaceChoice(path.join(ws, 'feature-a'), '../other-repo'), /이미 Git 저장소 안/)
})

test('.git 이 있는데 읽지 못한 폴더를 "저장소 없음" 으로 세지 않는다', (t) => {
  const { ws } = fixture(t)
  const broken = path.join(ws, 'broken')
  fs.mkdirSync(broken)
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: ./does-not-exist\n')
  assert.throws(() => resolveTarget(ws), (e) => {
    assert.match(e.message, /확인하지 못한 Git 폴더/)
    assert.match(e.message, /broken/)
    return true
  })
})

test('저장소가 하나도 없는 폴더는 기존처럼 "없음" 이다', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-ws-none-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'plain'))
  assert.equal(resolveTarget(root), null)
  assert.equal(inspectTarget(root).kind, 'none')
})

test('CLI: workspace show/use 와 장부 명령이 같은 규칙으로 대상 저장소를 고른다', (t) => {
  const { main, ws } = fixture(t)
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ws, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, AXMAP_AGENT: 'ws-tester', AXMAP_SESSION: 'ws-session', AXMAP_CHECK_DISABLE: '1' } })
  const auto = run('workspace', 'show', '--json')
  assert.equal(auto.status, 0, auto.stderr)
  assert.equal(JSON.parse(auto.stdout).kind, 'auto')
  assert.equal(norm(JSON.parse(auto.stdout).repo), norm(main))

  makeRepo(path.join(ws, 'other-repo'))
  const ambiguous = run('workspace', 'show')
  assert.equal(ambiguous.status, 2, '모호함을 성공으로 세면 안 된다')
  assert.match(ambiguous.stdout, /other-repo/)
  const blocked = run('status')
  assert.notEqual(blocked.status, 0)
  assert.match(blocked.stderr, /하나로 정하지 않았습니다/)

  const use = run('workspace', 'use', 'feature-a')
  assert.equal(use.status, 0, use.stderr)
  const shown = run('workspace', 'show', '--json')
  assert.equal(JSON.parse(shown.stdout).kind, 'manual')
  assert.equal(norm(JSON.parse(shown.stdout).repo), norm(path.join(ws, 'feature-a')))
})

test('MCP: 모호하면 도구 호출이 후보를 알려 주고, .axmap.json 을 쓰면 다시 켜지 않아도 따른다', async (t) => {
  const { main, ws } = fixture(t)
  makeRepo(path.join(ws, 'other-repo'))
  const env = { ...process.env, AXMAP_AGENT: 'ws-tester', AXMAP_STATE_DIR: path.join(ws, '..', 'state') }
  delete env.AXMAP_REPO
  const p = spawn(process.execPath, [SERVER], { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = new Promise((resolve) => p.once('exit', resolve))
  try { await mcpScenario(p, main, ws) } finally {
    // 임시 폴더를 지우기 전에 서버를 끝낸다. Windows 는 쓰는 중인 작업 폴더를 지우지 못한다.
    p.kill(); await exited
  }
})

async function mcpScenario(p, main, ws) {
  p.stderr.resume()
  const waiting = new Map()
  let buf = '', id = 0
  p.stdout.on('data', (d) => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      const m = JSON.parse(line)
      waiting.get(m.id)?.(m); waiting.delete(m.id)
    }
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    const mine = ++id
    const timer = setTimeout(() => reject(new Error(`MCP 응답 시간 초과: ${method}`)), 15000)
    waiting.set(mine, (m) => { clearTimeout(timer); resolve(m) })
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n')
  })
  const tool = (name, args = {}) => send('tools/call', { name, arguments: args })
  const textOf = (m) => m?.result?.content?.[0]?.text ?? ''
  const targetOf = (text) => text.match(/대상 저장소: `([^`]+)`/)?.[1]

  await send('initialize', { capabilities: {} })
  const ambiguous = await tool('ax_brief')
  assert.equal(ambiguous.result.isError, true)
  assert.match(textOf(ambiguous), /서로 다른 Git 저장소가 2개/)
  assert.match(textOf(ambiguous), /axmap workspace use/)

  // 도구의 cwd 로 고를 수 있다. 작업 폴더 안의 worktree 를 주면 그 worktree 를 겨눈다.
  const chosen = await tool('ax_brief', { cwd: path.join(ws, 'feature-b') })
  assert.equal(chosen.result.isError, false, textOf(chosen))
  assert.equal(norm(targetOf(textOf(chosen))), norm(path.join(ws, 'feature-b')))

  fs.writeFileSync(path.join(ws, '.axmap.json'), JSON.stringify({ repo: '../main' }))
  const manual = await tool('ax_brief')
  assert.equal(manual.result.isError, false, textOf(manual))
  assert.equal(norm(targetOf(textOf(manual))), norm(main))
}

test('작업 폴더에서 연 세션도 저장소 기준으로 조회된다', (t) => {
  const { main, ws } = fixture(t)
  const saved = process.env.AXMAP_STATE_DIR
  process.env.AXMAP_STATE_DIR = path.join(ws, '..', 'bridge-state')
  t.after(() => { if (saved === undefined) delete process.env.AXMAP_STATE_DIR; else process.env.AXMAP_STATE_DIR = saved })
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100'
  writeJSON(path.join(process.env.AXMAP_STATE_DIR, 'bridge', 'sessions', `${id}.json`), {
    id, provider: 'agy', transport: 'agentapi', workspaces: [ws], repos: [repoKey(ws)], state: 'idle', fullyIdle: true, registeredAt: new Date().toISOString(),
  })
  assert.deepEqual(sessions(main).map(s => s.id), [id])
  assert.deepEqual(sessions(path.join(ws, 'feature-a')).map(s => s.id), [id])
})
