/**
 * 기능 인접 경고 테스트.
 *
 * 잡아야 하는 상황은 하나다 —
 * **경로는 안 겹치는데 같은 기능인 두 사람.**
 * 앞(컨트롤러)에서부터 오는 사람과 뒤(리포지토리)에서부터 오는 사람.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { featureAdjacency, formatAdjacency } from '../app/lib/adjacent.mjs'

const PATHS = [
  'src/controllers/album.controller.ts',
  'src/services/album.service.ts',
  'src/repositories/album.repository.ts',
  'src/controllers/user.controller.ts',
  'src/repositories/user.repository.ts',
]
const claim = (agent, paths, extra = {}) => ({ agent, paths, task: `task-${agent}`, intent: `${agent} 작업`, ...extra })
const co = (a, b, support = 6, lift = 8) => ({ source: a, target: b, support, lift })

test('앞에서 오는 사람과 뒤에서 오는 사람 — 경로는 안 겹치는데 잡아낸다', () => {
  const claims = [
    claim('a', ['src/controllers/album.controller.ts']),
    claim('b', ['src/repositories/album.repository.ts']),
  ]
  const edges = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts')]
  const { pairs } = featureAdjacency(claims, edges, PATHS)

  assert.equal(pairs.length, 1)
  assert.deepEqual(pairs[0].agents.sort(), ['a', 'b'])
  assert.equal(pairs[0].crossings, 1)
  assert.equal(pairs[0].topLift, 8)
})

test('디렉터리 claim 도 그 아래 파일까지 덮는다', () => {
  const claims = [
    claim('a', ['src/controllers']),   // 디렉터리
    claim('b', ['src/repositories']),
  ]
  const edges = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts')]
  const { pairs } = featureAdjacency(claims, edges, PATHS)
  assert.equal(pairs.length, 1)
})

test('🔴 무관한 두 영역은 경고하지 않는다 — 아무 때나 울리면 아무도 안 읽는다', () => {
  const claims = [
    claim('a', ['src/controllers/album.controller.ts']),
    claim('b', ['src/repositories/user.repository.ts']),
  ]
  // album 과 user 사이에는 공변경이 없다
  const edges = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts')]
  const { pairs } = featureAdjacency(claims, edges, PATHS)
  assert.equal(pairs.length, 0)
})

test('약한 공변경은 경고하지 않는다 (lift·support 문턱)', () => {
  const claims = [
    claim('a', ['src/controllers/album.controller.ts']),
    claim('b', ['src/repositories/album.repository.ts']),
  ]
  const weak = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts', 2, 1.5)]
  assert.equal(featureAdjacency(claims, weak, PATHS).pairs.length, 0)
})

test('문턱을 낮추면 경고가 늘어난다 — 방향이 반대면 필터가 거꾸로 걸린 것이다', () => {
  const claims = [
    claim('a', ['src/controllers/album.controller.ts']),
    claim('b', ['src/repositories/album.repository.ts']),
  ]
  const edges = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts', 3, 2)]
  assert.equal(featureAdjacency(claims, edges, PATHS, { minLift: 5, minSupport: 4 }).pairs.length, 0)
  assert.equal(featureAdjacency(claims, edges, PATHS, { minLift: 1, minSupport: 1 }).pairs.length, 1)
})

test('claim 이 하나뿐이면 비교할 상대가 없다', () => {
  const { pairs } = featureAdjacency([claim('a', ['src/controllers'])], [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts')], PATHS)
  assert.deepEqual(pairs, [])
})

test('같은 claim 안의 공변경은 경고가 아니다 — 자기 영역 안이다', () => {
  const claims = [
    claim('a', ['src/controllers/album.controller.ts', 'src/repositories/album.repository.ts']),
    claim('b', ['src/controllers/user.controller.ts']),
  ]
  const edges = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts')]
  assert.equal(featureAdjacency(claims, edges, PATHS).pairs.length, 0)
})

test('손상된 장부 레코드는 건너뛴다 — 뷰어는 읽기 전용이라 중단하지 않는다', () => {
  const claims = [
    { agent: '(손상: x.json)', paths: [], broken: true },
    claim('a', ['src/controllers/album.controller.ts']),
    claim('b', ['src/repositories/album.repository.ts']),
  ]
  const edges = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts')]
  const { pairs, checked } = featureAdjacency(claims, edges, PATHS)
  assert.equal(checked, 2)
  assert.equal(pairs.length, 1)
})

test('세 명이 얽히면 쌍마다 따로 보고한다', () => {
  const claims = [
    claim('a', ['src/controllers/album.controller.ts']),
    claim('b', ['src/repositories/album.repository.ts']),
    claim('c', ['src/services/album.service.ts']),
  ]
  const edges = [
    co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts'),
    co('src/controllers/album.controller.ts', 'src/services/album.service.ts'),
    co('src/services/album.service.ts', 'src/repositories/album.repository.ts'),
  ]
  const { pairs } = featureAdjacency(claims, edges, PATHS)
  assert.equal(pairs.length, 3, '3명이면 쌍이 3개다')
})

test('경고문에 누가·무엇을·근거가 전부 들어간다 — 거부 메시지와 같은 재료여야 판단할 수 있다', () => {
  const claims = [
    claim('agent-a', ['src/controllers/album.controller.ts'], { intent: '응답 형태 변경' }),
    claim('agent-b', ['src/repositories/album.repository.ts'], { intent: '스키마 정리' }),
  ]
  const edges = [co('src/controllers/album.controller.ts', 'src/repositories/album.repository.ts')]
  const { pairs } = featureAdjacency(claims, edges, PATHS)
  const text = formatAdjacency(pairs[0])

  for (const must of ['agent-a', 'agent-b', '응답 형태 변경', '스키마 정리', 'lift', '거부가 아닙니다']) {
    assert.ok(text.includes(must), `경고문에 "${must}" 가 있어야 한다`)
  }
})
