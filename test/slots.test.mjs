/**
 * 세션 슬롯 — 앱 안의 두 세션이 서로 다른 사람인가.
 *
 * 🔴 이 파일이 있기 전까지 **앱에서 띄운 세션은 몇 개든 장부에서 한 사람이었다.**
 *
 * `app/lib/session.mjs` 의 `spawn` 에 `env` 옵션이 없어서 자식이 서버의 환경을
 * 그대로 물려받았고, `checkOverlap` 은 자기 claim 을 겹침으로 보지 않으므로
 * 세션들이 서로를 하나도 못 막았다. 이 앱의 존재 이유가 "여러 AI 세션을 동시에
 * 굴리는 것" 인데 정작 그 자리에 구멍이 있었다.
 *
 * 여기서 고정하는 것은 셋이다.
 *   1. 한 앱 안의 두 세션은 서로 다른 이름을 받는다        (I7)
 *   2. 죽은 pid 의 슬롯은 회수된다                          앱 재시작
 *   3. 살아있는 남의 pid 의 슬롯은 뺏지 않는다              앱 두 개
 *
 * 2 가 중요한 이유: 슬롯이 회수되어야 다시 켠 앱의 첫 세션이 **다시 `s1`** 을
 * 받는다. 이름이 재시작을 넘어 안정적이어야 앱이 죽으며 두고 간 claim 을
 * 반납할 수 있다. 아니면 TTL 이 다 갈 때까지 남의 영역이 막힌다.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acquire,
  allocate,
  alive,
  baseName,
  readRegistry,
  registryPath,
  release,
  sessionAgentName,
} from '../app/lib/slots.mjs'
import { sessionIdentityViolations } from '../src/invariants.mjs'

let repo = null

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'axmap-slots-'))
  // 이름의 출처를 고정한다. whoAmI 는 AXMAP_AGENT 를 먼저 보므로 이것이 base 가 된다.
  process.env.AXMAP_AGENT = 'tester'
})

after(() => {
  try { fs.rmSync(repo, { recursive: true, force: true }) } catch { /* 지워지면 그만 */ }
})

/**
 * 확실히 죽은 pid 하나. 진짜 프로세스를 띄웠다가 끝난 것을 쓴다.
 * 숫자를 손으로 고르면 그 pid 가 마침 살아 있을 수 있고, 그러면 테스트가
 * 이유 없이 깜빡인다 — 회수 규칙이 아니라 운을 재게 된다.
 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
  assert.ok(r.pid > 0, '자식을 띄우지 못했습니다')
  return r.pid
}

describe('이름 짓기', () => {
  it('base 는 whoAmI 와 같은 순서로 정해진다 (화면과 CLI 가 갈리면 안 된다)', () => {
    assert.equal(baseName(repo), 'tester')
  })

  it('사람이 읽는 이름이다 — UUID 가 아니다', () => {
    assert.equal(sessionAgentName('janghyojoon', 2), 'janghyojoon-s2')
  })
})

describe('한 앱 안의 두 세션', () => {
  it('🔴 서로 다른 AXMAP_AGENT 를 받는다', () => {
    const a = acquire(repo, { sessionId: 'A', pid: process.pid })
    const b = acquire(repo, { sessionId: 'B', pid: process.pid })
    assert.equal(a.agent, 'tester-s1')
    assert.equal(b.agent, 'tester-s2')
    assert.notEqual(a.agent, b.agent)
    // 레지스트리에도 남아야 한다. 메모리에만 있으면 재시작을 못 넘는다.
    const slots = readRegistry(repo)
    assert.equal(Object.keys(slots).length, 2)
    assert.equal(slots['1'].sessionId, 'A')
    release(repo, a.slot, { pid: process.pid })
    release(repo, b.slot, { pid: process.pid })
  })

  it('반납한 번호는 가장 작은 빈 번호로 다시 나간다', () => {
    const a = acquire(repo, { sessionId: 'A', pid: process.pid })
    const b = acquire(repo, { sessionId: 'B', pid: process.pid })
    assert.equal(release(repo, a.slot, { pid: process.pid }), true)
    const c = acquire(repo, { sessionId: 'C', pid: process.pid })
    assert.equal(c.agent, 'tester-s1', '비어 있는 1번을 다시 준다')
    release(repo, b.slot, { pid: process.pid })
    release(repo, c.slot, { pid: process.pid })
  })
})

describe('앱을 껐다 켰다 — 죽은 pid 의 슬롯은 회수된다', () => {
  it('🔴 다시 켠 첫 세션이 s1 을 받는다 (그래야 두고 간 claim 을 반납할 수 있다)', () => {
    const gone = deadPid()
    // 옛 앱이 두고 간 흔적을 그대로 심는다.
    fs.mkdirSync(path.dirname(registryPath(repo)), { recursive: true })
    fs.writeFileSync(
      registryPath(repo),
      JSON.stringify({
        slots: {
          1: { pid: gone, sessionId: 'old-A', since: '2026-08-25T00:00:00.000Z', agent: 'tester-s1' },
          2: { pid: gone, sessionId: 'old-B', since: '2026-08-25T00:00:00.000Z', agent: 'tester-s2' },
        },
      }),
    )
    assert.equal(alive(gone), false, '고른 pid 가 정말 죽어 있어야 한다')

    const fresh = acquire(repo, { sessionId: 'new-A', pid: process.pid })
    assert.equal(fresh.agent, 'tester-s1')
    const slots = readRegistry(repo)
    assert.equal(Object.keys(slots).length, 1, '죽은 항목은 남지 않는다')
    release(repo, fresh.slot, { pid: process.pid })
  })
})

describe('앱을 두 개 띄웠다 — 살아있는 남의 슬롯은 뺏지 않는다', () => {
  it('🔴 다른 pid 가 쥔 1번을 건너뛰고 2번을 받는다', () => {
    // 이 테스트 프로세스 자신이 "다른 앱" 역할이다. 확실히 살아 있다.
    fs.writeFileSync(
      registryPath(repo),
      JSON.stringify({
        slots: {
          1: { pid: process.pid, sessionId: 'appA-1', since: '2026-08-25T00:00:00.000Z', agent: 'tester-s1' },
        },
      }),
    )
    const other = acquire(repo, { sessionId: 'appB-1', pid: deadPid() + 1 })
    assert.equal(other.agent, 'tester-s2')
    assert.equal(readRegistry(repo)['1'].sessionId, 'appA-1', '남의 것이 그대로 있다')
  })

  it('반납도 내 pid 의 것만 지운다', () => {
    // 위 테스트가 남긴 1번(=이 프로세스 소유)을 다른 pid 로 반납해 본다.
    assert.equal(release(repo, 1, { pid: deadPid() }), false)
    assert.ok(readRegistry(repo)['1'], '남의 슬롯은 지워지지 않는다')
  })
})

describe('레지스트리는 락이 아니라 편의 기록이다', () => {
  it('깨져 있으면 중단하지 않고 빈 것으로 시작한다', () => {
    fs.writeFileSync(registryPath(repo), '{ 이건 JSON 이 아니다')
    assert.deepEqual(readRegistry(repo), {})
    const s = acquire(repo, { sessionId: 'X', pid: process.pid })
    assert.equal(s.agent, 'tester-s1')
    release(repo, s.slot, { pid: process.pid })
  })

  it('없어도 그냥 시작한다', () => {
    fs.rmSync(registryPath(repo), { force: true })
    assert.deepEqual(readRegistry(repo), {})
  })
})

describe('allocate 는 순수하다 — 진짜 프로세스 없이 회수 규칙을 검증한다', () => {
  const t = Date.parse('2026-08-25T00:00:00.000Z')
  const agentFor = (n) => `x-s${n}`

  it('죽은 것만 버리고 산 것은 남긴다', () => {
    const isAlive = (pid) => pid === 100
    const { slot, slots } = allocate(
      {
        1: { pid: 100, sessionId: 'live' },
        2: { pid: 200, sessionId: 'dead' },
      },
      { sessionId: 'new', agentFor, pid: 300, now: t, isAlive },
    )
    assert.equal(slot, 2)
    assert.deepEqual(Object.keys(slots).sort(), ['1', '2'])
    assert.equal(slots['1'].sessionId, 'live')
    assert.equal(slots['2'].agent, 'x-s2')
  })

  it('번호가 아닌 키는 버린다 (손으로 고친 흔적)', () => {
    const { slot } = allocate(
      { abc: { pid: 1 }, 0: { pid: 1 } },
      { sessionId: 'n', agentFor, pid: 9, now: t, isAlive: () => true },
    )
    assert.equal(slot, 1)
  })
})

// ---------------------------------------------------------------------------
// I7 검사기 자체를 검증한다.
// "한 번도 실패하지 않는 검사기는 검사기가 아니다" (docs/INVARIANTS.md)
// ---------------------------------------------------------------------------

describe('I7 검사기', () => {
  it('정상적으로 할당된 세션들은 통과한다', () => {
    const ok = [
      { id: 'A', agent: 'tester-s1', pid: 1 },
      { id: 'B', agent: 'tester-s2', pid: 1 },
    ]
    assert.deepEqual(sessionIdentityViolations(ok), [])
  })

  it('🔴 같은 이름을 쓰는 두 세션을 잡는다 (고치기 전의 앱이 정확히 이 모양이었다)', () => {
    const bad = [
      { id: 'A', agent: 'janghyojoon', pid: 1 },
      { id: 'B', agent: 'janghyojoon', pid: 1 },
    ]
    const v = sessionIdentityViolations(bad)
    assert.equal(v.length, 1)
    assert.equal(v[0].invariant, 'I7')
    assert.deepEqual(v[0].sessions, ['A', 'B'])
  })

  it('🔴 이름이 없는 세션도 위반이다 — 자식이 서버의 이름을 물려받는다는 뜻이다', () => {
    const v = sessionIdentityViolations([{ id: 'A', agent: null, pid: 1 }])
    assert.equal(v.length, 1)
    assert.equal(v[0].invariant, 'I7')
  })

  it('같은 세션의 중복 기록은 위반이 아니다', () => {
    const v = sessionIdentityViolations([
      { id: 'A', agent: 'tester-s1', pid: 1 },
      { id: 'A', agent: 'tester-s1', pid: 1 },
    ])
    assert.deepEqual(v, [])
  })
})
