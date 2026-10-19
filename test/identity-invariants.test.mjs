import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sessionIdentityViolations } from '../src/invariants.mjs'

describe('I7 검사기', () => {
  it('정상적으로 할당된 세션들은 통과한다', () => {
    const ok = [
      { id: 'A', agent: 'tester-s1', pid: 1 },
      { id: 'B', agent: 'tester-s2', pid: 1 },
    ]
    assert.deepEqual(sessionIdentityViolations(ok), [])
  })

  it('🔴 같은 이름을 쓰는 두 세션을 잡는다', () => {
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
