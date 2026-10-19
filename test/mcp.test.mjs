/**
 * MCP 서버를 **남의 저장소에 붙인 상태**로 돌린다.
 *
 * 🔴 이 파일이 없던 동안 세 가지가 동시에 깨져 있었다. 셋 다 원인이 하나다 —
 *    서버를 언제나 axMap 자신에게 겨눠 놓고 시험했고, 그때는 `REPO` 와 `SELF` 가
 *    같은 경로라서 둘을 헷갈려도 아무 증상이 없다.
 *
 *      1. `bus.mjs` 를 `REPO` 에서 찾아 남의 저장소에서 MODULE_NOT_FOUND 로 죽었다
 *      2. `ax_init` 이 도구 목록에 없어, 장부 없는 저장소에서 에이전트가
 *         "axmap init 을 실행하라" 는 지시를 읽고도 실행할 수 없었다
 *      3. `ax_brief` 가 대상이 무엇이든 axMap 자신의 구성 목록를 냈다
 *
 *    `npm test` 도 `npm run demo` 도 전부 초록이었다. 도는 조합이 하나뿐이었기
 *    때문이다. 그래서 여기서 고정하는 것은 기능이 아니라 **조합**이다:
 *    `REPO ≠ SELF`, 그리고 장부가 아직 없는 상태.
 *
 * 서버는 stdio + 줄바꿈 JSON-RPC 라 프로세스를 진짜로 띄워서 말을 건다.
 * 내부 함수를 import 해서 부르면 위의 셋을 하나도 못 잡는다 — 셋 다
 * 프로세스 경계와 경로 해석에서 생긴 문제다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(SELF, 'mcp', 'server.mjs')

let repo = null

/**
 * 요청들을 한 번에 밀어 넣고 응답을 순서대로 받는다.
 * 서버가 요청 하나마다 한 줄로 답하므로 id 로 짝을 맞춘다.
 */
function rpc(requests, { repoPath = repo, agent = 'tester' } = {}) {
  const lines = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    ...requests,
  ]
  // Different people need different email identities, even in one fixture repo.
  const env = { ...process.env, AXMAP_REPO: repoPath, AXMAP_AGENT: agent, AXMAP_AGENT_EMAIL: `${agent}@example.com` }
  const r = spawnSync(process.execPath, [SERVER], {
    input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    encoding: 'utf8',
    windowsHide: true,
    env,
  })
  const out = new Map()
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id !== undefined) out.set(m.id, m)
  }
  return out
}

const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const textOf = (msg) => msg?.result?.content?.[0]?.text ?? ''

const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true })

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-mcp-'))
  git('init', '-q')
  git('config', 'user.name', 'foreign-user')
  git('config', 'user.email', 'x@example.com')
  git('config', 'commit.gpgsign', 'false')
  // 대상 저장소는 자기만의 문서를 갖는다. 브리핑이 **이것들**을 읽어야 한다.
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# 남의 프로젝트\n\n영상 스트리밍 백엔드다.\n\n## 검증\n\n```bash\nnpm run lint\n```\n')
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'DECISIONS.md'), '# 결정\n\n## D1 · 큐는 Redis 로 간다\n')
  fs.writeFileSync(path.join(repo, 'app.js'), 'console.log(1)\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  // 🔴 일부러 `axmap init` 을 하지 않는다. 장부 없는 상태가 이 파일의 절반이다.
})

after(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
})

describe('남의 저장소에 붙었을 때', () => {
  it('장부가 없는 repo에서도 init 없이 첫 claim 이 성공한다', () => {
    const r = rpc([call(1, 'ax_claim', { paths: ['app.js'], intent: '무언가' }), call(2, 'ax_release')])
    const t = textOf(r.get(1))
    assert.equal(r.get(1).result.isError, false, t)
    assert.ok(fs.existsSync(path.join(repo, '.axmap', 'ledger', '.git')))
  })

  it('🔴 ax_init 이 도구 목록에 있다', () => {
    const r = rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }])
    const names = r.get(1).result.tools.map((t) => t.name)
    assert.ok(names.includes('ax_init'), `도구 목록에 ax_init 이 없다: ${names.join(', ')}`)
  })

  it('ax_init → claim 이 이어진다 — 사람이 셸로 내려가지 않아도 된다', () => {
    const r = rpc([
      call(1, 'ax_init'),
      call(2, 'ax_claim', { paths: ['app.js'], intent: 'init 뒤에는 되어야 한다' }),
    ])
    assert.equal(r.get(1).result.isError, false, `init 실패: ${textOf(r.get(1))}`)
    assert.equal(r.get(2).result.isError, false, `init 뒤 claim 실패: ${textOf(r.get(2))}`)
    assert.ok(fs.existsSync(path.join(repo, '.axmap', 'ledger', '.git')), '장부 worktree 가 안 생겼다')
  })

  it('🔴 쪽지함이 대상 저장소에 생긴다 — axMap 저장소가 아니라', () => {
    // 🔴 init 을 같은 배치에서 먼저 부른다. 테스트 순서는 무작위이고, 쪽지함이
    //    없으면 `ax_send` 는 (일부러) 거부한다 — 준비 안 된 곳에 쪽지를 쓰면
    //    아무에게도 안 가고 나중에 지워야 할 것으로 보이기 때문이다.
    const r = rpc([
      call(1, 'ax_init'),
      call(2, 'ax_send', { to: 'someone', subject: '제목', body: '본문' }),
    ])
    assert.equal(r.get(2).result.isError, false, `쪽지를 못 보냈다: ${textOf(r.get(2))}`)

    // 쪽지는 **고아 브랜치의 worktree** 에 쌓인다. 작업 트리(`docs/bus`)에 두면
    // 상대에게 가는 데 커밋->MR->머지->pull 이 필요했다. 근거는 bin/axmap.mjs 의
    // BUS_BRANCH 주석.
    const box = path.join(repo, '.axmap', 'bus', 'messages')
    const here = fs.existsSync(box) ? fs.readdirSync(box).filter((f) => f.endsWith('.md')) : []
    assert.ok(here.length > 0, '대상 저장소에 쪽지가 안 생겼다 — bus.mjs 를 REPO 에서 찾고 있지 않은지 본다')

    // 🔴 axMap 자신의 쪽지함이 오염되면 안 된다. 팀의 쪽지가 도구 저장소에 쌓이는 것은
    //    조용한 실패다 — 보낸 사람은 성공을 보고, 받는 사람은 영원히 못 받는다.
    //
    //    쪽지함 폴더가 아예 없는 저장소도 있다(새로 시작한 팀). 그때 이 검사는
    //    자동으로 통과여야지 예외로 죽으면 안 된다 — 없는 것과 오염된 것은 다르다.
    //    옛 자리(docs/bus)도 함께 본다 — 거기로 새 쪽지가 떨어지는 것도 회귀다.
    let mine = []
    for (const d of [path.join(SELF, '.axmap', 'bus', 'messages'), path.join(SELF, 'docs', 'bus'), path.join(repo, 'docs', 'bus')]) {
      try { mine = mine.concat(fs.readdirSync(d)) } catch { /* 없으면 빈 것 */ }
    }
    assert.equal(mine.filter((f) => f.includes('제목')).length, 0, '쪽지가 엉뚱한 곳에 떨어졌다')
  })

  it('ax_inbox 가 예외로 죽지 않는다', () => {
    const r = rpc([call(1, 'ax_inbox', {})], { agent: 'someone' })
    const t = textOf(r.get(1))
    assert.equal(r.get(1).result.isError, false, `쪽지함이 죽었다: ${t}`)
    assert.doesNotMatch(t, /MODULE_NOT_FOUND|Cannot find module/, 'bus.mjs 를 대상 저장소에서 찾고 있다')
  })
})

describe('브리핑은 대상 저장소를 설명한다', () => {
  it('🔴 axMap 자신의 구성 목록를 남에게 주지 않는다', () => {
    const t = textOf(rpc([call(1, 'ax_brief')]).get(1))
    // 이것들은 axMap 의 파일이다. 남의 브리핑에 나오면 남의 지도를 준 것이다.
    for (const leak of ['src/protocol.mjs', 'src/bridge.mjs', 'src/terminal-bridge.mjs']) {
      assert.ok(!t.includes(leak), `대상 저장소 브리핑에 axMap 의 파일이 샜다: ${leak}`)
    }
  })

  it('대상의 문서를 읽는다', () => {
    const t = textOf(rpc([call(1, 'ax_brief')]).get(1))
    assert.match(t, /영상 스트리밍 백엔드다/, '대상의 CLAUDE.md 를 안 읽었다')
    assert.match(t, /D1 · 큐는 Redis 로 간다/, '대상의 DECISIONS.md 를 안 읽었다')
    assert.match(t, /npm run lint/, '대상의 검증 절을 안 읽었다')
  })

  it('axMap 의 검증 명령을 남의 저장소에 요구하지 않는다', () => {
    const t = textOf(rpc([call(1, 'ax_brief')]).get(1))
    assert.doesNotMatch(t, /demo:chaos/, 'axMap 의 검증 목록이 샜다')
  })
})

describe('자기 자신을 겨눴을 때는 그대로다', () => {
  it('구성 목록과 검증 목록이 나온다', () => {
    const t = textOf(rpc([call(1, 'ax_brief')], { repoPath: SELF }).get(1))
    assert.match(t, /## 주요 구성/)
    assert.match(t, /src\/protocol\.mjs/)
    assert.match(t, /demo:chaos/, 'CLAUDE.md 의 검증 절에서 읽어와야 한다')
  })
})

describe('이름이 없으면 뜨지 않는다', () => {
  it('AXMAP_AGENT 도 git config user.name 도 없으면 서버가 죽는다', () => {
    // 기본 이름으로 채우면 여러 사람이 장부에서 한 명이 된다. 그래서 fail-closed 다.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-noname-'))
    try {
      const env = { ...process.env, AXMAP_REPO: bare }
      delete env.AXMAP_AGENT

      // 🔴 **git 저장소가 아니라는 것만으로는 이름이 비지 않는다.**
      //
      //    `git config user.name` 은 저장소 밖에서도 전역(`~/.gitconfig`)과 시스템
      //    설정을 읽는다. 그래서 예전 주석("git 저장소가 아니므로 폴백도 비어
      //    있다")은 사실이 아니었고, 이 검사는 **전역 이름이 없는 기계에서만
      //    초록**이었다. CI 는 그런 기계이고 개발자 PC 는 아니라서, 이 파일은
      //    사람이 로컬에서 돌릴 때마다 빨갰다.
      //
      //    빨간 채로 오래 있는 검사는 없는 검사보다 나쁘다 — 다음 사람이
      //    스위트 전체를 안 믿게 되고, 그때부터 진짜 회귀도 같이 묻힌다.
      //
      //    그래서 환경을 진짜로 비운다. 없는 경로를 가리키면 git 은 그 설정이
      //    없는 것으로 본다 (git 2.32+).
      const noConfig = path.join(bare, '없는-gitconfig')
      env.GIT_CONFIG_GLOBAL = noConfig
      env.GIT_CONFIG_SYSTEM = noConfig
      const r = spawnSync(process.execPath, [SERVER], {
        input: '', encoding: 'utf8', windowsHide: true, env,
      })
      assert.notEqual(r.status, 0, '이름 없이 떴다 — 여러 에이전트가 한 사람이 된다')
      assert.match(r.stderr, /에이전트 이름을 알 수 없습니다/)
    } finally {
      try { fs.rmSync(bare, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
    }
  })
})

// ---------------------------------------------------------------------------
// 대상 저장소를 요청마다 다시 정한다
// ---------------------------------------------------------------------------
//
// 🔴 여기서 고정하는 것은 **한 프로세스 안에서 대상이 바뀌는 조합**이다.
//    예전에는 `REPO` 가 `const` 라 서버가 켜질 때 한 번 정해지면 끝이었고,
//    사람이 앱에서 다른 저장소를 열어도 MCP 는 처음 폴더를 계속 붙잡고 있었다.
//    위의 테스트들은 전부 프로세스마다 대상이 하나였으므로 이것을 못 잡는다.

const CLI_PATH = path.join(SELF, 'bin', 'axmap.mjs')

/** 경로 비교용. 윈도우의 역슬래시와 대소문자 때문에 그냥 비교하면 안 된다. */
const norm = (p) => {
  const BS = String.fromCharCode(92)
  try { return fs.realpathSync(p).split(BS).join('/').toLowerCase() } catch { return String(p).split(BS).join('/').toLowerCase() }
}

/** 브리핑이 스스로 밝힌 대상 저장소. */
const targetOf = (text) => {
  const m = text.match(/대상 저장소: `([^`]+)`/)
  return m ? m[1] : null
}

/** 커밋 하나가 든 git 저장소를 임시로 만든다. 장부는 아직 없다. */
function makeRepo(tag) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `axmap-${tag}-`)))
  const g = (...a) => spawnSync('git', a, { cwd: d, encoding: 'utf8', windowsHide: true })
  g('init', '-q')
  g('config', 'user.name', 'switcher')
  g('config', 'user.email', 'x@example.com')
  g('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(d, 'app.js'), 'console.log(1)\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'first')
  return d
}

const axmapCli = (cwd, args, agent = 'switcher') =>
  spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, AXMAP_AGENT: agent },
  })

/**
 * `AXMAP_REPO` 를 **일부러 안 넘긴다.** 이 절이 재는 것이 바로 "안 넘겼을 때
 * 무엇을 고르는가" 이므로, 위의 `rpc()` 를 쓰면 재려는 것을 손으로 정해 버린다.
 */
function rpcRaw(requests, { cwd, env = {} }) {
  const lines = [
    { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    ...requests,
  ]
  const e = { ...process.env, AXMAP_AGENT: 'switcher', ...env }
  delete e.AXMAP_REPO
  if (env.AXMAP_REPO) e.AXMAP_REPO = env.AXMAP_REPO
  const r = spawnSync(process.execPath, [SERVER], {
    input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    cwd, encoding: 'utf8', windowsHide: true, env: e,
  })
  const out = new Map()
  for (const line of (r.stdout ?? '').split('\n')) {
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.id !== undefined) out.set(m.id, m)
  }
  return out
}

/** 서버를 띄워 두고 요청을 하나씩 주고받는다. 도중에 대상을 바꿔야 하므로 필요하다. */
function openServer({ cwd, env = {}, roots = [] }) {
  const e = { ...process.env, AXMAP_AGENT: 'switcher', ...env }
  delete e.AXMAP_REPO
  const p = spawn(process.execPath, [SERVER], { cwd, env: e, stdio: ['pipe', 'pipe', 'pipe'] })
  p.stderr.resume()
  const waiting = new Map()
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      const m = JSON.parse(line)
      if (m.method === 'roots/list') {
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots } }) + '\n')
        continue
      }
      const done = waiting.get(m.id)
      if (done) { waiting.delete(m.id); done(m) }
    }
  })
  let id = 0
  const send = (method, params) => new Promise((res, reject) => {
    const mine = ++id
    const timer = setTimeout(() => reject(new Error(`MCP 응답 시간 초과: ${method}`)), 15000)
    waiting.set(mine, (msg) => { clearTimeout(timer); res(msg) })
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n')
  })
  return {
    send,
    tool: (name, args = {}) => send('tools/call', { name, arguments: args }),
    setRoots: (next) => {
      roots = next
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }) + '\n')
    },
    close: () => p.kill(),
  }
}

describe('대상 저장소를 요청마다 다시 정한다', () => {
  let stateDir = null
  let A = null
  let B = null
  const setTarget = (dir) =>
    fs.writeFileSync(path.join(stateDir, 'current.json'), JSON.stringify({ target: dir }) + '\n')

  before(() => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-state-')))
    A = makeRepo('A')
    B = makeRepo('B')
    assert.equal(axmapCli(A, ['init']).status, 0, 'A 에 장부를 못 만들었다')
    assert.equal(axmapCli(B, ['init']).status, 0, 'B 에 장부를 못 만들었다')
  })

  after(() => {
    for (const d of [stateDir, A, B]) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
    }
  })

  it('🔴 하위 폴더에서 켜도 저장소 루트를 겨눈다', () => {
    const sub = path.join(A, 'FE', 'src')
    fs.mkdirSync(sub, { recursive: true })
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-empty-'))
    const t = textOf(rpcRaw([call(1, 'ax_brief')], { cwd: sub, env: { AXMAP_STATE_DIR: empty } }).get(1))
    // cwd 를 그대로 쓰면 `FE/src` 를 겨눠서 장부가 갈린다 — 팀원과 다른 장부를 본다.
    assert.equal(norm(targetOf(t)), norm(A), `하위 폴더를 겨눴다: ${targetOf(t)}`)
  })

  it('앱의 전역 타겟이 다른 repo여도 이 세션의 작업 repo를 사용한다', () => {
    setTarget(B)
    const t = textOf(rpcRaw([call(1, 'ax_brief')], { cwd: A, env: { AXMAP_STATE_DIR: stateDir } }).get(1))
    assert.equal(norm(targetOf(t)), norm(A), '전역 타겟 때문에 다른 repo를 겨눴다')
  })

  it('AXMAP_REPO 로 고정해 두면 그것이 이긴다 — 명시가 항상 우선', () => {
    setTarget(B)
    const t = textOf(rpcRaw([call(1, 'ax_brief')], { cwd: A, env: { AXMAP_STATE_DIR: stateDir, AXMAP_REPO: A } }).get(1))
    assert.equal(norm(targetOf(t)), norm(A), '고정해 둔 값이 무시됐다')
  })

  it('client roots 가 시작 repo보다 우선하고 새 repo를 자동 준비한다', async () => {
    const fresh = makeRepo('roots-fresh')
    const launch = makeRepo('unused-launch')
    const s = openServer({ cwd: launch, roots: [{ uri: pathToFileURL(fresh).href }] })
    try {
      await s.send('initialize', { capabilities: { roots: {} } })
      const r = await s.tool('ax_claim', { paths: ['app.js'], intent: 'new repo' })
      assert.equal(r.result.isError, false, textOf(r))
      assert.ok(fs.existsSync(path.join(fresh, '.axmap', 'ledger', '.git')))
      assert.equal(fs.existsSync(path.join(launch, '.axmap', 'ledger')), false, '사용하지 않은 시작 repo를 초기화했다')
      const brief = await s.tool('ax_brief')
      assert.equal(norm(targetOf(textOf(brief))), norm(fresh))
    } finally {
      s.close()
      fs.rmSync(fresh, { recursive: true, force: true })
      fs.rmSync(launch, { recursive: true, force: true })
    }
  })

  it('여러 roots 중 repo를 못 고르면 중단하고 cwd 로 지정할 수 있다', async () => {
    const s = openServer({ cwd: stateDir, roots: [{ uri: pathToFileURL(A).href }, { uri: pathToFileURL(B).href }] })
    try {
      await s.send('initialize', { capabilities: { roots: {} } })
      const ambiguous = await s.tool('ax_status')
      assert.equal(ambiguous.result.isError, true)
      assert.match(textOf(ambiguous), /하나로 정할 수 없습니다/)
      const chosen = await s.tool('ax_brief', { cwd: B })
      assert.equal(chosen.result.isError, false, textOf(chosen))
      assert.equal(norm(targetOf(textOf(chosen))), norm(B))
    } finally { s.close() }
  })

  it('roots 를 못 읽으면 시작 repo로 되돌아가서 선점하지 않는다', async () => {
    const s = openServer({ cwd: A, roots: null })
    try {
      await s.send('initialize', { capabilities: { roots: {} } })
      const r = await s.tool('ax_claim', { paths: ['never-created'], intent: 'must fail' })
      assert.equal(r.result.isError, true)
      assert.match(textOf(r), /작업 폴더를 확인하지 못했습니다/)
    } finally { s.close() }
  })

  it('201과 109에 해당하는 두 세션은 전역 앱 타겟이 바뀌어도 독립적으로 선점한다', async () => {
    const a = openServer({ cwd: A, env: { AXMAP_STATE_DIR: stateDir } })
    const b = openServer({ cwd: B, env: { AXMAP_STATE_DIR: stateDir } })
    try {
      await Promise.all([a.send('initialize', { capabilities: {} }), b.send('initialize', { capabilities: {} })])
      const claims = await Promise.all([a.tool('ax_claim', { paths: ['app.js'] }), b.tool('ax_claim', { paths: ['app.js'] })])
      for (const r of claims) assert.equal(r.result.isError, false, textOf(r))
      setTarget(B)
      const briefs = await Promise.all([a.tool('ax_brief'), b.tool('ax_brief')])
      assert.equal(norm(targetOf(textOf(briefs[0]))), norm(A))
      assert.equal(norm(targetOf(textOf(briefs[1]))), norm(B))
      await Promise.all([a.tool('ax_release'), b.tool('ax_release')])
    } finally { a.close(); b.close() }
  })

  it('🔴 도중에 대상이 바뀌면 이전 저장소의 claim 을 전부 반납한다', async () => {
    setTarget(A)
    const s = openServer({ cwd: A, env: { AXMAP_STATE_DIR: stateDir }, roots: [{ uri: pathToFileURL(A).href }] })
    try {
      await s.send('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 't', version: '0' } })

      const claimed = await s.tool('ax_claim', { paths: ['app.js'], intent: 'A 에서 일한다' })
      assert.equal(claimed.result.isError, false, `A 에서 claim 실패: ${textOf(claimed)}`)

      // 클라이언트가 이 세션의 작업 폴더를 B 로 바꿨다.
      s.setRoots([{ uri: pathToFileURL(B).href }])

      const after1 = await s.tool('ax_status')
      const t = textOf(after1)
      assert.match(t, /대상 저장소가 바뀌었습니다/, '대상이 바뀐 것을 에이전트에게 안 알렸다')
      assert.match(t, /반납/, '반납 여부를 안 알렸다')

      // 🔴 알림만 하고 실제로는 안 풀었으면, 그 잠금을 풀 창구가 사라진 것이다.
      //    A 를 직접 겨눠서 장부를 본다.
      const back = axmapCli(A, ['status'])
      assert.doesNotMatch(back.stdout, /app\.js/, 'A 의 claim 이 그대로 남았다 — TTL 까지 팀원이 막힌다')
    } finally {
      s.close()
    }
  })
})

describe('안 읽은 쪽지 배너', () => {
  /**
   * 🔴 이 검사가 고정하는 것은 개수가 아니라 **접힌 쪽지의 운명**이다.
   *
   *    배너는 위 3건만 그리고 나머지는 "… 그 밖에 N건" 으로 접는다. 읽음 표시를
   *    목록 전체에 찍으면 접힌 쪽지는 **화면에 뜬 적도 없이** 읽음이 되고, 그
   *    뒤로 영영 안 뜬다. 오류도 없고 로그도 없다 — 그냥 사라진다.
   *
   *    그래서 세 번 부른다. 5 → 2 → 없음 이어야 한다. 5 → 없음 이면 셋이 묻힌 것이고,
   *    5 → 5 → 5 면 읽음이 아예 안 찍히는 것이다. 두 고장이 서로 반대 방향이라
   *    한 번만 불러서는 어느 쪽인지 알 수 없다.
   */
  /**
   * 🔴 문구가 **`bin/axmap.mjs` 의 `printUnread` 와 같아야 한다.** 예전에는 배너가
   *    "나에게 온 쪽지 N건", CLI 가 "안 읽은 쪽지 N건" 이라 한 사람이 한 화면에서
   *    이름이 다른 두 숫자를 봤다 — 둘 다 미읽음인데도. 여기서 문구를 고정한다.
   *
   *    아래 `doesNotMatch` 는 `ax_check` 결과에만 건다. `ax_status`·`ax_claim` 은
   *    CLI 가 같은 문장을 스스로 찍으므로 그 도구로는 이 단언이 성립하지 않는다.
   */
  it('🔴 배너가 그린 것만 읽음이 된다 — 접힌 쪽지가 조용히 사라지면 안 된다', () => {
    // 보내는 쪽과 받는 쪽을 다른 이름으로 둔다 — 자기가 보낸 쪽지는 세면 안 된다.
    const sends = [call(1, 'ax_init')]
    for (let i = 0; i < 5; i++) {
      sends.push(call(2 + i, 'ax_send', { to: 'reader', subject: `쪽지${i}`, body: `본문${i}` }))
    }
    const sent = rpc(sends, { agent: 'sender' })
    for (let i = 0; i < 5; i++) {
      assert.equal(sent.get(2 + i).result.isError, false, `쪽지를 못 보냈다: ${textOf(sent.get(2 + i))}`)
    }

    const banner = () => textOf(rpc([call(1, 'ax_check', { paths: ['app.js'] })], { agent: 'reader' }).get(1))

    // 1회차 — 5건이라고 말하고 3건을 그린다
    const t1 = banner()
    assert.match(t1, /안 읽은 쪽지 5건/, `배너가 5건을 못 셌다:\n${t1}`)
    assert.match(t1, /그 밖에 2건/, `3건만 그려야 한다:\n${t1}`)

    // 2회차 — 그린 3건만 읽음이 됐으므로 2건이 남는다.
    // 여기서 "쪽지 없음" 이 나오면 접힌 2건이 묻힌 것이다. 그게 이 검사의 이유다.
    const t2 = banner()
    assert.match(t2, /안 읽은 쪽지 2건/, `그린 3건만 읽음이 되어야 한다:\n${t2}`)

    // 3회차 — 남은 2건도 그렸으니 배너가 사라진다
    assert.doesNotMatch(banner(), /안 읽은 쪽지/, '다 그렸는데도 배너가 남았다 — 읽음이 안 찍힌다')
  })

  it('🔴 ax_inbox 로 목록을 열면 배너가 줄어든다 — 읽었는데 안 읽었다고 하면 배너는 배경이 된다', () => {
    const sends = [call(1, 'ax_init')]
    for (let i = 0; i < 4; i++) {
      sends.push(call(2 + i, 'ax_send', { to: 'inbox-recipient', subject: `함${i}`, body: `본문${i}` }))
    }
    const sent = rpc(sends, { agent: 'sender2' })
    for (let i = 0; i < 4; i++) assert.equal(sent.get(2 + i).result.isError, false, textOf(sent.get(2 + i)))

    // 쪽지함을 연다. 자르지 않고 전부 냈으므로 전부 읽음이 된다.
    const inbox = rpc([call(1, 'ax_inbox', {})], { agent: 'inbox-recipient' })
    assert.equal(inbox.get(1).result.isError, false, `쪽지함이 죽었다: ${textOf(inbox.get(1))}`)
    assert.match(textOf(inbox.get(1)), /함0/, '쪽지가 목록에 안 나왔다')

    const after = textOf(rpc([call(1, 'ax_check', { paths: ['app.js'] })], { agent: 'inbox-recipient' }).get(1))
    assert.doesNotMatch(after, /안 읽은 쪽지/, `쪽지함을 열었는데 배너가 그대로다:\n${after}`)
  })
})

describe('장부가 없을 때 — 막다른 길을 남기지 않는다', () => {
  /**
   * 🔴 안내가 `ax_claim` 안에만 있었다. `ax_check` · `ax_status` · `ax_release` ·
   *    `ax_renew` 는 CLI 원문("axmap init 을 실행하세요")을 그대로 냈다.
   *
   *    하필 `ax_check` 는 설명이 "작업 계획을 세울 때 쓴다" 라 **claim 보다 먼저
   *    불리는 도구**다. 처음 온 사람은 고쳐둔 안내를 못 보고 원래의 막다른 길을
   *    먼저 밟는다 — 에이전트에게는 셸이 없으므로 거기서 멈춘다.
   */
  it('ax_check 가 먼저 불려도 장부를 자동 준비하고 JSON을 읽는다', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-noledger-'))
    try {
      const g = (...a) => spawnSync('git', a, { cwd: fresh, encoding: 'utf8', windowsHide: true })
      g('init', '-q')
      g('config', 'user.name', 'nobody')
      g('config', 'user.email', 'n@example.com')
      g('config', 'commit.gpgsign', 'false')
      fs.writeFileSync(path.join(fresh, 'app.js'), 'console.log(1)\n')
      g('add', '-A')
      g('commit', '-q', '-m', 'first')

      const r = rpc([call(1, 'ax_check', { paths: ['app.js'] })], { repoPath: fresh })
      const t = textOf(r.get(1))
      assert.equal(r.get(1).result.isError, false, t)
      assert.match(t, /겹치지 않습니다/)
      assert.ok(fs.existsSync(path.join(fresh, '.axmap', 'ledger', '.git')))
    } finally {
      try { fs.rmSync(fresh, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
    }
  })

  it('장부가 생기면 ax_check 가 정상 판정한다 — 안내가 정상 경로를 가리지 않는다', () => {
    const r = rpc([call(1, 'ax_init'), call(2, 'ax_check', { paths: ['app.js'] })])
    const t = textOf(r.get(2))
    assert.equal(r.get(2).result.isError, false, `ax_check 가 실패했다:\n${t}`)
    assert.match(t, /겹치지 않습니다/)
    assert.doesNotMatch(t, /ax_init/, '정상인데 init 안내가 붙었다')
  })
})

describe('ax_check 는 판정을 못 하면 막는다', () => {
  /**
   * 🔴 이것이 실제로 터져 있던 버그다. 가정이 아니다.
   *
   *    `axmap status` 는 원격이 없으면 stderr 로 경고한다("단일 작업자 모드로 돕니다").
   *    `cli()` 가 stdout 과 stderr 를 **합쳐서** 돌려주던 시절, 그 경고가 JSON 뒤에
   *    붙어 `JSON.parse` 를 죽였다. 그리고 `ax_check` 는 실패를 삼키고 빈 목록으로
   *    내려가 **"겹치지 않습니다. claim 해도 됩니다"** 를 냈다 — 장부에 남의 claim 이
   *    몇 개가 있든 상관없이.
   *
   *    원격이 없는 저장소(새로 시작한 팀, 테스트 저장소)에서는 **언제나** 그랬다.
   *    이 도구가 막으려는 사고를 이 도구가 직접 통과시키고 있었다.
   */
  it('🔴 원격이 없어 경고가 붙어도 남의 claim 을 본다 — 경고 한 줄에 판정이 무너졌었다', () => {
    const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-solo-'))
    try {
      const g = (...a) => spawnSync('git', a, { cwd: solo, encoding: 'utf8', windowsHide: true })
      g('init', '-q')
      g('config', 'user.name', 'solo')
      g('config', 'user.email', 's@example.com')
      g('config', 'commit.gpgsign', 'false')
      fs.writeFileSync(path.join(solo, 'app.js'), 'console.log(1)\n')
      g('add', '-A')
      g('commit', '-q', '-m', 'first')

      const a = rpc(
        [call(1, 'ax_init'), call(2, 'ax_claim', { paths: ['app.js'], intent: 'A 가 먼저 잡는다' })],
        { repoPath: solo, agent: 'agent-A' },
      )
      assert.equal(a.get(2).result.isError, false, `A 의 claim 이 실패했다: ${textOf(a.get(2))}`)

      const b = rpc([call(1, 'ax_check', { paths: ['app.js'] })], { repoPath: solo, agent: 'agent-B' })
      const t = textOf(b.get(1))
      assert.match(t, /겹칩니다/, `남의 claim 을 못 봤다 — 판정이 무너졌다:\n${t}`)
      assert.match(t, /agent-A/, '누가 잡고 있는지 안 알려준다')
      // 판정에서 뺐을 뿐, 경고는 사람에게 그대로 간다.
      assert.match(t, /단일 작업자 모드/, '판정의 한계를 알리는 경고가 사라졌다')
    } finally {
      try { fs.rmSync(solo, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
    }
  })
})
