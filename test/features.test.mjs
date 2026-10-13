/**
 * 기능 클러스터 회귀 테스트.
 *
 * 여기 있는 것은 전부 e101 저장소 실측에서 실제로 나온 현상이다.
 * 특히 "체인으로 24개가 뭉친다"는 처음 구현이 실제로 실패한 방식이다.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  applyEdits, cochange, disambiguate, draft, editRecord, featureEdges, featureId, featuresOf,
  nameFromSubject, onceClusters,
  mutualTop, provisionalName,
} from '../app/lib/features.mjs'

test('같은 커밋에서 함께 바뀐 파일이 한 기능으로 묶인다', () => {
  const c = [
    ['a/Map.java', 'a/MapService.java'],
    ['a/Map.java', 'a/MapService.java'],
    ['a/Map.java', 'a/MapService.java'],
  ]
  const d = draft(c)
  assert.equal(d.features.length, 1)
  assert.deepEqual(d.features[0].paths, ['a/Map.java', 'a/MapService.java'])
})

test('한 커밋이 함께 만든 것도 기능이다 - 근거는 약하다고 표시한다', () => {
  // 🔴 이 테스트는 원래 정반대였다("한 번만 함께 바뀐 것은 기능이 아니다").
  // 실측으로 뒤집었다 — 기능에 안 묶인 파일 133개 중 101개(76%)가 커밋 1회였고,
  // 그것들이 `순찰 지점 저장·조회 API`·`2D 도면 자동 생성` 같은 명백한 기능이었다.
  //
  // 옛 규칙은 "두 번 이상 고쳐진 것"만 봤고, 그건 **자주 고쳐진 코드 =
  // 문제가 많았던 코드**만 남긴다는 뜻이었다. 한 번에 잘 만든 코드가
  // 통째로 안 보이는 편향이라 반전이 맞다.
  const d = draft([{ subject: 'feat: 로그인', files: ['a.java', 'b.java'] }])
  assert.equal(d.features.length, 1)
  assert.equal(d.features[0].evidence, 'once', '근거가 약하다는 것은 남겨야 한다')
  assert.equal(d.features[0].source, 'commit')
})

test('반복 동시변경이 한 번짜리보다 우선한다', () => {
  // 같은 파일이 양쪽에 다 들어가면 강한 근거 쪽만 남아야 한다.
  const d = draft([
    { subject: 'feat: 맵', files: ['map.java', 'mapsvc.java'] },
    { subject: 'fix: 맵', files: ['map.java', 'mapsvc.java'] },
    { subject: 'feat: 맵', files: ['map.java', 'mapsvc.java'] },
  ])
  assert.equal(d.features.length, 1)
  assert.equal(d.features[0].evidence, 'repeat')
})

test('대량 커밋은 버린다 - 제곱으로 늘어난 쌍이 클러스터를 뭉갠다', () => {
  const big = Array.from({ length: 30 }, (_, i) => `f${i}.java`)
  const d = draft([big, big, big])
  assert.equal(d.features.length, 0)
  assert.equal(d.stats.commitsUsed, 0)
})

test('자주 바뀌는 파일이 저장소 전체와 짝이 되지 않는다', () => {
  // README 처럼 무엇과도 함께 바뀌는 파일. 횟수만 세면 전부와 이어진다.
  const c = [
    ['hot.java', 'a.java'], ['hot.java', 'b.java'], ['hot.java', 'c.java'],
    ['hot.java', 'd.java'], ['hot.java', 'e.java'], ['hot.java', 'f.java'],
    ['a.java'], ['b.java'], ['c.java'], ['d.java'], ['e.java'], ['f.java'],
  ]
  const { links } = cochange(c)
  assert.equal(links.length, 0, '자카드가 낮아 전부 걸러진다')
})

test('체인이 서로 무관한 기능을 한 덩어리로 만들지 않는다', () => {
  // 🔴 처음 구현이 실패한 방식. A-허브, 허브-B 가 각각 강하면
  // A 와 B 가 아무 상관 없어도 연결 요소로는 한 덩어리가 된다.
  // 실측에서 BE_system 이 이렇게 24개로 뭉쳐 "기능별로 보기"가 무의미해졌다.
  const c = []
  // 기능 1 — 서로 단단히
  for (let i = 0; i < 6; i++) c.push(['auth/User.java', 'auth/AuthService.java', 'auth/AuthController.java'])
  // 기능 2 — 서로 단단히
  for (let i = 0; i < 6; i++) c.push(['video/VideoService.java', 'video/VideoController.java', 'video/VideoDto.java'])
  // 두 기능을 잇는 다리. 각각과는 자주 붙지만 둘은 남남이다.
  for (let i = 0; i < 5; i++) c.push(['auth/AuthService.java', 'common/Bridge.java'])
  for (let i = 0; i < 5; i++) c.push(['common/Bridge.java', 'video/VideoService.java'])

  // 🔴 기본값으로 돌린다. 예전에는 `{topK: 3}` 을 넘겨서, 출고 값이 5 로
  // 바뀌어도 이 테스트는 계속 통과했다 — 지키려던 것을 안 지키는 검사기였다.
  const { links } = cochange(c)
  const kept = mutualTop(links)
  const d = draft(c)

  // 다리를 지나 auth 와 video 가 같은 기능이 되면 안 된다
  const withBoth = d.features.filter(
    (f) => f.paths.some((p) => p.startsWith('auth/')) && f.paths.some((p) => p.startsWith('video/')),
  )
  assert.equal(withBoth.length, 0, 'auth 와 video 는 다른 기능이다')
  assert.ok(kept.length <= links.length)
})

test('상호 top-K 는 한쪽만 좋아하는 관계를 버린다', () => {
  const links = [
    { a: 'x', b: 'y', n: 5, j: 0.9 },
    { a: 'x', b: 'z', n: 5, j: 0.8 },
    { a: 'x', b: 'w', n: 5, j: 0.7 },
    { a: 'x', b: 'v', n: 5, j: 0.6 }, // x 의 4순위 — top-3 밖
  ]
  const kept = mutualTop(links, { topK: 3 })
  assert.ok(!kept.some((l) => l.b === 'v'), 'x 의 상위 3 밖이면 버린다')
  assert.equal(kept.length, 3)
})

test('지워진 파일은 기능에서 빠진다', () => {
  const c = [
    ['a.java', 'b.java', 'gone.java'],
    ['a.java', 'b.java', 'gone.java'],
    ['a.java', 'b.java', 'gone.java'],
  ]
  const d = draft(c, new Set(['a.java', 'b.java']))
  assert.deepEqual(d.features[0].paths, ['a.java', 'b.java'])
})

test('임시 이름은 파일명에서 공통 어간을 뽑는다', () => {
  assert.equal(provisionalName(['x/MapService.java', 'x/MapController.java', 'x/MapDto.java']), 'map')
  assert.equal(provisionalName(['a/auth_store.js', 'a/auth_screen.js']), 'auth')
})

test('임시 이름은 test 를 이름으로 쓰지 않는다', () => {
  // 테스트 파일끼리 묶이는 오탐이 실제로 있다. 그때 이름이 "test" 면
  // 목록에서 무엇인지 전혀 알 수 없다.
  const n = provisionalName(['x/MapTests.java', 'x/MapServiceTests.java'])
  assert.notEqual(n, 'test')
  assert.equal(n, 'map')
})

test('식별자는 이름이 아니라 구성 파일에서 나온다 - 이름을 바꿔도 같은 기능이다', () => {
  const paths = ['a/Map.java', 'a/MapService.java']
  const id = featureId(paths)
  assert.equal(featureId([...paths].reverse()), id, '순서가 달라도 같다')
  assert.ok(id.length > 0)
})

test('한 파일이 여러 기능에 속할 수 있다 - 분할이 아니라 덮개다', () => {
  const features = [
    { id: 'a', paths: ['mux.py', 'drive.py'] },
    { id: 'b', paths: ['mux.py', 'estop.py'] },
  ]
  assert.equal(featuresOf(features, 'mux.py').length, 2)
  assert.equal(featuresOf(features, 'drive.py').length, 1)
})

test('히스토리가 없으면 조용히 빈 결과를 준다', () => {
  const d = draft([])
  assert.deepEqual(d.features, [])
  assert.equal(d.stats.files, 0)
})

// ---------------------------------------------------------------------------
// 사람의 수정 — 편집을 쌓고 초안 위에 다시 얹는다
// ---------------------------------------------------------------------------

const base = () => [
  { id: 'auth', name: 'auth', nameSource: 'auto', paths: ['auth/A.java', 'auth/B.java'], commits: 3, source: 'cochange' },
  { id: 'video', name: 'video', nameSource: 'auto', paths: ['v/V.java', 'v/W.java'], commits: 2, source: 'cochange' },
]

test('이름을 바꾸면 출처가 human 이 된다', () => {
  const { features } = applyEdits(base(), [{ op: 'rename', id: 'auth', name: '회원가입', anchor: ['auth/A.java', 'auth/B.java'] }])
  const f = features.find((x) => x.id === 'auth')
  assert.equal(f.name, '회원가입')
  assert.equal(f.nameSource, 'human')
  assert.equal(f.edited, true)
})

test('초안을 다시 계산해도 사람의 수정이 살아남는다', () => {
  // 이것이 "결과가 아니라 편집을 저장한다"의 존재 이유다.
  const edits = [{ op: 'rename', id: 'auth', name: '회원가입', anchor: ['auth/A.java', 'auth/B.java'] }]

  // 코드가 바뀌어 초안에 파일이 하나 늘었다 → id 도 바뀔 수 있다
  const redrafted = [
    { id: 'auth-a-java', name: 'auth', nameSource: 'auto', paths: ['auth/A.java', 'auth/B.java', 'auth/C.java'], commits: 4, source: 'cochange' },
  ]
  const { features, orphans } = applyEdits(redrafted, edits)
  assert.equal(features[0].name, '회원가입', 'id 가 달라도 겹침으로 찾아낸다')
  assert.equal(orphans.length, 0)
})

test('가리키던 기능이 완전히 사라지면 조용히 버리지 않고 드러낸다', () => {
  const edits = [{ op: 'rename', id: 'gone', name: '없어진것', anchor: ['x/X.java', 'x/Y.java'] }]
  const { features, orphans } = applyEdits(base(), edits)
  assert.equal(orphans.length, 1, '사람이 한 일이 이유 없이 사라지면 안 된다')
  assert.ok(features.every((f) => f.name !== '없어진것'))
})

test('파일을 넣고 뺄 수 있다', () => {
  const { features } = applyEdits(base(), [
    { op: 'include', id: 'auth', anchor: ['auth/A.java', 'auth/B.java'], path: 'auth/Z.java' },
    { op: 'exclude', id: 'video', anchor: ['v/V.java', 'v/W.java'], path: 'v/W.java' },
  ])
  assert.deepEqual(features.find((f) => f.id === 'auth').paths, ['auth/A.java', 'auth/B.java', 'auth/Z.java'])
  assert.deepEqual(features.find((f) => f.id === 'video').paths, ['v/V.java'])
})

test('파일을 전부 빼면 기능이 목록에서 사라진다', () => {
  const { features } = applyEdits(base(), [
    { op: 'exclude', id: 'video', anchor: ['v/V.java', 'v/W.java'], path: 'v/V.java' },
    { op: 'exclude', id: 'video', anchor: ['v/V.java'], path: 'v/W.java' },
  ])
  assert.ok(!features.some((f) => f.id === 'video'))
})

test('오탐 기능을 숨길 수 있다 - 테스트 정비 같은 것', () => {
  const { features } = applyEdits(base(), [{ op: 'hide', id: 'video', anchor: ['v/V.java', 'v/W.java'] }])
  assert.equal(features.find((f) => f.id === 'video').hidden, true)
})

test('사람이 기능을 새로 만들 수 있다', () => {
  const { features } = applyEdits(base(), [{ op: 'create', name: '긴급정지', paths: ['a/estop.py', 'b/mux.py'] }])
  const f = features.find((x) => x.name === '긴급정지')
  assert.equal(f.source, 'human')
  assert.equal(f.nameSource, 'human')
  assert.deepEqual(f.paths, ['a/estop.py', 'b/mux.py'])
})

test('두 기능을 합칠 수 있다', () => {
  const { features } = applyEdits(base(), [
    { op: 'merge', id: 'video', anchor: ['v/V.java', 'v/W.java'], into: 'auth', intoAnchor: ['auth/A.java', 'auth/B.java'] },
  ])
  const auth = features.find((f) => f.id === 'auth')
  assert.deepEqual(auth.paths, ['auth/A.java', 'auth/B.java', 'v/V.java', 'v/W.java'])
  assert.equal(features.find((f) => f.id === 'video').hidden, true)
})

test('모르는 편집은 버리지 않고 드러낸다 - 새 버전이 쓴 것일 수 있다', () => {
  const { orphans } = applyEdits(base(), [{ op: 'teleport', id: 'auth', anchor: ['auth/A.java', 'auth/B.java'] }])
  assert.equal(orphans.length, 1)
})

test('editRecord 는 anchor 를 반드시 함께 남긴다', () => {
  const r = editRecord('rename', base()[0], { name: 'X' })
  assert.deepEqual(r.anchor, ['auth/A.java', 'auth/B.java'])
  assert.equal(r.op, 'rename')
  assert.equal(r.name, 'X')
})

test('편집은 초안을 건드리지 않는다', () => {
  const b = base()
  applyEdits(b, [{ op: 'rename', id: 'auth', name: 'X', anchor: b[0].paths }])
  assert.equal(b[0].name, 'auth', '초안이 그대로여야 다시 계산이 의미를 갖는다')
})

// ---------------------------------------------------------------------------
// 이름 충돌 · 기능 사이의 관계
// ---------------------------------------------------------------------------

test('이름이 겹치면 그 묶음에만 있는 말로 구별한다', () => {
  // 실측에서 BE_system 의 두 묶음이 똑같이 robot 이 됐다.
  const fs = [
    {
      id: 'a', name: 'robot', paths: [
        'server/stomp/RobotEventListener.java',
        'server/stomp/StompWebSocketConfig.java',
        'server/wss/RobotWebSocketHandler.java',
      ],
    },
    {
      id: 'b', name: 'robot', paths: [
        'server/robot/domain/RobotState.java',
        'server/robot/service/RobotService.java',
        'server/robot/RobotCacheTests.java',
      ],
    },
  ]
  disambiguate(fs)
  assert.notEqual(fs[0].name, fs[1].name, '목록에서 구별되어야 한다')
  assert.ok(fs[0].name.startsWith('robot'), '원래 이름은 남긴다')
  assert.ok(fs[1].name.startsWith('robot'))
  // 어느 말이 뽑히든(socket/stomp) 상관없다. 요구사항은 '겹치지 않는 것'이다.
  // 다만 **저장소 전체에 있는 말**은 뽑히면 안 된다 — 실측에서 모든 경로에
  // 있는 `server` 가 뽑혀 `robot·server` 라는 무의미한 이름이 나왔다.
  for (const f of fs) assert.ok(!f.name.includes('server'), `전체에 흔한 말: ${f.name}`)
})

test('겹치지 않는 이름은 건드리지 않는다', () => {
  const fs = [{ id: 'a', name: 'auth', paths: ['x/A.java'] }, { id: 'b', name: 'video', paths: ['y/V.java'] }]
  disambiguate(fs)
  assert.equal(fs[0].name, 'auth')
  assert.equal(fs[1].name, 'video')
})

test('구별할 말이 없으면 번호를 붙인다 - 예쁘지 않아도 겹치지는 않는다', () => {
  const fs = [
    { id: 'a', name: 'map', paths: ['map.java'] },
    { id: 'b', name: 'map', paths: ['map.java'] },
  ]
  disambiguate(fs)
  assert.notEqual(fs[0].name, fs[1].name)
})

test('같은 입력이면 같은 이름이 나온다 - 편집 기록이 흔들리면 안 된다', () => {
  const make = () => [
    { id: 'a', name: 'robot', paths: ['s/stomp/A.java', 's/stomp/B.java'] },
    { id: 'b', name: 'robot', paths: ['s/cache/C.java', 's/cache/D.java'] },
  ]
  const x = disambiguate(make()).map((f) => f.name)
  const y = disambiguate(make()).map((f) => f.name)
  assert.deepEqual(x, y)
})

test('같은 커밋에서 함께 바뀐 기능끼리 이어진다', () => {
  const fs = [
    { id: 'auth', paths: ['a/A.java', 'a/B.java'] },
    { id: 'event', paths: ['e/E.java'] },
    { id: 'video', paths: ['v/V.java'] },
  ]
  const commits = [
    ['a/A.java', 'e/E.java'],
    ['a/B.java', 'e/E.java'],
    ['v/V.java'],
  ]
  const edges = featureEdges(fs, commits)
  assert.equal(edges.length, 1)
  assert.equal(edges[0].n, 2)
  assert.equal(edges[0].directed, false, '함께 바뀐 것에는 앞뒤가 없다')
  assert.ok(!edges.some((e) => e.source === 'video' || e.target === 'video'))
})

test('기능 사이 엣지는 자동 기능끼리도 생긴다 - 공유 파일이 없어도', () => {
  // 자동 기능은 연결 요소로 잘라서 파일이 겹치지 않는다.
  // 공유 파일로만 이으면 엣지가 하나도 안 생긴다.
  const fs = [{ id: 'x', paths: ['x.java'] }, { id: 'y', paths: ['y.java'] }]
  const shared = fs[0].paths.filter((p) => fs[1].paths.includes(p))
  assert.equal(shared.length, 0, '겹치는 파일이 없다')
  assert.equal(featureEdges(fs, [['x.java', 'y.java']]).length, 1, '그래도 이어진다')
})

// ---------------------------------------------------------------------------
// 소스 위생 — 습관이 아니라 검사로 만든다
// ---------------------------------------------------------------------------

test('소스에 NUL 바이트가 없다', async () => {
  // 2026-08-15 밤에 한 번 났던 사고다. 그때 "앞으로 파일을 쓴 뒤 NUL 검사를
  // 하겠다"고 적어 뒀는데, 습관은 검사가 아니다. 이번에 features.mjs 에
  // 또 들어갔다 — git 이 파일을 바이너리로 보기 시작해 grep 이 먹통이 된다.
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

  const bad = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.axmap', '.cache'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(mjs|js|json|md|css|html|sh)$/.test(e.name)) continue
      if (statSync(p).size > 2_000_000) continue
      if (readFileSync(p).includes(0)) bad.push(p)
    }
  }
  walk(root)
  assert.deepEqual(bad, [], `NUL 바이트가 든 파일: ${bad.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 경로 B — 커밋 제목에서 이름, 명단은 제목과 무관
// ---------------------------------------------------------------------------

test('커밋 제목에서 이름을 뽑는다 - 티켓·타입·모듈 접두사를 벗긴다', () => {
  assert.equal(
    nameFromSubject('[S15P11E101-509] feat: [BE] 순찰 지점(waypoint) 저장·조회 API'),
    '순찰 지점(waypoint) 저장·조회 API',
  )
  // `·` 로 자르면 `저장·조회` 가 잘려 나간다. 실측에서 나온 버그라 못박는다.
  assert.ok(nameFromSubject('feat: 순찰 지점 저장·조회 API').includes('조회'))
})

test('쓸 수 없는 제목은 거르고 파일명으로 떨어진다', () => {
  for (const s of ['wip', 'fix', 'update', '수정', '...', 'Initial commit', '']) {
    assert.equal(nameFromSubject(s), null, `걸러야 한다: ${JSON.stringify(s)}`)
  }
})

test('애매한 제목은 통과시킨다 - 좋은 이름을 버리는 필터가 더 나쁘다', () => {
  // 제목이 한국어이고 파일명이 영어면 겹치는 말이 없다. 그걸로 거르면
  // 실측에서 17개 중 9개의 **좋은 이름**이 버려졌다.
  assert.equal(nameFromSubject('feat: [Robot] 실시간 맵 전송 경량화'), '실시간 맵 전송 경량화')
  assert.equal(nameFromSubject('온보드 TensorRT 추론 파이프라인 추가'), '온보드 TensorRT 추론 파이프라인 추가')
})

test('🔴 명단은 커밋 제목과 무관하다 - 제목이 전부 쓰레기여도 기능은 다 나온다', () => {
  // 이게 이 설계의 핵심 성질이다. 커밋 메시지 습관은 저장소마다 다르므로
  // 거기 기대면 "대다수의 사람들이 자기 저장소에 붙인다"가 무너진다.
  const files = [
    { subject: 'feat: 순찰 경로 API', files: ['PatrolRouteController.java', 'RouteRequest.java'] },
    { subject: 'feat: 도면 생성', files: ['FloorPlanService.java', 'FloorPlanTests.java'] },
  ]
  const junk = files.map((c) => ({ subject: 'wip', files: c.files }))

  const good = draft(files)
  const bad = draft(junk)

  assert.equal(good.features.length, bad.features.length, '기능 개수가 같아야 한다')
  assert.deepEqual(
    good.features.map((f) => f.paths).sort(),
    bad.features.map((f) => f.paths).sort(),
    '명단이 같아야 한다',
  )
  // 다른 것은 이름뿐이다
  assert.equal(good.features[0].nameSource, 'commit')
  assert.equal(bad.features[0].nameSource, 'auto')
})

test('큰 커밋은 버리되 몇 개를 버렸는지 알린다', () => {
  // 조용히 버리면 "커버리지가 낮다"의 원인을 아무도 모른다.
  const big = Array.from({ length: 20 }, (_, i) => `f${i}.java`)
  const d = draft([{ subject: 'refactor: 대규모 정리', files: big }])
  assert.equal(d.features.length, 0)
  assert.equal(d.stats.droppedBigCommits, 1)
})

test('근거별 개수를 통계에 남긴다', () => {
  const d = draft([
    { subject: 'feat: a', files: ['a1.java', 'a2.java'] },
    { subject: 'fix: a', files: ['a1.java', 'a2.java'] },
    { subject: 'feat: b', files: ['b1.java', 'b2.java'] },
  ])
  assert.equal(d.stats.repeatFeatures, 1)
  assert.equal(d.stats.onceFeatures, 1)
})

test('기본 임계값에서 클러스터가 응집돼 있다 - 체인 뭉침 감시', () => {
  // 커버리지를 올리려고 topK 를 올리면 서로 만난 적 없는 파일이 한 덩어리가 된다.
  // 실측: topK 5 에서 최저 응집도가 0.68 → 0.31 로 떨어지고 24개짜리가 생겼다.
  // 그 회귀를 여기서 잡는다.
  const commits = []
  // 서로 단단한 묶음 둘 + 그 사이를 오가는 다리 파일
  for (let i = 0; i < 8; i++) commits.push(['a/A1.java', 'a/A2.java', 'a/A3.java'])
  for (let i = 0; i < 8; i++) commits.push(['v/V1.java', 'v/V2.java', 'v/V3.java'])
  for (let i = 0; i < 7; i++) commits.push(['a/A1.java', 'x/Bridge.java'])
  for (let i = 0; i < 7; i++) commits.push(['x/Bridge.java', 'v/V1.java'])

  const d = draft(commits) // 기본값
  const repeat = d.features.filter((f) => f.evidence === 'repeat')

  // 실제로 함께 바뀐 쌍
  const met = new Set()
  for (const c of commits) {
    for (let i = 0; i < c.length; i++) {
      for (let j = i + 1; j < c.length; j++) met.add([c[i], c[j]].sort().join('|'))
    }
  }
  for (const f of repeat) {
    let hit = 0
    let all = 0
    for (let i = 0; i < f.paths.length; i++) {
      for (let j = i + 1; j < f.paths.length; j++) {
        all++
        if (met.has([f.paths[i], f.paths[j]].sort().join('|'))) hit++
      }
    }
    assert.ok(hit / all >= 0.5, `응집도가 낮다 (${f.name}: ${hit}/${all}) — 체인으로 뭉쳤을 수 있다`)
  }
})
