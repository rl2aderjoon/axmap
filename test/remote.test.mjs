/**
 * 장부 원격의 **이름**을 정하는 규칙.
 *
 * 🔴 이 파일이 없던 동안 `origin` 이 6곳에 하드코딩돼 있었고, 그것이 만드는 실패는
 *    이 저장소가 금지한 fail-open 그 자체였다.
 *
 *    `hasRemote()` 가 false 가 되면 `syncLedger` 는 즉시 return 하고 `pushLedger` 는
 *    push 없이 'ok' 를 낸다. 관문 1(CAS)이 통째로 사라지고 관문 2만 남는데, 관문 2는
 *    자기 장부에 대고 판정하므로 **영원히 자기 자신하고만 비교한다.** 여섯 명이 같은
 *    파일을 잡아도 전부 성공하고, 종료 코드는 0이며, 경고는 init 때 한 줄뿐이었다.
 *
 *    안 잡힌 이유는 단순하다 — 데모도 카오스도 테스트도 전부 원격 이름이 `origin` 인
 *    저장소를 만든다. 도는 조합이 하나뿐이었다. 그래서 여기서 고정하는 것은
 *    "원격이 있다/없다" 가 아니라 **이름이 origin 이 아닌 세계**다.
 *
 * 진짜 저장소 둘을 만들어 서로를 보게 한다. 순수 함수로는 이 층을 못 잡는다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'axmap.mjs')

let box = null

function sh(cwd, cmd, ...args) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true })
}

/** `agent` 로 axmap 을 돌린다. AXMAP_REMOTE 는 새는 것을 막기 위해 항상 지운다. */
function ax(cwd, args, agent = 'tester', extraEnv = {}) {
  const env = { ...process.env, AXMAP_AGENT: agent, ...extraEnv }
  if (!('AXMAP_REMOTE' in extraEnv)) delete env.AXMAP_REMOTE
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', windowsHide: true })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/** 커밋 하나 든 저장소를 만든다. 원격은 붙이지 않는다. */
function newRepo(name) {
  const dir = path.join(box, name)
  fs.mkdirSync(dir, { recursive: true })
  sh(dir, 'git', 'init', '-q')
  sh(dir, 'git', 'config', 'user.name', 'tester')
  sh(dir, 'git', 'config', 'user.email', 'x@example.com')
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'x\n')
  sh(dir, 'git', 'add', '-A')
  sh(dir, 'git', 'commit', '-q', '-m', 'first')
  return dir
}

function newHub(name) {
  const dir = path.join(box, name)
  sh(box, 'git', 'init', '-q', '--bare', dir)
  return dir
}

before(() => { box = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-remote-')) })
after(() => { try { fs.rmSync(box, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ } })

describe('원격 이름을 정하는 순서', () => {
  it('원격이 하나뿐이면 이름이 무엇이든 그것을 쓴다', () => {
    const repo = newRepo('one')
    sh(repo, 'git', 'remote', 'add', 'upstream', newHub('one-hub.git'))
    const r = ax(repo, ['init'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /장부 원격: upstream/)
  })

  it('🔴 고른 결과를 git config 에 박아 둔다 — 다음부터 아무도 추측하지 않는다', () => {
    const repo = newRepo('pin')
    sh(repo, 'git', 'remote', 'add', 'gitlab', newHub('pin-hub.git'))
    ax(repo, ['init'])
    const cfg = sh(repo, 'git', 'config', '--get', 'axmap.remote').stdout.trim()
    assert.equal(cfg, 'gitlab', '추론한 결과가 저장소에 남지 않았다')
  })

  it('🔴 원격이 둘 이상인데 지정이 없으면 고르지 않고 멈춘다', () => {
    const repo = newRepo('two')
    sh(repo, 'git', 'remote', 'add', 'team', newHub('two-a.git'))
    sh(repo, 'git', 'remote', 'add', 'mine', newHub('two-b.git'))
    const r = ax(repo, ['init'])
    // 하나를 골라 주면 장부가 엉뚱한 저장소로 가고, 그 실패에는 증상이 없다.
    assert.equal(r.code, 1, '여럿인데 그냥 통과했다')
    assert.match(r.err, /원격이 둘 이상입니다/)
    assert.match(r.err, /team/)
    assert.match(r.err, /mine/)
  })

  it('여럿이어도 --remote 로 지정하면 진행한다', () => {
    const repo = newRepo('two-pick')
    sh(repo, 'git', 'remote', 'add', 'team', newHub('two-pick-a.git'))
    sh(repo, 'git', 'remote', 'add', 'mine', newHub('two-pick-b.git'))
    const r = ax(repo, ['init', '--remote', 'team'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /장부 원격: team/)
  })

  it('여럿이어도 origin 이 있으면 origin 으로 떨어진다 — 옛 동작과의 호환', () => {
    const repo = newRepo('two-origin')
    sh(repo, 'git', 'remote', 'add', 'origin', newHub('two-origin-a.git'))
    sh(repo, 'git', 'remote', 'add', 'aws', newHub('two-origin-b.git'))
    const r = ax(repo, ['init'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /장부 원격: origin/)
  })

  it('🔴 지정한 이름이 실제로 없으면 거부한다 — 오타가 곧 무보호 상태다', () => {
    const repo = newRepo('typo')
    sh(repo, 'git', 'remote', 'add', 'team', newHub('typo-hub.git'))
    const r = ax(repo, ['init'], 'tester', { AXMAP_REMOTE: 'teem' })
    assert.equal(r.code, 1)
    assert.match(r.err, /가리키는 원격이 없습니다/)
  })
})

describe('원격 없이 도는 것은 경고한다 — 조용히 넘어가지 않는다', () => {
  it('claim 이 성공해도 매번 stderr 에 남는다', () => {
    const repo = newRepo('solo')
    assert.equal(ax(repo, ['init']).code, 0)
    const r = ax(repo, ['claim', 'shared.txt', '--intent', '혼자'])
    // 거부까지 가지 않는 이유는 혼자 쓰는 사람이 실제로 있기 때문이다.
    assert.equal(r.code, 0, '혼자 쓰는 것을 막지는 않는다')
    // 다만 조용하지는 않게 한다. init 때 한 줄이 전부였던 것이 사고의 절반이었다.
    assert.match(r.err, /단일 작업자 모드|관문 1/, '원격 없이 claim 했는데 아무 말도 없다')
  })
})

describe('🔴 이름이 origin 이 아니어도 관문 1 이 실제로 돈다', () => {
  it('원격 이름이 team 인 두 클론이 서로의 claim 을 본다', () => {
    const hub = newHub('gate-hub.git')

    // 씨앗을 만들어 허브에 올린다.
    const seed = newRepo('gate-seed')
    sh(seed, 'git', 'push', '-q', hub, 'HEAD:main')

    // 두 사람이 각자 클론하고, 원격 이름을 origin 이 아닌 것으로 바꾼다.
    const clones = ['A', 'B'].map((n) => {
      const dir = path.join(box, `gate-${n}`)
      sh(box, 'git', 'clone', '-q', hub, dir)
      sh(dir, 'git', 'config', 'user.name', n)
      sh(dir, 'git', 'config', 'user.email', `${n}@example.com`)
      sh(dir, 'git', 'config', 'commit.gpgsign', 'false')
      sh(dir, 'git', 'remote', 'rename', 'origin', 'team')
      return dir
    })

    for (const dir of clones) assert.equal(ax(dir, ['init']).code, 0, 'init 실패')

    const a = ax(clones[0], ['claim', 'shared.txt', '--intent', 'alice 작업'], 'alice')
    assert.equal(a.code, 0, `alice claim 실패: ${a.err}`)

    const b = ax(clones[1], ['claim', 'shared.txt', '--intent', 'bob 작업'], 'bob')
    // 고치기 전에는 여기가 0 이었다. 둘 다 성공하고 아무도 몰랐다.
    assert.equal(b.code, 2, `bob 이 겹침을 못 봤다 — 관문 1 이 안 돈다: ${b.out}\n${b.err}`)
    // 거부는 die() 로 나가므로 stderr 다. 어느 쪽이든 사람이 읽으면 되므로 합쳐서 본다.
    const said = `${b.out}\n${b.err}`
    assert.match(said, /alice/, '거부 메시지에 점유자가 없다')
    assert.match(said, /alice 작업/, '거부 메시지에 상대의 의도가 없다')
  })
})

/**
 * `doctor` — 스스로 확인하는 명령.
 *
 * 🔴 한 번도 실패하지 않는 검사기는 검사기가 아니다. 그래서 여기서 고정하는 것은
 *    "통과한다" 가 아니라 **못 갖춘 것을 실제로 잡아내는가** 다.
 *
 *    그리고 잡아낸 뒤 **고치는 방법을 함께 주는지**까지 본다. 진단만 하고 방법을
 *    안 알려주면 새로 온 사람이 결국 남에게 물어봐야 하고, 그러면 이 명령이
 *    있을 이유가 없다.
 */
describe('doctor — 못 갖춘 것을 잡아낸다', () => {
  it('🔴 장부가 없으면 실패로 낸다 (종료 코드 1)', () => {
    const repo = newRepo('doc-noledger')
    const r = ax(repo, ['doctor'])
    assert.equal(r.code, 1, '장부가 없는데 통과로 냈다')
    assert.match(`${r.out}${r.err}`, /장부/)
  })

  it('🔴 실패 줄에 고치는 방법이 함께 있다', () => {
    const repo = newRepo('doc-howto')
    const said = (() => { const r = ax(repo, ['doctor']); return `${r.out}\n${r.err}` })()
    // 진단만 하고 끝나면 새로 온 사람이 결국 남에게 물어봐야 한다.
    assert.match(said, /axmap init|setup/, '장부가 없다고만 하고 방법을 안 알려준다')
  })

  it('원격이 없는 것은 경고지 오류가 아니다 — 혼자 쓰는 사람이 실제로 있다', () => {
    const repo = newRepo('doc-solo')
    assert.equal(ax(repo, ['init']).code, 0)
    ax(repo, ['hook', 'install'])
    const r = ax(repo, ['doctor'])
    const said = `${r.out}\n${r.err}`
    assert.match(said, /~~/, '원격이 없는데 경고 표시가 없다')
    assert.equal(r.code, 0, '혼자 쓰는 것을 오류로 막으면 안 된다')
  })

  it('--json 은 기계가 읽을 수 있는 형태로 낸다', () => {
    const repo = newRepo('doc-json')
    ax(repo, ['init'])
    const r = ax(repo, ['doctor', '--json'])
    const parsed = JSON.parse(r.out)
    assert.equal(typeof parsed.ok, 'boolean')
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length > 0)
  })

  it('🔴 훅이 사라진 경로를 가리키면 잡아낸다 — 폴더 이름이 바뀌면 실제로 일어난다', () => {
    const repo = newRepo('doc-hook')
    ax(repo, ['init'])
    ax(repo, ['hook', 'install'])
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    // 훅은 절대 경로를 담는다. 폴더가 옮겨지면 없는 곳을 가리키고, git 은 훅이
    // 실패했다는 이유로 모든 커밋을 막는다 — 원인을 알기 매우 어려운 상태다.
    fs.writeFileSync(hook, fs.readFileSync(hook, 'utf8').replace(/"[^"]+axmap\.mjs"/, '"/nowhere/axmap.mjs"'))
    const r = ax(repo, ['doctor'])
    assert.equal(r.code, 1, '훅이 사라진 곳을 가리키는데 통과로 냈다')
    assert.match(`${r.out}${r.err}`, /가리키는 파일이 없습니다/)
  })
})
