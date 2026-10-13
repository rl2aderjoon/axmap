/**
 * 같은 이름, 다른 세션.
 *
 * 🔴 2026-08-28 에 **두 번** 재현된 사고를 고정한다.
 *
 *    한 PC 에서 Claude Code 세션 두 개가 같은 저장소를 만졌다. 둘 다
 *    `git config user.name` 이 `janghyojoon` 이라 장부는 둘을 한 사람으로 봤다.
 *      - 세션 A 가 `ci/axmap` 과 `governance/policy.json` 을 잡고 작업 중이었는데
 *      - 세션 B 의 claim 이 **그냥 통과**했고
 *      - 그 뒤 status 에 claim 이 1건만 남았다 — A 의 작업·의도가 사라졌다
 *      - B 가 반납하면 A 가 잡고 있던 경로까지 **함께 풀렸다**
 *
 * 처음 낸 처방은 **거부**였다 — 세션이 다르면 claim 도 release 도 막았다.
 * 증상은 멎었지만 뿌리는 그대로였다. 뿌리는 **레코드가 이름당 하나라 통째로
 * 갈아끼워진다는 것**이었고, 거부는 그 위에 덮은 뚜껑이라 같은 사람이 창 두 개로
 * **겹치지도 않는 다른 일**을 하는 것까지 통째로 막았다.
 *
 * 그래서 이 판(1.0.4)은 **자리를 나눈다.** 레코드의 임자가 이름 하나가 아니라
 * (이름, 세션) 짝이다. 덮을 자리가 없으니 덮어쓰기 사고도 없고, 반납도 자기 줄만
 * 푼다. 이 파일의 검사는 그래서 전부 **"A 의 기록이 그대로 있는가"** 로 끝난다 —
 * 통과했다는 것만 확인하고 레코드를 안 보면, 통과하면서 덮는 구현도 통과한다.
 *
 * 순수 로직(`src/protocol.mjs`)과 진짜 프로세스(`bin/axmap.mjs`) 두 층을 다 본다 —
 * `test/cli.test.mjs` 가 순수 로직 대신 프로세스를 돌리는 이유와 같다.
 * 판정이 맞아도 바깥에 전하는 종료 코드가 틀리면 부르는 쪽은 성공으로 읽는다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyClaim, applyRelease, applyRenew, isSameSubject } from '../src/protocol.mjs'

const NOW = Date.parse('2026-08-28T10:00:00.000Z')
const TTL = 30 * 60 * 1000

/** 세션 A 가 잡아 둔 것. 모든 검사가 "이것이 살아남았는가" 를 묻는다. */
function ledgerOfA() {
  return [
    {
      agent: 'janghyojoon',
      task: 'S15P21E201-40',
      intent: 'axMap 결함 고치기',
      actor: 'agent',
      session: 'sess-A',
      since: new Date(NOW - 60_000).toISOString(),
      ttlMs: TTL,
      paths: ['ci/axmap', 'governance/policy.json'],
    },
  ]
}

/** 장부에서 그 세션의 줄을 집는다. 이름만으로 집으면 이 파일이 검사할 것이 없어진다. */
const lineOf = (claims, session) => claims.find((c) => (c.session ?? null) === session) ?? null

// ---------------------------------------------------------------------------
// 층 1 - 순수 판정
// ---------------------------------------------------------------------------

describe('레코드의 임자는 (이름, 세션) 짝이다', () => {
  it('이름이 같아도 세션이 다르면 다른 임자다', () => {
    assert.equal(isSameSubject({ agent: 'a', session: 'sess-A' }, 'a', 'sess-A'), true)
    assert.equal(isSameSubject({ agent: 'a', session: 'sess-A' }, 'a', 'sess-B'), false)
  })

  it('이름이 다르면 세션이 같아도 남이다', () => {
    assert.equal(isSameSubject({ agent: 'a', session: 'sess-A' }, 'b', 'sess-A'), false)
  })

  it('세션을 모르는 실행들은 한 자리를 함께 쓴다', () => {
    // 실행마다 다른 값을 지어내면 자기가 잡은 것을 자기가 못 반납한다.
    assert.equal(isSameSubject({ agent: 'a', session: null }, 'a', null), true)
    assert.equal(isSameSubject({ agent: 'a' }, 'a'), true)
    assert.equal(isSameSubject({ agent: 'a', session: null }, 'a', 'sess-B'), false)
  })
})

describe('claim - 같은 이름 다른 세션', () => {
  it('🔴 막지 않는다. 줄을 새로 만든다 — 그리고 A 의 줄은 그대로다', () => {
    const claims = ledgerOfA()
    const before = JSON.stringify(claims)
    const res = applyClaim({
      claims,
      me: 'janghyojoon',
      requested: ['docs/SPEC.md'],
      now: NOW,
      ttlMs: TTL,
      task: 'OTHER-1',
      intent: '전혀 다른 일',
      session: 'sess-B',
    })
    assert.equal(res.ok, true)
    assert.equal(JSON.stringify(claims), before, '입력 장부가 변형됐다')
    assert.equal(res.claims.length, 2, '한 줄이면 하나가 다른 하나를 덮은 것이다')

    const a = lineOf(res.claims, 'sess-A')
    assert.deepEqual(a.paths, ['ci/axmap', 'governance/policy.json'], 'A 의 경로가 바뀌었다')
    assert.equal(a.task, 'S15P21E201-40', 'A 의 작업 표시가 덮였다')
    assert.equal(a.intent, 'axMap 결함 고치기', 'A 의 의도가 덮였다')

    const b = lineOf(res.claims, 'sess-B')
    assert.deepEqual(b.paths, ['docs/SPEC.md'], 'B 가 A 의 경로까지 물고 들어갔다')
    assert.equal(b.task, 'OTHER-1')
  })

  it('🔴 조용히 넘어가지는 않는다 — 같은 이름의 다른 줄을 알려준다', () => {
    // 이 사고의 피해는 "덮어썼다" 가 아니라 "덮어썼는데 아무도 몰랐다" 였다.
    const res = applyClaim({
      claims: ledgerOfA(), me: 'janghyojoon', requested: ['docs/SPEC.md'], now: NOW, ttlMs: TTL, session: 'sess-B',
    })
    assert.equal(res.otherSessions.length, 1)
    assert.equal(res.otherSessions[0].session, 'sess-A')
  })

  it('같은 세션이면 지금까지와 똑같이 합쳐진다 (정상 흐름을 깨지 않는다)', () => {
    const res = applyClaim({
      claims: ledgerOfA(),
      me: 'janghyojoon',
      requested: ['src/protocol.mjs'],
      now: NOW,
      ttlMs: TTL,
      session: 'sess-A',
    })
    assert.equal(res.ok, true)
    assert.equal(res.claims.length, 1, '같은 세션인데 줄이 둘로 갈라졌다')
    assert.deepEqual(res.record.paths, ['ci/axmap', 'governance/policy.json', 'src/protocol.mjs'])
    assert.equal(res.record.task, 'S15P21E201-40', '안 준 값은 앞의 것을 잇는다')
    assert.equal(res.record.session, 'sess-A')
    assert.deepEqual(res.otherSessions, [], '자기 자신을 남의 세션이라고 하면 안 된다')
  })

  it('자기가 잡은 경로를 자기가 다시 잡아도 된다', () => {
    const res = applyClaim({
      claims: ledgerOfA(),
      me: 'janghyojoon',
      requested: ['ci/axmap'],
      now: NOW,
      ttlMs: TTL,
      session: 'sess-A',
    })
    assert.equal(res.ok, true)
    assert.deepEqual(res.record.paths, ['ci/axmap', 'governance/policy.json'])
  })

  it('세션을 모르는 줄과 아는 줄은 서로 다른 자리다', () => {
    // 옛 레코드(세션 표식 없음) 위에 세션 있는 실행이 와도 덮지 않는다.
    const old = ledgerOfA().map((c) => ({ ...c, session: null }))
    const res = applyClaim({ claims: old, me: 'janghyojoon', requested: ['x'], now: NOW, ttlMs: TTL, session: 'sess-B' })
    assert.equal(res.ok, true)
    assert.equal(res.claims.length, 2)
    assert.deepEqual(lineOf(res.claims, null).paths, ['ci/axmap', 'governance/policy.json'], '옛 줄이 사라졌다')
    assert.deepEqual(lineOf(res.claims, 'sess-B').paths, ['x'])
  })

  it('세션을 모르는 실행끼리는 예전 그대로 한 줄에 쌓인다', () => {
    const old = ledgerOfA().map((c) => ({ ...c, session: null }))
    const res = applyClaim({ claims: old, me: 'janghyojoon', requested: ['x'], now: NOW, ttlMs: TTL })
    assert.equal(res.claims.length, 1)
    assert.equal(res.record.session, null)
    assert.deepEqual(res.record.paths, ['ci/axmap', 'governance/policy.json', 'x'])
  })

  it('만료된 내 줄의 경로는 되살리지 않는다', () => {
    const dead = ledgerOfA().map((c) => ({ ...c, since: new Date(NOW - TTL - 1000).toISOString() }))
    const res = applyClaim({
      claims: dead,
      me: 'janghyojoon',
      requested: ['docs/SPEC.md'],
      now: NOW,
      ttlMs: TTL,
      session: 'sess-A',
    })
    assert.equal(res.ok, true)
    assert.equal(res.hadExpired, true)
    assert.deepEqual(res.record.paths, ['docs/SPEC.md'])
  })

  it('남이 잡은 경로와 겹치면 여전히 막는다 — 관문 2 는 그대로다', () => {
    const claims = [...ledgerOfA(), { ...ledgerOfA()[0], agent: 'someone-else', session: 'sess-C', paths: ['src/x'] }]
    const res = applyClaim({
      claims,
      me: 'janghyojoon',
      requested: ['src/x'],
      now: NOW,
      ttlMs: TTL,
      session: 'sess-B',
    })
    assert.equal(res.ok, false)
    assert.equal(res.blocks[0].holder, 'someone-else')
  })
})

describe('release - 반납의 단위는 세션이다', () => {
  it('🔴 다른 세션이 반납해도 A 의 줄은 남는다 — 이 결함의 핵심 피해', () => {
    const claims = [
      ...ledgerOfA(),
      { ...ledgerOfA()[0], session: 'sess-B', task: 'T-B', intent: 'B 의 일', paths: ['docs/SPEC.md'] },
    ]
    const res = applyRelease({ claims, me: 'janghyojoon', drop: [], session: 'sess-B' })
    assert.equal(res.hadNothing, false)
    assert.equal(res.claims.length, 1, 'A 의 레코드가 사라졌다')
    assert.equal(res.claims[0].session, 'sess-A')
    assert.deepEqual(res.claims[0].paths, ['ci/axmap', 'governance/policy.json'])
    assert.deepEqual(res.removed.map((r) => r.session), ['sess-B'], '지울 줄이 B 의 것뿐이어야 한다')
  })

  it('이 세션이 잡은 것이 없으면 반납할 것도 없다 (남의 줄을 대신 풀지 않는다)', () => {
    const res = applyRelease({ claims: ledgerOfA(), me: 'janghyojoon', drop: [], session: 'sess-B' })
    assert.equal(res.hadNothing, true)
    assert.equal(res.claims.length, 1)
    // "이름이 없다" 와 "세션이 다르다" 는 처방이 다르다. 부르는 쪽이 가를 수 있어야 한다.
    assert.equal(res.otherSessions.length, 1)
    assert.equal(res.otherSessions[0].session, 'sess-A')
  })

  it('같은 세션이면 그대로 반납된다', () => {
    const res = applyRelease({ claims: ledgerOfA(), me: 'janghyojoon', drop: [], session: 'sess-A' })
    assert.deepEqual(res.claims, [])
  })

  it('경로를 짚으면 그 경로만 빠진다', () => {
    const res = applyRelease({ claims: ledgerOfA(), me: 'janghyojoon', drop: ['ci/axmap'], session: 'sess-A' })
    assert.equal(res.claims.length, 1)
    assert.deepEqual(res.claims[0].paths, ['governance/policy.json'])
    assert.deepEqual(res.removed, [])
  })

  it('잡고 있지 않은 경로는 unheld 로 돌려준다', () => {
    const res = applyRelease({ claims: ledgerOfA(), me: 'janghyojoon', drop: ['없는/경로'], session: 'sess-A' })
    assert.deepEqual(res.unheld, ['없는/경로'])
  })

  it('세션을 모르는 실행은 세션을 모르는 줄만 푼다', () => {
    const claims = [...ledgerOfA(), { ...ledgerOfA()[0], session: null, paths: ['docs/SPEC.md'] }]
    const res = applyRelease({ claims, me: 'janghyojoon', drop: [] })
    assert.equal(res.claims.length, 1)
    assert.equal(res.claims[0].session, 'sess-A')
  })

  it('🔴 --all-sessions 면 같은 이름의 줄을 전부 푼다 — 문이 없으면 사람은 시스템 밖으로 나간다', () => {
    const claims = [...ledgerOfA(), { ...ledgerOfA()[0], session: 'sess-B', paths: ['docs/SPEC.md'] }]
    const res = applyRelease({ claims, me: 'janghyojoon', drop: [], session: 'sess-B', allSessions: true })
    assert.deepEqual(res.claims, [])
    assert.equal(res.removed.length, 2)
  })

  it('--all-sessions 로 경로를 짚으면 그 경로만 여러 줄에서 빠진다', () => {
    const claims = [...ledgerOfA(), { ...ledgerOfA()[0], session: 'sess-B', paths: ['ci/axmap', 'docs/SPEC.md'] }]
    const res = applyRelease({
      claims, me: 'janghyojoon', drop: ['ci/axmap'], session: 'sess-B', allSessions: true,
    })
    assert.equal(res.claims.length, 2)
    assert.deepEqual(lineOf(res.claims, 'sess-A').paths, ['governance/policy.json'])
    assert.deepEqual(lineOf(res.claims, 'sess-B').paths, ['docs/SPEC.md'])
  })

  it('남의 이름은 --all-sessions 로도 안 풀린다', () => {
    const claims = [...ledgerOfA(), { ...ledgerOfA()[0], agent: 'someone-else', session: 'sess-C' }]
    const res = applyRelease({ claims, me: 'janghyojoon', drop: [], session: 'sess-A', allSessions: true })
    assert.equal(res.claims.length, 1)
    assert.equal(res.claims[0].agent, 'someone-else')
  })
})

describe('renew - 늘리는 것도 이 세션의 것뿐이다', () => {
  it('이 세션의 것은 늘어난다', () => {
    const res = applyRenew({ claims: ledgerOfA(), me: 'janghyojoon', now: NOW, ttlMs: TTL, session: 'sess-A' })
    assert.equal(res.ok, true)
    assert.equal(res.record.session, 'sess-A')
    assert.deepEqual(res.record.paths, ['ci/axmap', 'governance/policy.json'])
  })

  it('🔴 다른 세션의 것은 모르고 늘리지 않는다 — 대신 그런 줄이 있다고 말한다', () => {
    // 모르고 늘리면 그 경로는 아무도 안 쓰는데 계속 막혀 있게 된다.
    const res = applyRenew({ claims: ledgerOfA(), me: 'janghyojoon', now: NOW, ttlMs: TTL, session: 'sess-B' })
    assert.equal(res.ok, false)
    assert.equal(res.otherSessions.length, 1)
    assert.equal(res.otherSessions[0].session, 'sess-A')
  })
})

// ---------------------------------------------------------------------------
// 층 2 - 진짜 프로세스. 종료 코드와 장부 파일까지 본다
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(ROOT, 'bin', 'axmap.mjs')

let repo = null

/** 세션 id 를 **환경에서 완전히 걷어내고** 인자로만 준다. 안 그러면 이 검사가 이 PC 에 종속된다. */
function ax(args, { session = null } = {}) {
  const env = { ...process.env }
  delete env.AXMAP_AGENT
  delete env.AXMAP_SESSION
  delete env.CLAUDE_CODE_SESSION_ID
  env.AXMAP_AGENT = 'janghyojoon' // 두 세션이 같은 이름인 것이 이 사고의 전제다
  if (session) env.AXMAP_SESSION = session
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8', windowsHide: true })
}

const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true })

/**
 * 장부에 실제로 적힌 레코드들.
 *
 * 🔴 **파일명을 계산하지 않는다.** 파일명 규칙(세션마다 다른 이름)을 검사가 다시
 *    구현하면, 검사하는 대상이 제품이 아니라 검사기가 된다.
 */
const claimsOf = () => {
  const dir = path.join(repo, '.axmap', 'ledger', 'claims')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

describe('두 세션이 진짜로 부딪힐 때 (프로세스)', () => {
  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-sess-'))
    git('init', '-q')
    git('config', 'user.name', 'janghyojoon')
    git('config', 'user.email', 'x@example.com')
    git('config', 'commit.gpgsign', 'false')
    fs.mkdirSync(path.join(repo, 'ci'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'ci', 'a.txt'), 'a\n')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    const r = ax(['init'], { session: 'sess-A' })
    assert.equal(r.status, 0, `init 실패: ${r.stderr || r.stdout}`)
  })

  after(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
  })

  it('세션 A 가 잡는다', () => {
    const r = ax(['claim', 'ci', '--task', 'T-A', '--intent', 'A 의 일'], { session: 'sess-A' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(claimsOf()[0].session, 'sess-A', '장부에 세션이 안 적혔다')
  })

  it('🔴 세션 B 도 잡을 수 있다 — 겹치지 않는 일까지 막던 것을 고친다', () => {
    const r = ax(['claim', 'b.txt', '--task', 'T-B'], { session: 'sess-B' })
    assert.equal(r.status, 0, `막혔다:\n${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /다른 세션/, '같은 이름이 두 줄이 된 것을 안 알리면 아무도 모른다')
  })

  it('🔴 그런데 겹치는 경로는 막는다 — 같은 이름의 다른 창이어도', () => {
    // 반납 단위를 세션으로 가르면서 줄이 여럿이 됐다. 겹침 검사도 같이 가지
    // 않으면 **한 사람의 두 창이 같은 파일을 함께 잡는다** — 겹침을 막으려고
    // 만든 검사가 정작 가장 흔한 겹침을 통과시키는 상태가 된다.
    // 자기 창 둘을 헷갈리는 일은 남의 작업과 부딪히는 일보다 잦다.
    const r = ax(['claim', 'ci/a.txt'], { session: 'sess-B' })
    assert.equal(r.status, 2, `막히지 않았다:\n${r.stdout}\n${r.stderr}`)
    assert.equal(claimsOf().length, 2, '막는 김에 줄이 늘거나 줄었다')
  })

  it('🔴 A 의 레코드가 그대로 있다 — 이 결함의 핵심 피해', () => {
    const all = claimsOf()
    assert.equal(all.length, 2, '한 줄이면 하나가 다른 하나를 덮은 것이다')
    const a = all.find((c) => c.session === 'sess-A')
    assert.equal(a.task, 'T-A')
    assert.equal(a.intent, 'A 의 일')
    assert.deepEqual(a.paths, ['ci'])
    assert.ok(!a.paths.includes('b.txt'), 'B 의 경로가 A 의 레코드에 섞였다')
  })

  it('🔴 세션 B 의 release 는 B 의 것만 푼다 — A 의 것은 남는다', () => {
    const r = ax(['release'], { session: 'sess-B' })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    const all = claimsOf()
    assert.equal(all.length, 1, 'A 의 레코드가 사라졌다')
    assert.equal(all[0].session, 'sess-A')
    assert.deepEqual(all[0].paths, ['ci'])
  })

  it('두 번째 release 는 5 — 남의 줄을 대신 풀지 않고, 왜인지 말한다', () => {
    const r = ax(['release'], { session: 'sess-B' })
    assert.equal(r.status, 5, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stderr, /다른 세션이 적은 줄/, '이름 문제로 읽히면 엉뚱한 처방으로 간다')
    assert.match(r.stderr, /--all-sessions/, '빠져나갈 길을 안 알려주면 사람은 도구 밖에서 빠져나간다')
    assert.equal(claimsOf().length, 1, 'A 의 레코드가 사라졌다')
  })

  it('세션 A 는 자기 것을 계속 늘릴 수 있다', () => {
    const r = ax(['claim', 'b.txt'], { session: 'sess-A' })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(claimsOf()[0].paths, ['b.txt', 'ci'])
  })

  it('세션 A 는 자기 것을 갱신할 수 있다', () => {
    const r = ax(['renew', '--ttl', '10m'], { session: 'sess-A' })
    assert.equal(r.status, 0, r.stderr)
  })

  it('세션 B 의 renew 는 A 의 것을 늘리지 않는다', () => {
    const r = ax(['renew', '--ttl', '10m'], { session: 'sess-B' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /다른 세션/)
  })

  it('🔴 --takeover 가 뒤 낱말을 삼키면 거부한다 — 경로가 조용히 사라지는 자리다', () => {
    // `--takeover ci` 는 parseArgs 가 'ci' 를 값으로 먹어 경로 목록에서 없앤다.
    // 이 깃발은 물러났지만 **모르는 척 흘려보내면 안 된다.** 흘려보내면 그 사고가 돌아온다.
    const r = ax(['claim', '--takeover', 'ci'], { session: 'sess-B' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /삼켰습니다/)
  })

  it('세션을 안 주면 그 실행들끼리의 자리를 쓴다 (옛 셸이 계속 돈다)', () => {
    // 🔴 경로는 A 가 잡은 것과 겹치지 않는 곳이어야 한다. 겹치면 이제 막히는데,
    //    그건 이 테스트가 보려는 것(세션 없는 실행도 자기 줄을 가진다)이 아니다.
    const r = ax(['claim', 'docs/x.txt'])
    assert.equal(r.status, 0, r.stderr)
    const noSession = claimsOf().find((c) => !c.session)
    assert.ok(noSession, '세션 없는 줄이 안 생겼다')
    assert.deepEqual(noSession.paths, ['docs/x.txt'])
    assert.ok(claimsOf().some((c) => c.session === 'sess-A'), 'A 의 줄을 덮었다')
  })

  it('🔴 --all-sessions 는 같은 이름의 줄을 전부 푼다', () => {
    const r = ax(['release', '--all-sessions'], { session: 'sess-B' })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.deepEqual(claimsOf(), [], '남은 줄이 있다')
  })
})
