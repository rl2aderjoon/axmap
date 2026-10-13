/**
 * 공변경 오버레이 테스트.
 *
 * 왜 있는가. 신입 온보딩 관찰에서 나온 지적이다 —
 * "새 origin 을 추가하려면 `overlayEdges` 를 고쳐야 하는데 테스트가 0개다."
 * 화면 전체가 이 함수의 판정 위에 서 있는데 안전망이 없었다.
 *
 * git 을 부르는 부분(`coChange`, `aliasImportEdges`)은 여기서 다루지 않는다.
 * 순수 판정인 `overlayEdges` 만 본다 — 부수효과와 판정을 섞지 않는다는
 * 이 저장소의 규칙을 테스트에서도 지킨다.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { overlayEdges } from '../app/lib/cochange.mjs'

const co = (a, b, support = 5, lift = 4) => ({ source: a, target: b, support, lift, confA: 0.5, confB: 0.5 })
const st = (a, b) => ({ source: a, target: b, kind: 'import', hub: false, directed: true })
const freqOf = (o) => new Map(Object.entries(o))
const originOf = (edges, a, b) =>
  edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a))?.origin

test('정적 O + 공변경 O → both', () => {
  const { edges, quadrant } = overlayEdges([st('a', 'b')], [co('a', 'b')], freqOf({ a: 10, b: 10 }))
  assert.equal(originOf(edges, 'a', 'b'), 'both')
  assert.equal(quadrant.both, 1)
})

test('정적 X + 공변경 O → cochange (숨은 결합)', () => {
  const { edges, quadrant } = overlayEdges([], [co('a', 'b')], freqOf({ a: 10, b: 10 }))
  assert.equal(originOf(edges, 'a', 'b'), 'cochange')
  assert.equal(quadrant.cochange, 1)
})

test('정적 O + 공변경 X + 양쪽 히스토리 충분 → static-stable (안정된 경계)', () => {
  const { edges, quadrant } = overlayEdges([st('a', 'b')], [], freqOf({ a: 10, b: 10 }))
  assert.equal(originOf(edges, 'a', 'b'), 'static-stable')
  assert.equal(quadrant.stable, 1)
})

test('🔴 히스토리가 부족하면 "안정된 경계"라고 부르지 않는다 — 모른다를 아니다로 바꾸지 않는다', () => {
  // b 는 한 번만 바뀌었다. "같이 안 바뀌었다"고 말할 근거가 없다.
  const { edges, quadrant } = overlayEdges([st('a', 'b')], [], freqOf({ a: 10, b: 1 }))
  assert.equal(originOf(edges, 'a', 'b'), 'static')
  assert.equal(quadrant.stable, 0)
  assert.equal(quadrant.unknown, 1)
})

test('한쪽만 히스토리가 있어도 판정 보류다', () => {
  const { edges } = overlayEdges([st('a', 'b')], [], freqOf({ a: 100 }))
  assert.equal(originOf(edges, 'a', 'b'), 'static')
})

test('엣지 방향이 반대여도 같은 쌍으로 본다 — 공변경은 무방향이다', () => {
  const { edges, quadrant } = overlayEdges([st('b', 'a')], [co('a', 'b')], freqOf({ a: 10, b: 10 }))
  assert.equal(quadrant.both, 1)
  assert.equal(quadrant.cochange, 0, '같은 쌍이 두 번 세지면 안 된다')
  assert.equal(edges.length, 1)
})

test('사분면 합계가 전체 엣지 수와 같다 — 어느 갈래에도 안 들어가는 엣지가 없어야 한다', () => {
  const staticEdges = [st('a', 'b'), st('c', 'd'), st('e', 'f')]
  const coEdges = [co('a', 'b'), co('x', 'y')]
  const freq = freqOf({ a: 10, b: 10, c: 10, d: 10, e: 10, f: 1, x: 10, y: 10 })
  const { edges, quadrant } = overlayEdges(staticEdges, coEdges, freq)
  const sum = quadrant.both + quadrant.cochange + quadrant.stable + quadrant.unknown
  assert.equal(sum, edges.length)
  assert.deepEqual(quadrant, { both: 1, cochange: 1, stable: 1, unknown: 1 })
})

test('공변경 엣지의 support·lift 가 both 엣지에 그대로 실린다', () => {
  const { edges } = overlayEdges([st('a', 'b')], [co('a', 'b', 7, 9.5)], freqOf({ a: 10, b: 10 }))
  const e = edges[0]
  assert.equal(e.support, 7)
  assert.equal(e.lift, 9.5)
  assert.equal(e.kind, 'import', '정적 엣지의 kind 는 보존된다 (D13 — kind 와 origin 은 다른 축)')
})

test('입력이 비어도 터지지 않는다', () => {
  const { edges, quadrant } = overlayEdges([], [], new Map())
  assert.deepEqual(edges, [])
  assert.deepEqual(quadrant, { both: 0, cochange: 0, stable: 0, unknown: 0 })
})

test('minSupport 를 올리면 "안정된 경계" 판정에 더 많은 히스토리를 요구한다', () => {
  const args = [[st('a', 'b')], [], freqOf({ a: 4, b: 4 })]
  assert.equal(originOf(overlayEdges(...args, 3).edges, 'a', 'b'), 'static-stable')
  assert.equal(originOf(overlayEdges(...args, 5).edges, 'a', 'b'), 'static',
    '문턱을 올리면 통과가 줄어야 한다 — 늘어나면 fail-open 이다')
})
