import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registrationPoints, inScope, say, MIN_COMMITS } from '../app/lib/newfile.mjs'

/** discovery/ 에 새 소스를 추가하는 커밋 하나를 흉내낸다. */
const add = (n, extra = []) => ({
  sha: `c${n}`,
  added: [`discovery/src${n}.py`],
  touched: [`discovery/src${n}.py`, 'lib/core.py', ...extra],
})

describe('registrationPoints — 새로 만들 때 어디를 고치나', () => {
  it('늘 함께 바뀐 파일을 등록 지점으로 낸다', () => {
    const r = registrationPoints([add(1), add(2), add(3), add(4), add(5)])
    assert.equal(r.answered, true)
    assert.equal(r.n, 5)
    assert.equal(r.points[0].path, 'lib/core.py')
    assert.equal(r.points[0].support, 5)
    assert.equal(r.points[0].share, 1)
  })

  it('🔴 새로 만든 파일 자신은 답에 넣지 않는다', () => {
    const r = registrationPoints([add(1), add(2), add(3), add(4), add(5)])
    // "새 파일을 만들려면 새 파일을 만드세요" 가 1위로 나오면 안 된다
    assert.ok(!r.points.some((p) => p.path.startsWith('discovery/src')))
  })

  it('🔴 표본이 모자라면 답하지 않는다', () => {
    const r = registrationPoints([add(1), add(2)])
    assert.equal(r.answered, false)
    assert.equal(r.points.length, 0)
    assert.match(r.why, /2건뿐/)
    assert.match(r.why, new RegExp(String(MIN_COMMITS)))
  })

  it('추가된 적이 없으면 그렇다고 말한다', () => {
    const r = registrationPoints([])
    assert.equal(r.answered, false)
    assert.match(r.why, /새로 추가된 적이 없/)
  })

  it('🔴 드물게 나오는 것은 등록 지점이라고 부르지 않는다', () => {
    // core.py 는 5/5, 우연히 한 번 낀 파일은 1/5 = 20% < 30%
    const cs = [add(1, ['docs/CHANGELOG.md']), add(2), add(3), add(4), add(5)]
    const r = registrationPoints(cs)
    assert.ok(r.points.some((p) => p.path === 'lib/core.py'))
    assert.ok(!r.points.some((p) => p.path === 'docs/CHANGELOG.md'))
    // 봤지만 버렸다는 사실은 남긴다
    assert.ok(r.considered > r.points.length)
  })

  it('여러 등록 지점을 빈도 순으로 낸다', () => {
    const cs = [
      add(1, ['__main__.py', 'discovery/constants.py']),
      add(2, ['__main__.py', 'discovery/constants.py']),
      add(3, ['__main__.py']),
      add(4, ['__main__.py']),
      add(5, []),
    ]
    const r = registrationPoints(cs)
    assert.equal(r.points[0].path, 'lib/core.py')       // 5
    assert.equal(r.points[1].path, '__main__.py')        // 4
    assert.equal(r.points[2].path, 'discovery/constants.py') // 2 = 40%
  })

  it('같은 커밋에 같은 파일이 두 번 있어도 한 번만 센다', () => {
    const dup = { sha: 'x', added: ['a.py'], touched: ['a.py', 'core.py', 'core.py'] }
    const r = registrationPoints([dup, dup, dup, dup, dup])
    assert.equal(r.points[0].support, 5)
  })

  it('아무것도 문턱을 못 넘으면 답하지 않되 이유를 말한다', () => {
    // 커밋마다 전부 다른 파일을 건드린다 — 정해진 등록 지점이 없는 구조
    const cs = [1, 2, 3, 4, 5, 6].map((n) => ({
      sha: `c${n}`, added: [`d/s${n}.py`], touched: [`d/s${n}.py`, `misc/x${n}.py`],
    }))
    const r = registrationPoints(cs)
    assert.equal(r.answered, false)
    assert.match(r.why, /등록 지점이 없는 구조/)
  })

  it('같은 입력이면 같은 답이다 — 동률도 갈린다', () => {
    const cs = [add(1, ['b.py']), add(2, ['a.py']), add(3, ['a.py']), add(4, ['b.py']), add(5)]
    const a = registrationPoints(cs)
    const b = registrationPoints(cs)
    assert.deepEqual(a, b)
  })

  it('빈 커밋(추가 없음·건드린 것 없음)은 표본에서 뺀다', () => {
    const cs = [add(1), add(2), add(3), add(4), add(5),
      { sha: 'z', added: [], touched: ['lib/core.py'] }]
    assert.equal(registrationPoints(cs).n, 5)
  })
})

describe('inScope — 범위 경계', () => {
  it('디렉터리 아래만 잡는다', () => {
    assert.equal(inScope('discovery/a.py', 'discovery'), true)
    assert.equal(inScope('discovery/sub/a.py', 'discovery'), true)
  })

  it('🔴 이름이 겹치는 옆 디렉터리를 삼키지 않는다', () => {
    assert.equal(inScope('discovery_old/a.py', 'discovery'), false)
  })

  it('범위가 없으면 전부 안이다', () => {
    assert.equal(inScope('any/where.py', null), true)
  })
})

describe('say — 한 문장', () => {
  it('몇 건 중 몇 건인지 숫자를 문장에 넣는다', () => {
    const r = registrationPoints([add(1), add(2), add(3), add(4), add(5)])
    const s = say(r, 'discovery')
    assert.match(s, /5건/)
    assert.match(s, /100%/)
    assert.match(s, /lib\/core\.py/)
  })

  it('답하지 못하면 이유를 그대로 문장에 담는다', () => {
    const s = say(registrationPoints([add(1)]), 'discovery')
    assert.match(s, /말할 수 없습니다/)
    assert.match(s, /1건뿐/)
  })
})
