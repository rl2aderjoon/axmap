/**
 * 링크된 worktree 에서 장부를 찾는다.
 *
 * **링크된 worktree** — `git worktree add` 로 만든, 같은 저장소의 다른 브랜치를
 * 옆 폴더로 펼쳐 둔 것. HEAD·인덱스는 폴더마다 따로지만 오브젝트·refs·**훅**은
 * 저장소에 하나뿐이다(= 공통 디렉터리).
 *
 * 🔴 2026-08-28 실측: 그 안에서 `git commit` 을 하면 공통 훅이 그대로 돌고,
 *    `pre-commit` 이 `장부가 없습니다` 로 죽었다 (종료 코드 1). `repoRoot()` 는
 *    그 worktree 를 가리키는데 `.axmap/ledger` 는 메인 체크아웃에만 있기 때문이다.
 *    **선점과 아무 상관 없는 커밋까지 전부 막혔다.**
 *
 *    사람이 쓴 우회는 그 worktree 안에 장부 worktree 를 하나 더 만드는 것이었다.
 *    돌아가긴 하지만 장부가 worktree 수만큼 늘고, 하나가 뒤처지면 같은 저장소에
 *    진실이 둘이 된다. 락 시스템에서 진실이 둘이면 락이 아니다.
 *
 * 🔴 이 검사에서 **가장 중요한 것은 마지막 두 개**다. "찾는 자리를 넓혔다" 는
 *    고침은 자칫 "못 찾아도 통과" 로 미끄러지기 쉽다. 그러면 장부 없이 커밋이
 *    지나가고, 그것은 고치려던 것보다 나쁜 고장이다.
 *    **"못 찾음" 과 "없음" 은 다르다.**
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

/** 이 PC 의 세션 id 가 새어들어 검사 결과를 바꾸지 않게 환경을 고정한다. */
function ax(args, cwd, agent = 'wt-tester') {
  const env = { ...process.env }
  delete env.CLAUDE_CODE_SESSION_ID
  env.AXMAP_AGENT = agent
  env.AXMAP_SESSION = 'wt-session'
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', windowsHide: true })
}

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true })

/** 커밋 하나짜리 저장소. `init` 여부는 부르는 쪽이 정한다. */
function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.name', 'wt-tester')
  git(dir, 'config', 'user.email', 'x@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  return dir
}

/** 반드시 `git worktree remove` 로 치운다. 폴더만 지우면 저장소에 유령 등록이 남는다. */
function dropWorktree(main, wt) {
  try { git(main, 'worktree', 'remove', '--force', wt) } catch { /* 이미 없으면 그만 */ }
  try { fs.rmSync(wt, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
  try { git(main, 'worktree', 'prune') } catch { /* 그만 */ }
}

let repo = null
let wt = null

describe('링크된 worktree', () => {
  before(() => {
    repo = makeRepo('axmap-wt-')
    const r = ax(['init'], repo)
    assert.equal(r.status, 0, `init 실패: ${r.stderr || r.stdout}`)
    wt = path.join(path.dirname(repo), `${path.basename(repo)}-linked`)
    const w = git(repo, 'worktree', 'add', '-q', wt, '-b', 'side')
    assert.equal(w.status, 0, `worktree add 실패: ${w.stderr}`)
  })

  after(() => {
    if (repo && wt) dropWorktree(repo, wt)
    // 🔴 장부 worktree 는 등록을 지우고 나서 저장소째로 버린다.
    try { git(repo, 'worktree', 'remove', '--force', path.join(repo, '.axmap', 'ledger')) } catch { /* 그만 */ }
    try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* 그만 */ }
  })

  it('전제 - 링크된 worktree 에는 .axmap 이 없다 (그래서 못 찾았던 것이다)', () => {
    assert.equal(fs.existsSync(path.join(wt, '.axmap')), false)
    assert.equal(fs.existsSync(path.join(repo, '.axmap', 'ledger', '.git')), true)
  })

  it('🔴 claim 이 된다 — 메인 체크아웃의 장부에 적힌다', () => {
    const r = ax(['claim', 'sub', '--task', 'T1', '--intent', '링크된 worktree'], wt)
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    // 파일명이 아니라 내용으로 찾는다 — 레코드는 (이름, 세션) 짝마다 하나라
    // 파일명에 세션이 섞이고, 그 규칙을 검사가 다시 구현하면 검사가 먼저 낡는다.
    const dir = path.join(repo, '.axmap', 'ledger', 'claims')
    const rec = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .find((c) => c.agent === 'wt-tester')
    assert.ok(rec, '메인 체크아웃의 장부에 레코드가 없다')
    assert.deepEqual(rec.paths, ['sub'])
  })

  it('🔴 장부를 하나 더 만들지 않는다 — 진실이 둘이 되면 락이 아니다', () => {
    assert.equal(fs.existsSync(path.join(wt, '.axmap')), false)
  })

  it('🔴 verify(= pre-commit 훅이 부르는 것)가 통과한다. 예전에는 여기서 종료 코드 1 이었다', () => {
    fs.appendFileSync(path.join(wt, 'sub', 'b.txt'), 'c\n')
    git(wt, 'add', 'sub/b.txt')
    const r = ax(['verify'], wt)
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
  })

  it('🔴 그러면서도 claim 안 한 파일은 그대로 막는다 (통과시키는 쪽으로 미끄러지지 않았다)', () => {
    fs.appendFileSync(path.join(wt, 'a.txt'), 'z\n')
    git(wt, 'add', 'a.txt')
    const r = ax(['verify'], wt)
    assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /a\.txt/)
    git(wt, 'reset', '-q', 'HEAD', '--', 'a.txt')
  })

  it('status 도 같은 장부를 본다', () => {
    const r = ax(['status', '--json'], wt)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).active.map((c) => c.agent), ['wt-tester'])
  })

  it('메인 체크아웃에서의 동작은 그대로다', () => {
    const r = ax(['status', '--json'], repo)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout).active.map((c) => c.agent), ['wt-tester'])
  })
})

describe('🔴 장부가 정말 없을 때는 "못 찾음" 으로 뭉개지 않는다', () => {
  let bare = null
  let bareWt = null

  before(() => {
    bare = makeRepo('axmap-noinit-')
    bareWt = path.join(path.dirname(bare), `${path.basename(bare)}-linked`)
    git(bare, 'worktree', 'add', '-q', bareWt, '-b', 'side')
  })

  after(() => {
    if (bare && bareWt) dropWorktree(bare, bareWt)
    try { fs.rmSync(bare, { recursive: true, force: true }) } catch { /* 그만 */ }
  })

  it('메인 체크아웃에서 거부한다', () => {
    const r = ax(['verify'], bare)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /장부가 없습니다/)
  })

  it('링크된 worktree 에서도 거부한다 — 여기서 통과시키면 장부 없이 커밋이 지나간다', () => {
    const r = ax(['verify'], bareWt)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /장부가 없습니다/)
    // 어디를 보고 없다고 하는지 밝힌다. 안 밝히면 여기에 장부를 또 만들게 된다.
    assert.match(r.stderr, /찾아본 곳/)
  })
})
