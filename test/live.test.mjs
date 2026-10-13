/**
 * 감시 화면의 요약 숫자.
 *
 * 🔴 이 파일이 있기 전까지 `summarize` 에는 테스트가 없었고, **"선점" 은 장부에
 * 세 명이 잡고 있어도 항상 0 이었다.** 화면이 서버가 보내지 않는 `claimed`
 * 필드를 읽고 `?? 0` 으로 떨어진 탓이다.
 *
 * 이 버그가 오래 살아남은 이유가 중요하다 — **장부가 없는 저장소에서만 화면을
 * 봤기 때문이다.** 장부가 없으면 0 이 맞는 답처럼 보인다. 밤샘 온보딩 루프에서
 * 처음으로 진짜 claim 을 넣고 나서야 드러났다.
 *
 * 검증하지 않은 축은 조용히 썩는다. 그래서 세 숫자를 여기서 고정한다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { overlay, summarize } from '../app/lib/live.mjs'

const claim = (agent, ...paths) => ({ agent, task: `T-${agent}`, intent: '…', paths })
const mod = (path) => ({ path, code: 'M', where: 'worktree' })

describe('summarize — 범례의 세 색에는 세 숫자가 있다', () => {
  it('🔴 잡아만 둔 것을 센다 (이 값이 없어 화면이 늘 0 이었다)', () => {
    const claims = [claim('sora', 'a.py'), claim('minjun', 'b.py')]
    const ov = overlay(claims, [], ['a.py', 'b.py', 'c.py'])
    const s = summarize(claims, [], ov)
    assert.equal(s.declared, 2)
    assert.equal(s.working, 0)
    assert.equal(s.undeclared, 0)
    assert.equal(s.agents, 2)
  })

  it('잡고 실제로 고치면 선점이 아니라 작업 중이다', () => {
    const claims = [claim('sora', 'a.py'), claim('minjun', 'b.py')]
    const ov = overlay(claims, [mod('a.py')], ['a.py', 'b.py'])
    const s = summarize(claims, [mod('a.py')], ov)
    assert.equal(s.working, 1)
    assert.equal(s.declared, 1, 'b.py 만 남는다')
  })

  it('선점 없이 고친 것은 따로 센다', () => {
    const claims = [claim('sora', 'a.py')]
    const modified = [mod('a.py'), mod('z.py')]
    const ov = overlay(claims, modified, ['a.py', 'z.py'])
    const s = summarize(claims, modified, ov)
    assert.equal(s.working, 1)
    assert.equal(s.undeclared, 1)
    assert.equal(s.declared, 0)
  })

  it('🔴 세 숫자는 겹치지 않는다 — 한 파일이 두 칸에 들어가면 합이 거짓말한다', () => {
    const claims = [claim('sora', 'a.py'), claim('minjun', 'b.py')]
    const modified = [mod('a.py'), mod('z.py')]
    const ov = overlay(claims, modified, ['a.py', 'b.py', 'z.py'])
    const s = summarize(claims, modified, ov)
    assert.equal(s.declared + s.working + s.undeclared, ov.size)
  })

  it('디렉터리 claim 은 그 아래 파일까지 물든다 — 그래서 이것은 파일 수다', () => {
    // 화면 라벨이 "(파일 수)" 라고 적는 근거. claim 은 1건인데 파일은 여럿이다.
    const claims = [claim('ci-bot', 'lib/api')]
    const known = ['lib/api/one.py', 'lib/api/two.py', 'other.py']
    const s = summarize(claims, [], overlay(claims, [], known))
    assert.equal(s.agents, 1)
    assert.ok(s.declared >= 2, `파일까지 물들어야 한다 (지금 ${s.declared})`)
  })

  it('아무도 없으면 전부 0 이다 — 0 자체는 정당한 답이다', () => {
    const s = summarize([], [], overlay([], [], ['a.py']))
    assert.deepEqual(
      { declared: s.declared, working: s.working, undeclared: s.undeclared, agents: s.agents },
      { declared: 0, working: 0, undeclared: 0, agents: 0 },
    )
  })

  it('같은 입력이면 같은 답이다', () => {
    const claims = [claim('sora', 'a.py')]
    const modified = [mod('z.py')]
    const known = ['a.py', 'z.py']
    assert.deepEqual(
      summarize(claims, modified, overlay(claims, modified, known)),
      summarize(claims, modified, overlay(claims, modified, known)),
    )
  })
})

describe('🔴 장부를 못 읽었을 때 0 이라고 말하지 않는다', () => {
  it('summarize 가 숫자 대신 null 과 이유를 낸다', () => {
    // 벤치마크에서 잡혔다. `/api/watch` 가 ledgerAvailable:false 를 보내면서
    // 동시에 claims:[] 와 summary.agents:0 을 함께 보냈고, 텍스트만 보는 신입이
    // 그 0 을 읽고 "아무도 안 잡고 있어 부딪힐 대상 없음" 이라고 확신 있게
    // 틀린 답을 냈다. 같은 것을 그림으로 본 신입은 맞게 "못 함" 이라고 했다 —
    // 화면은 경고를 크게 그렸기 때문이다. **화면이 API 보다 정직했다.**
    const s = summarize([], [], new Map(), false)
    assert.equal(s.agents, null, '0 을 내면 "없다" 로 읽힌다')
    assert.equal(s.declaredPaths, null)
    assert.equal(s.working, null)
    assert.equal(s.unknown, true)
    assert.match(s.why, /모르는/)
  })

  it('git 에서 온 수정 파일 수는 장부와 무관하게 낸다', () => {
    // 장부를 못 읽어도 git 은 읽힌다. 아는 것까지 버리지는 않는다.
    const s = summarize([], ['a.mjs', 'b.mjs'], new Map(), false)
    assert.equal(s.modified, 2)
  })

  it('읽었으면 평소대로 센다', () => {
    const ov = new Map([['a', { state: 'declared' }], ['b', { state: 'working' }]])
    const s = summarize([{ agent: 'x', paths: ['a', 'b'] }], ['b'], ov, true)
    assert.equal(s.agents, 1)
    assert.equal(s.declaredPaths, 2)
    assert.equal(s.unknown, undefined)
  })
})
