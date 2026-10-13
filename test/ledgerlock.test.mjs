/**
 * 장부 git 호출이 `index.lock` 에서 버티는가.
 *
 * 🔴 고치기 전에는 **락 하나에 즉시 죽었다.**
 *
 * 같은 worktree 에서 다른 프로세스가 장부를 커밋하는 중이면 `git add -A` 가
 * "Unable to create '.../index.lock': File exists" 로 실패하고, `gitOrDie` 가
 * 그대로 exit 1 을 냈다. `MAX_CAS_RETRIES` 루프는 **push 거부 전용**이라 이것을
 * 전혀 덮지 않는다 — 관문 1 은 원격 ref 의 경합이고 이쪽은 로컬 파일의 경합이다.
 * 앱에서 세션을 여럿 굴리면(= 이 프로젝트가 하려는 바로 그것) 매번 밟는다.
 *
 * 여기서는 락 파일을 **직접 만들어 두고** 두 갈래를 고정한다.
 *   1. 도중에 풀리면 성공한다        재시도가 실제로 돌고 있다는 증거
 *   2. 끝내 안 풀리면 원인을 말하며 죽는다   "종료 코드 1" 만으로는 아무도 못 고친다
 *
 * 그리고 2에서 **로컬에 claim 이 남지 않는지**를 함께 본다. 커밋 전에 죽었으므로
 * 그 레코드는 어디에도 도달하지 않았는데, 남겨두면 이 저장소만 "내가 쥐고 있다"
 * 고 말한다. 락 시스템에서 가장 나쁜 방향의 실패(fail-open)다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'axmap.mjs')

let repo = null
let lockFile = null

const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true })

function env(agent) {
  const e = { ...process.env }
  delete e.AXMAP_AGENT
  if (agent) e.AXMAP_AGENT = agent
  return e
}

/** 동기로 한 번 돌린다. */
const run = (args, agent) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env: env(agent), encoding: 'utf8', windowsHide: true })

/** 비동기로 띄우고 종료를 기다린다. 도중에 락을 풀어야 하므로 sync 로는 안 된다. */
function runAsync(args, agent) {
  const p = spawn(process.execPath, [CLI, ...args], { cwd: repo, env: env(agent), windowsHide: true })
  let out = ''
  let err = ''
  p.stdout.setEncoding('utf8')
  p.stderr.setEncoding('utf8')
  p.stdout.on('data', (c) => { out += c })
  p.stderr.on('data', (c) => { err += c })
  return new Promise((resolve) => p.on('close', (code) => resolve({ status: code, stdout: out, stderr: err })))
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-lock-'))
  git('init', '-q')
  git('config', 'user.name', 'lock-tester')
  git('config', 'user.email', 'x@example.com')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'hello\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  const r = run(['init'], 'setup')
  assert.equal(r.status, 0, `init 실패: ${r.stderr || r.stdout}`)

  /**
   * 락 파일의 자리를 git 에게 물어본다. 손으로 `.git/worktrees/ledger/index.lock`
   * 이라고 적으면 worktree 이름 규칙이 바뀌는 날 조용히 "락이 없는" 테스트가 된다 —
   * 그러면 이 파일은 늘 초록이면서 아무것도 지키지 않는다.
   */
  const dir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: path.join(repo, '.axmap', 'ledger'), encoding: 'utf8', windowsHide: true,
  })
  assert.equal(dir.status, 0, dir.stderr)
  lockFile = path.join(dir.stdout.trim(), 'index.lock')
})

after(() => {
  try { fs.rmSync(lockFile, { force: true }) } catch { /* 없으면 그만 */ }
  try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
})

const lock = () => fs.writeFileSync(lockFile, `${process.pid}\n`)
/**
 * 이 이름의 레코드가 장부에 있는가.
 *
 * 🔴 **파일명을 계산하지 않고 내용을 본다.** 레코드는 (이름, 세션) 짝마다 하나라
 *    파일명에 세션이 섞인다. 그 규칙을 검사가 다시 구현하면, 검사하는 대상이
 *    제품이 아니라 검사기가 된다.
 */
const hasClaim = (agent) => {
  const dir = path.join(repo, '.axmap', 'ledger', 'claims')
  if (!fs.existsSync(dir)) return false
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .some((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).agent === agent)
}

describe('index.lock 경합', () => {
  it('🔴 도중에 락이 풀리면 claim 이 성공한다 (재시도가 실제로 돈다)', async () => {
    lock()
    const done = runAsync(['claim', 'a.txt', '--task', 'T-lock', '--intent', '락 재시도'], 'lock-a')
    // 백오프 계단은 50→1600ms 다. 여기서 풀면 앞쪽 회차 중 하나가 통과한다.
    const timer = setTimeout(() => fs.rmSync(lockFile, { force: true }), 400)
    const r = await done
    clearTimeout(timer)

    assert.equal(r.status, 0, `claim 이 실패했다:\n${r.stderr}`)
    assert.match(r.stderr, /장부가 잠겨 있습니다/, '재시도 없이 우연히 통과한 것이 아닌지 확인한다')
    assert.ok(hasClaim('lock-a'), '레코드가 남아야 한다')
  })

  it('🔴 끝내 안 풀리면 원인을 말하며 죽는다 (종료 코드만으로는 못 고친다)', () => {
    lock()
    try {
      const r = run(['claim', 'b.txt', '--task', 'T-lock2', '--intent', '락 포기'], 'lock-b')
      assert.notEqual(r.status, 0, '락이 남아 있는데 성공했다')
      assert.match(r.stderr, /다른 에이전트가 장부를 쓰는 중/)
      // 원문을 함께 보여줘야 한다. 원인을 뭉개지 않는 것이 이 파일의 규칙이다.
      assert.match(r.stderr, /index\.lock/)
      // 🔴 커밋도 push 도 안 된 claim 을 로컬에 남기지 않는다.
      assert.equal(hasClaim('lock-b'), false, '도달하지 않은 claim 이 남았다 (fail-open)')
    } finally {
      fs.rmSync(lockFile, { force: true })
    }
  })

  it('락이 없으면 기다리지 않는다 (재시도가 평상시를 느리게 하면 안 된다)', () => {
    const t0 = Date.now()
    const r = run(['claim', 'b.txt', '--task', 'T-fast', '--intent', '평상시'], 'lock-c')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(/장부가 잠겨 있습니다/.test(r.stderr), false)
    assert.ok(Date.now() - t0 < 3000, '락이 없는데 백오프를 탔다')
  })
})
