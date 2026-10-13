/**
 * 팀 뷰 (D14 3단계) 테스트.
 *
 * 이 테스트가 지키는 것은 셋이다.
 *
 *   ① **경로는 안 겹치는데 같은 기능**인 두 사람을 실제로 잡는가.
 *      앞(API)에서 오는 사람과 뒤(저장소)에서 오는 사람 — 프로토콜은
 *      통과시키는 것이 맞고, 이 층이 그것을 말해야 한다.
 *   ② 만료된 claim 을 **효력 있는 것처럼 세지 않는가.**
 *      CLAUDE.md 의 명시적 금지다.
 *   ③ 근거 없는 '낮음' 이 '높음' 으로 **새지 않는가.**
 *      등급이 헐거워지면 사용자는 전부를 같은 소음으로 취급하고,
 *      그때 진짜 경고도 같이 묻힌다.
 *
 * 시각은 전부 인자로 넣는다. TTL 동작을 30분 기다리지 않기 위해서다.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_TTL_MS, collisionRisk, expiryOf, formatRisk, josa, partitionClaims,
  staleClaims, summary, whoIsWhere,
} from '../app/lib/teamview.mjs'

// ---------------------------------------------------------------------------
// 붙박이 데이터
// ---------------------------------------------------------------------------

const T0 = Date.parse('2026-08-19T09:00:00.000Z')
const MIN = 60_000

const ALBUM = [
  'src/album/controller.ts',
  'src/album/service.ts',
  'src/album/repository.ts',
]
const USER = [
  'src/user/controller.ts',
  'src/user/repository.ts',
]
const TESTS = ['test/album.test.ts', 'test/user.test.ts']
const PATHS = [...ALBUM, ...USER, ...TESTS]

const FEATURES = [
  { id: 'src/album', name: '앨범', nameSource: 'docs', dir: 'src/album', paths: ALBUM },
  { id: 'src/user', name: 'user', nameSource: 'path', dir: 'src/user', paths: USER },
]

/** 장부 레코드 한 벌. since/ttlMs 모양(장부 원본)으로 만든다. */
const claim = (agent, paths, { at = T0, ttlMs = DEFAULT_TTL_MS, ...rest } = {}) => ({
  agent,
  paths,
  task: `task-${agent}`,
  intent: `${agent} 의 작업`,
  since: new Date(at).toISOString(),
  ttlMs,
  ...rest,
})

const co = (a, b, support = 6, lift = 8) => ({ source: a, target: b, support, lift })

/** 모든 파일이 히스토리를 가진 저장소. */
const FREQ = new Map(PATHS.map((p) => [p, 10]))

// ---------------------------------------------------------------------------
// ① whoIsWhere
// ---------------------------------------------------------------------------

describe('whoIsWhere — 경로를 기능으로 올린다', () => {
  it('🔴 부분 점유를 전체 점유처럼 보여주지 않는다', () => {
    const r = whoIsWhere([claim('민수', ['src/album/controller.ts'])], [], FEATURES, { now: T0 + MIN })
    const f = r.features.find((x) => x.id === 'src/album')

    assert.equal(f.state, 'partial')
    assert.equal(f.files, 3)
    assert.equal(f.claimedFiles, 1)
    assert.equal(f.freeFiles, 2)
    assert.equal(f.holders[0].whole, false)
    // 문장이 '중 1개' 를 말해야 한다. 안 말하면 남이 기능 전체가 막혔다고 읽는다.
    assert.match(f.sentence, /파일 3개 중 1개/)
    assert.match(f.sentence, /비어 있다/)
  })

  it('비어 있는 경로를 그대로 낸다 — 읽은 사람이 바로 claim 할 수 있어야 한다', () => {
    const r = whoIsWhere([claim('민수', ['src/album/controller.ts'])], [], FEATURES, { now: T0 + MIN })
    const f = r.features.find((x) => x.id === 'src/album')
    assert.deepEqual(f.free.sort(), ['src/album/repository.ts', 'src/album/service.ts'])
  })

  it('전체를 잡으면 whole 이고 문장이 전체라고 말한다', () => {
    const r = whoIsWhere([claim('민수', ['src/album'])], [], FEATURES, { now: T0 + MIN })
    const f = r.features.find((x) => x.id === 'src/album')
    assert.equal(f.state, 'whole')
    assert.equal(f.holders[0].whole, true)
    assert.equal(f.freeFiles, 0)
    assert.match(f.sentence, /전체를 잡고 있다/)
  })

  it('둘이 나눠 잡으면 contested — 이것이 중복 작업의 얼굴이다', () => {
    const r = whoIsWhere([
      claim('민수', ['src/album/controller.ts']),
      claim('영희', ['src/album/repository.ts']),
    ], [], FEATURES, { now: T0 + MIN })
    const f = r.features.find((x) => x.id === 'src/album')
    assert.equal(f.state, 'contested')
    assert.equal(f.holders.length, 2)
    assert.equal(r.stats.contested, 1)
    assert.match(f.sentence, /나눠 잡고 있다/)
  })

  it('🔴 만료된 claim 은 점유로 세지 않는다', () => {
    const claims = [claim('민수', ['src/album/controller.ts'], { ttlMs: 10 * MIN })]
    const before = whoIsWhere(claims, [], FEATURES, { now: T0 + 5 * MIN })
    const after = whoIsWhere(claims, [], FEATURES, { now: T0 + 11 * MIN })

    assert.equal(before.stats.agents, 1)
    assert.equal(before.features.length, 1)
    // 11분 뒤에는 효력이 없다. 점유가 아니라 '만료' 로 나와야 한다.
    assert.equal(after.stats.agents, 0)
    assert.equal(after.features.length, 0)
    assert.equal(after.expired.length, 1)
    assert.equal(after.expired[0].agent, '민수')
  })

  it('기능 지도 밖의 claim 은 숨기지 않고 outside 로 낸다', () => {
    const r = whoIsWhere([claim('민수', ['test/album.test.ts', 'src/album/controller.ts'])], [], FEATURES, { now: T0 })
    assert.equal(r.outside.length, 1)
    assert.deepEqual(r.outside[0].paths, ['test/album.test.ts'])
    assert.ok(r.gaps.some((g) => g.includes('기능 지도에 없는')))
  })

  it('새 파일은 지도 밖이되 어느 기능 옆인지를 말한다 — 파일 수는 부풀리지 않는다', () => {
    const r = whoIsWhere([claim('민수', ['src/album/brand-new.ts'])], [], FEATURES, { now: T0 })
    assert.equal(r.outside.length, 1)
    assert.deepEqual(r.outside[0].near, [{ path: 'src/album/brand-new.ts', feature: 'src/album', name: '앨범' }])
    // 🔴 개수를 건드리면 "7개 중 3개" 가 그래프와 어긋난다
    assert.equal(r.features.length, 0)
  })

  it('선언 없이 바뀐 파일을 드러낸다 (D3 — 선언 ⊂ 실제)', () => {
    const r = whoIsWhere(
      [claim('민수', ['src/album/controller.ts'])],
      [{ path: 'src/album/repository.ts', code: 'M' }],
      FEATURES, { now: T0 },
    )
    const f = r.features.find((x) => x.id === 'src/album')
    assert.deepEqual(f.undeclared, ['src/album/repository.ts'])
  })

  it('🔴 "나머지" 통을 기능이라고 부르지 않는다', () => {
    const bucket = {
      id: 'app', name: 'app', nameSource: 'path', dir: 'app',
      paths: ['app/server.mjs', 'src/protocol.mjs', 'corpus/serve.mjs'],
    }
    const r = whoIsWhere(
      [claim('a', ['app/server.mjs']), claim('b', ['corpus/serve.mjs'])],
      [], [bucket], { now: T0 },
    )
    const f = r.features[0]
    assert.equal(f.container, true)
    assert.match(f.sentence, /기능이 아니라/)
    // 요약에 '중복 작업 1건' 으로 새면 요약이 거짓말을 한다
    assert.equal(r.stats.contested, 0)
    assert.equal(r.stats.containers, 1)
    assert.ok(r.gaps.some((g) => g.includes('"나머지" 통인 노드')))
  })

  it('now 를 안 주면 만료를 판정하지 못했다고 말한다', () => {
    const r = whoIsWhere([claim('민수', ['src/album'])], [], FEATURES)
    assert.ok(r.gaps.some((g) => g.includes('만료 판정')))
  })

  it('기능 노드가 없으면 그렇다고 말한다 — 빈 결과를 결과로 내지 않는다', () => {
    const r = whoIsWhere([claim('민수', ['src/album'])], [], [], { now: T0 })
    assert.deepEqual(r.features, [])
    assert.ok(r.gaps.some((g) => g.includes('기능 노드가 없다')))
  })
})

// ---------------------------------------------------------------------------
// ② collisionRisk — 이 파일의 핵심
// ---------------------------------------------------------------------------

describe('collisionRisk — 경로는 안 겹치는데 같은 기능', () => {
  it('🔴 앞에서 오는 사람과 뒤에서 오는 사람을 "높음" 으로 잡는다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),   // API 쪽, 앞에서부터
      claim('b', ['src/album/repository.ts']),   // DB 쪽, 뒤에서부터
    ]
    // 공변경은 하나도 없다. 그래도 같은 기능이므로 잡아야 한다.
    const r = collisionRisk(claims, [], FREQ, T0 + MIN, { featureNodes: FEATURES, paths: PATHS })

    assert.equal(r.pairs.length, 1)
    assert.equal(r.pairs[0].level, 'high')
    assert.equal(r.pairs[0].label, '높음')
    assert.deepEqual(r.pairs[0].agents.slice().sort(), ['a', 'b'])
    // 근거에 기능 이름과 그 이름의 출처가 들어가야 한다
    assert.match(r.pairs[0].why, /앨범/)
    assert.match(r.pairs[0].why, /README/)
    assert.equal(r.pairs[0].reasons[0].kind, 'module')
  })

  it('featureNodes 없이도 modulesOf 로 같은 기능을 잡는다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/repository.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0 + MIN, { paths: PATHS })
    assert.equal(r.pairs.length, 1)
    assert.equal(r.pairs[0].level, 'high')
    // 이름을 문서에서 못 얻었으면 그 사실을 문장이 말해야 한다
    assert.match(r.pairs[0].why, /폴더 이름에서 나왔다/)
  })

  it('다른 기능이면 아무 등급도 안 난다 — 아무 때나 울리면 아무도 안 읽는다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/user/repository.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0 + MIN, { featureNodes: FEATURES, paths: PATHS })
    assert.deepEqual(r.pairs, [])
    assert.deepEqual(r.counts, { certain: 0, high: 0, medium: 0, low: 0 })
  })

  it('같은 경로는 "확실" — 프로토콜이 이미 막는 상태다', () => {
    const claims = [
      claim('a', ['src/album']),
      claim('b', ['src/album/repository.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0 + MIN, { featureNodes: FEATURES, paths: PATHS })
    assert.equal(r.pairs[0].level, 'certain')
    assert.match(r.pairs[0].why, /checkOverlap/)
  })

  it('모듈은 다른데 히스토리가 세면 "중간" + support·lift 근거', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/user/repository.ts']),
    ]
    const edges = [co('src/album/controller.ts', 'src/user/repository.ts', 9, 12)]
    const r = collisionRisk(claims, edges, FREQ, T0 + MIN, { featureNodes: FEATURES, paths: PATHS })

    assert.equal(r.pairs.length, 1)
    assert.equal(r.pairs[0].level, 'medium')
    assert.equal(r.pairs[0].reasons[0].topLift, 12)
    assert.match(r.pairs[0].why, /lift 12/)
    assert.match(r.pairs[0].why, /n≥4/)
  })

  it('약한 공변경은 "중간" 이 되지 않는다 (lift·support 문턱)', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/user/repository.ts']),
    ]
    const weak = [co('src/album/controller.ts', 'src/user/repository.ts', 2, 1.5)]
    const r = collisionRisk(claims, weak, FREQ, T0 + MIN, { featureNodes: FEATURES, paths: PATHS })
    assert.deepEqual(r.pairs, [])
  })

  it('🔴 근거 없는 "낮음" 이 "높음" 으로 새지 않는다', () => {
    // test/ 는 modulesOf 가 모듈로 치지 않는다 (라이브러리를 쓰는 쪽이다).
    // 같은 폴더에 나란히 있을 뿐 같은 기능이 아니다.
    const claims = [
      claim('a', ['test/album.test.ts']),
      claim('b', ['test/user.test.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0 + MIN, { featureNodes: FEATURES, paths: PATHS })

    assert.equal(r.pairs.length, 1)
    assert.equal(r.pairs[0].level, 'low', '같은 폴더일 뿐인데 높음이 되면 등급이 뜻을 잃는다')
    assert.equal(r.pairs[0].reasons[0].kind, 'folder')
    // 낮음이 '안전' 으로 읽히지 않게 문장이 직접 말해야 한다
    assert.match(r.pairs[0].why, /근거가 적다/)
  })

  it('저장소 뿌리는 폴더로 치지 않는다 — 최상위 파일 전부가 형제가 되면 경고가 상수가 된다', () => {
    const claims = [claim('a', ['README.md']), claim('b', ['CLAUDE.md'])]
    const r = collisionRisk(claims, [], new Map(), T0 + MIN, { paths: ['README.md', 'CLAUDE.md'] })
    assert.deepEqual(r.pairs, [])
  })

  it('근거가 둘이면 센 쪽이 등급이 되고 둘 다 남는다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/repository.ts']),
    ]
    const edges = [co('src/album/controller.ts', 'src/album/repository.ts', 9, 12)]
    const r = collisionRisk(claims, edges, FREQ, T0 + MIN, { featureNodes: FEATURES, paths: PATHS })

    assert.equal(r.pairs[0].level, 'high')
    assert.deepEqual(r.pairs[0].reasons.map((x) => x.kind), ['module', 'cochange'])
    // 하나의 점수로 뭉개지 않는다 — 둘은 서로 다른 것을 말한다
    assert.match(r.pairs[0].why, /같은 기능/)
    assert.match(r.pairs[0].why, /히스토리/)
  })

  it('🔴 만료된 claim 은 위험을 만들지 않고, 그 사실을 말한다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts'], { ttlMs: 10 * MIN }),
      claim('b', ['src/album/repository.ts']),
    ]
    const live = collisionRisk(claims, [], FREQ, T0 + 5 * MIN, { featureNodes: FEATURES, paths: PATHS })
    const dead = collisionRisk(claims, [], FREQ, T0 + 11 * MIN, { featureNodes: FEATURES, paths: PATHS })

    assert.equal(live.pairs.length, 1)
    assert.equal(dead.pairs.length, 0)
    assert.equal(dead.checked, 1)
    assert.ok(dead.gaps.some((g) => g.includes('만료된 claim 1건')))
  })

  it('🔴 히스토리가 없는 파일은 조용히 "안전" 이 되지 않는다', () => {
    // 방금 만든 파일 둘. freq 에도 그래프에도 없다.
    const claims = [
      claim('a', ['src/album/new-a.ts']),
      claim('b', ['src/album/new-b.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0 + MIN, { paths: PATHS })

    assert.equal(r.pairs.length, 1, '히스토리가 없어도 같은 모듈이면 잡아야 한다')
    assert.ok(r.pairs[0].historyBlind, '히스토리가 없다는 사실을 쌍마다 밝혀야 한다')
    assert.ok(r.gaps.some((g) => g.includes('공변경(중간 등급)이 구조적으로 뜰 수 없다')))
  })

  it('🔴 아직 커밋 안 된 새 파일도 같은 기능으로 잡는다 (실측으로 찾은 구멍)', () => {
    // 이 저장소 자신의 장부에서 나온 상황 그대로 —
    //   agent-pr    app/lib/live.mjs      (그래프에 있는 파일)
    //   agent-team  app/lib/teamview.mjs  (방금 만든 파일)
    // 새 파일은 git ls-files 에도 히스토리에도 없어서 어떤 모듈에도 안 들어간다.
    // 그대로 두면 '낮음(같은 폴더)' 이 되어, 가장 활발한 작업이 가장 약하게 보인다.
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/brand-new.ts']),    // FEATURES 에도 PATHS 에도 없다
    ]
    const r = collisionRisk(claims, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })

    assert.equal(r.pairs.length, 1)
    assert.equal(r.pairs[0].level, 'high')
    assert.deepEqual(r.pairs[0].reasons[0].inferredFrom, ['src/album/brand-new.ts'])
    // 그래프가 확인해 준 것이 아니라는 사실을 문장이 말해야 한다
    assert.match(r.pairs[0].why, /아직 그래프에 없는 새 파일이라 디렉터리로 맞췄다/)
  })

  it('새 파일 추론이 기능 경계를 넘지 않는다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/user/brand-new.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    assert.deepEqual(r.pairs, [], '다른 기능의 새 파일까지 끌어오면 경고가 아무 말도 안 하게 된다')
  })

  it('긴 디렉터리가 먼저 맞는다 — app/lib 이 app 보다 앞이다', () => {
    const nodes = [
      { id: 'app', name: 'app', nameSource: 'path', dir: 'app', paths: ['app/server.mjs'] },
      { id: 'app/lib', name: 'lib', nameSource: 'path', dir: 'app/lib', paths: ['app/lib/live.mjs'] },
    ]
    const claims = [claim('a', ['app/lib/live.mjs']), claim('b', ['app/lib/brand-new.mjs'])]
    const r = collisionRisk(claims, [], new Map(), T0, { featureNodes: nodes, paths: ['app/server.mjs', 'app/lib/live.mjs'] })
    assert.equal(r.pairs[0].reasons[0].module, 'app/lib')
  })

  it('🔴 "나머지" 통 안에서 만난 둘을 같은 기능이라고 하지 않는다 (실측)', () => {
    // 이 저장소를 자기 자신에게 돌렸을 때 나온 노드 그대로 —
    // modulesOf 가 뿌리를 app 으로 잡으면 뿌리 밑이 아닌 코드가 전부 `app` 으로
    // 떨어진다. 그 결과 app/server.mjs 와 corpus/serve.mjs 가 "같은 기능" 이 됐다.
    const bucket = {
      id: 'app', name: 'app', nameSource: 'path', dir: 'app',
      paths: ['app/server.mjs', 'src/protocol.mjs', 'corpus/serve.mjs', 'bin/axmap.mjs'],
    }
    const claims = [claim('a', ['app/server.mjs']), claim('b', ['corpus/serve.mjs'])]
    const r = collisionRisk(claims, [], new Map(), T0, {
      featureNodes: [bucket], paths: bucket.paths,
    })
    assert.deepEqual(r.pairs, [], '그릇은 기능 경계가 아니다')
  })

  it('자기 디렉터리 안에만 있는 노드는 그릇이 아니다', () => {
    const real = {
      id: 'app/lib', name: 'lib', nameSource: 'path', dir: 'app/lib',
      paths: ['app/lib/live.mjs', 'app/lib/flow.mjs'],
    }
    const claims = [claim('a', ['app/lib/live.mjs']), claim('b', ['app/lib/flow.mjs'])]
    const r = collisionRisk(claims, [], new Map(), T0, { featureNodes: [real], paths: real.paths })
    assert.equal(r.pairs[0].level, 'high')
  })

  it('공변경 엣지가 아예 없으면 중간 등급이 없다는 것을 말한다', () => {
    const r = collisionRisk([claim('a', ['src/album']), claim('b', ['src/user'])], [], FREQ, T0, {
      featureNodes: FEATURES, paths: PATHS,
    })
    assert.ok(r.gaps.some((g) => g.includes('공변경 엣지가 하나도 없다')))
  })

  it('freq 가 JSON 을 건너 빈 객체가 되면 그렇다고 말한다', () => {
    const r = collisionRisk(
      [claim('a', ['src/album/controller.ts']), claim('b', ['src/user/repository.ts'])],
      [co('src/album/controller.ts', 'src/user/repository.ts', 9, 12)],
      {},   // Map 이 JSON 을 건넌 모습
      T0, { featureNodes: FEATURES, paths: PATHS },
    )
    assert.ok(r.gaps.some((g) => g.includes('freq 가 비었다')))
  })

  it('🔴 어떤 쌍도 게이트가 아니다', () => {
    const r = collisionRisk([
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/repository.ts']),
    ], [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    assert.equal(r.blocking, false)
    for (const p of r.pairs) {
      assert.equal(p.blocking, false)
      assert.equal(typeof p.why, 'string')
      assert.ok(p.why.length > 0, '근거 없는 경고는 무시당하고, 무시가 시작되면 진짜 경고도 묻힌다')
    }
  })

  it('claim 이 하나뿐이면 비교할 상대가 없다', () => {
    const r = collisionRisk([claim('a', ['src/album'])], [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    assert.deepEqual(r.pairs, [])
    assert.equal(r.checked, 1)
  })

  it('세 명이 같은 기능에 있으면 쌍마다 따로 낸다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/service.ts']),
      claim('c', ['src/album/repository.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    assert.equal(r.pairs.length, 3)
    assert.equal(r.counts.high, 3)
  })

  it('디렉터리 claim 이 유령 모듈을 만들지 않는다', () => {
    // `src/album` 을 파일인 척 세계에 넣으면 modulesOf 가 `src` 라는
    // 없는 모듈을 만들고, 서로 다른 기능의 둘이 거기서 붙는다.
    const claims = [claim('a', ['src/album']), claim('b', ['src/user'])]
    const r = collisionRisk(claims, [], FREQ, T0, { paths: PATHS })
    assert.deepEqual(r.pairs, [])
  })

  it('경고문에 누가·무엇을·왜가 전부 들어간다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts'], { intent: '응답 형태 변경' }),
      claim('b', ['src/album/repository.ts'], { intent: '스키마 정리' }),
    ]
    const r = collisionRisk(claims, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    const text = formatRisk(r.pairs[0])
    for (const must of ['a', 'b', '응답 형태 변경', '스키마 정리', '앨범', '거부가 아닙니다']) {
      assert.ok(text.includes(must), `경고문에 "${must}" 가 있어야 한다`)
    }
  })

  it('손상된 레코드는 판정에서 빼되 침묵하지 않는다', () => {
    const claims = [
      { agent: '(손상: x.json)', paths: [], broken: true },
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/repository.ts']),
    ]
    const r = collisionRisk(claims, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    assert.equal(r.checked, 2)
    assert.equal(r.pairs.length, 1)
    assert.ok(r.gaps.some((g) => g.includes('읽을 수 없는 레코드')))
  })
})

// ---------------------------------------------------------------------------
// ③ staleClaims
// ---------------------------------------------------------------------------

describe('staleClaims — 저 사람 아직 하고 있나', () => {
  it('곧 만료되는 것을 잡는다 (시각은 인자다 — 기다리지 않는다)', () => {
    const claims = [claim('민수', ['src/album'], { ttlMs: 30 * MIN })]
    const early = staleClaims(claims, T0 + 10 * MIN)
    const late = staleClaims(claims, T0 + 27 * MIN)

    assert.equal(early.stats.expiring, 0)
    assert.equal(late.stats.expiring, 1)
    assert.equal(late.expiring[0].remaining, '3분')
    assert.match(late.expiring[0].note, /renew/)
  })

  it('🔴 만료된 것은 active 에 없고 expired 에 inEffect:false 로 나온다', () => {
    const claims = [claim('민수', ['src/album'], { ttlMs: 10 * MIN })]
    const r = staleClaims(claims, T0 + 15 * MIN)

    assert.equal(r.stats.active, 0)
    assert.deepEqual(r.active, [])
    assert.equal(r.expired.length, 1)
    assert.equal(r.expired[0].inEffect, false)
    assert.equal(r.expired[0].expiredAgo, '5분')
  })

  it('경계에서 만료된다 — expiresAt 시점은 이미 효력이 없다', () => {
    const claims = [claim('민수', ['src/album'], { ttlMs: 10 * MIN })]
    assert.equal(staleClaims(claims, T0 + 10 * MIN - 1).stats.active, 1)
    assert.equal(staleClaims(claims, T0 + 10 * MIN).stats.active, 0)
  })

  it('TTL 을 거의 다 쓴 것과 처음부터 길게 잡은 것을 둘 다 잡는다', () => {
    const spent = staleClaims([claim('a', ['src/album'], { ttlMs: 30 * MIN })], T0 + 25 * MIN)
    assert.ok(spent.active[0].flags.includes('spent'))

    const longTtl = staleClaims([claim('b', ['src/user'], { ttlMs: 4 * 60 * MIN })], T0 + MIN)
    assert.ok(longTtl.active[0].flags.includes('longTtl'))
    assert.equal(longTtl.stats.longHeld, 1)
    assert.match(longTtl.active[0].note, /오래 잡을 작정/)
  })

  it('🔴 renew 가 since 를 되돌린다는 계측 한계를 반드시 말한다', () => {
    const r = staleClaims([claim('민수', ['src/album'])], T0 + MIN)
    assert.ok(
      r.gaps.some((g) => g.includes('renew 는 since 를 지금으로 되돌린다')),
      '장부는 처음 잡은 시각을 기억하지 않는다. 추정으로 메우면 없는 사실을 만드는 것이다.',
    )
  })

  it('now 가 없으면 아무것도 판정하지 않는다', () => {
    const r = staleClaims([claim('민수', ['src/album'])], null)
    assert.deepEqual(r.active, [])
    assert.deepEqual(r.expired, [])
    assert.ok(r.gaps[0].includes('now 가 없어'))
  })

  it('readClaims 를 거친 모양(expiresAt)도 그대로 읽는다', () => {
    const viewShape = {
      agent: '민수',
      paths: ['src/album'],
      since: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 30 * MIN).toISOString(),
    }
    const r = staleClaims([viewShape], T0 + 28 * MIN)
    assert.equal(r.stats.expiring, 1)
    assert.equal(r.active[0].ttlMs, 30 * MIN)
  })

  it('만료 시각을 못 읽으면 유효도 만료도 아닌 unreadable 이다', () => {
    const broken = { agent: '민수', paths: ['src/album'], since: '언제쯤?' }
    const r = staleClaims([broken], T0)
    assert.equal(r.stats.active, 0)
    assert.equal(r.stats.expired, 0)
    assert.equal(r.stats.unreadable, 1)
    assert.ok(r.gaps.some((g) => g.includes('읽을 수 없는 레코드')))
  })
})

// ---------------------------------------------------------------------------
// ④ summary
// ---------------------------------------------------------------------------

describe('summary — 한 문단', () => {
  const claims = [
    claim('민수', ['src/album/controller.ts']),
    claim('영희', ['src/album/repository.ts']),
  ]
  const now = T0 + 28 * MIN

  it('숫자가 들어가고 등급별로 말한다', () => {
    const who = whoIsWhere(claims, [], FEATURES, { now })
    const risk = collisionRisk(claims, [], FREQ, now, { featureNodes: FEATURES, paths: PATHS })
    const stale = staleClaims(claims, now)
    const s = summary({ who, risk, stale, me: '민수' })

    assert.match(s.text, /2명/)
    assert.match(s.text, /높음 1쌍/)
    assert.match(s.text, /2명의 선점이 곧 풀린다/)
    assert.equal(s.counts.contested, 1)
    assert.equal(s.blocking, false)
  })

  it('🔴 접으면서 gaps 를 버리지 않는다', () => {
    const who = whoIsWhere(claims, [], FEATURES, { now })
    const risk = collisionRisk(claims, [], FREQ, now, { featureNodes: FEATURES, paths: PATHS })
    const stale = staleClaims(claims, now)
    const s = summary({ who, risk, stale })

    assert.ok(s.gaps.length > 0)
    assert.deepEqual(
      [...new Set(s.gaps.map((g) => g.from))].sort(),
      ['collisionRisk', 'staleClaims'],
    )
  })

  it('아무도 없으면 없다고 말한다', () => {
    const s = summary({
      who: whoIsWhere([], [], FEATURES, { now }),
      risk: collisionRisk([], [], FREQ, now, { featureNodes: FEATURES, paths: PATHS }),
      stale: staleClaims([], now),
    })
    assert.match(s.text, /잡고 있는 사람은 없다/)
  })
})

// ---------------------------------------------------------------------------
// 잔가지 — 순수성과 문장
// ---------------------------------------------------------------------------

describe('잔가지', () => {
  it('expiryOf 는 두 모양을 다 읽고, 못 읽으면 null 을 낸다', () => {
    assert.equal(expiryOf({ since: new Date(T0).toISOString(), ttlMs: 1000 }), T0 + 1000)
    assert.equal(expiryOf({ expiresAt: new Date(T0).toISOString() }), T0)
    // 🔴 0 이나 Infinity 로 치환하지 않는다 — 치환이 곧 소유권 충돌이다
    assert.equal(expiryOf({ since: 'x', ttlMs: 'y' }), null)
    assert.equal(expiryOf({}), null)
  })

  it('partitionClaims 는 만료를 버리지 않고 따로 낸다', () => {
    const p = partitionClaims([
      claim('a', ['x'], { ttlMs: 10 * MIN }),
      claim('b', ['y'], { ttlMs: 60 * MIN }),
      { agent: 'c', paths: ['z'] },
    ], T0 + 20 * MIN)
    assert.deepEqual(p.live.map((c) => c.agent), ['b'])
    assert.deepEqual(p.expired.map((c) => c.agent), ['a'])
    assert.deepEqual(p.unreadable.map((c) => c.agent), ['c'])
  })

  it('조사가 받침을 따라간다 — 문장으로 읽혀야 사람이 읽는다', () => {
    assert.equal(josa('민수', '이/가'), '가')
    assert.equal(josa('영선', '이/가'), '이')
    assert.equal(josa('앨범', '을/를'), '을')
    assert.equal(josa('데이터', '을/를'), '를')
  })

  it('🔴 같은 입력이면 같은 답이다 — 시계를 안 본다', () => {
    const claims = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/repository.ts']),
    ]
    const one = collisionRisk(claims, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    const two = collisionRisk(claims, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    assert.deepEqual(one, two)
  })

  it('🔴 무관한 제3자가 두 사람의 판정을 바꾸지 못한다', () => {
    // protocol.test.mjs 의 "Case 1 과 Case 2 는 반드시 같은 답이어야 한다" 와 같은 성질.
    // 화면 층에서도 지켜져야 한다 — 남이 들어왔다고 내 경고가 바뀌면 아무도 못 믿는다.
    const pair = [
      claim('a', ['src/album/controller.ts']),
      claim('b', ['src/album/repository.ts']),
    ]
    const withThird = [...pair, claim('c', ['src/user/controller.ts'])]

    const one = collisionRisk(pair, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    const two = collisionRisk(withThird, [], FREQ, T0, { featureNodes: FEATURES, paths: PATHS })
    const ab = two.pairs.filter((p) => p.agents.includes('a') && p.agents.includes('b'))

    assert.equal(one.pairs.length, 1)
    assert.equal(ab.length, 1)
    assert.equal(ab[0].level, one.pairs[0].level)
    assert.deepEqual(ab[0].reasons, one.pairs[0].reasons)
  })
})
