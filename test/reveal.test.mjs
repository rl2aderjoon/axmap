/**
 * 점진 공개.
 *
 * 🔴 이 파일이 지키는 것은 하나다 — **한 번 자리를 잡은 노드는 다시는
 *    움직이지 않는다.** 움직이면 방금 쌓은 지도가 매번 무너지고, 그건
 *    정적인 헤어볼보다 나쁘다(헤어볼은 적어도 어제와 같은 자리에 있다).
 *
 * 나머지 테스트는 그 불변식이 어떤 경로로 깨질 수 있는지를 하나씩 막는다.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  callsOf, emptyReveal, frontDoor, importersOf, layers, preview, reachable, reveal, revealFeature,
} from '../app/lib/reveal.mjs'

const E = (source, target, extra = {}) => ({ source, target, directed: true, ...extra })
const ctx = (edges) => ({ importers: importersOf(edges), calls: callsOf(edges) })
const pos = (s) => Object.fromEntries(Object.entries(s.at).map(([k, v]) => [k, `${v.depth}:${v.col}`]))

describe('진입점 하나로 시작한다', () => {
  it('빈 상태는 아무것도 없다', () => {
    const s = emptyReveal()
    assert.deepEqual(s.order, [])
    assert.deepEqual(layers(s), [])
  })

  it('첫 노드는 0층 0번', () => {
    const { importers } = ctx([])
    const s = reveal(emptyReveal(), ['main.go'], { why: '진입점', importers })
    assert.equal(s.at['main.go'].depth, 0)
    assert.equal(s.at['main.go'].col, 0)
  })

  it('왜 나왔는지를 들고 있다 — 화면이 그걸 적어야 한다', () => {
    const { importers } = ctx([])
    const s = reveal(emptyReveal(), ['main.go'], { why: '②가 고른 진입점', importers })
    assert.equal(s.at['main.go'].why, '②가 고른 진입점')
  })
})

describe('🔴 한 번 놓인 것은 움직이지 않는다', () => {
  const edges = [E('a', 'b'), E('b', 'c'), E('a', 'd'), E('d', 'c')]
  const { importers, calls } = ctx(edges)

  it('나중에 펼쳐도 앞엣것의 자리가 그대로다', () => {
    let s = reveal(emptyReveal(), ['a'], { why: '진입점', importers })
    const p1 = pos(s)
    s = reveal(s, calls.get('a'), { why: 'a 가 부르는 것', parent: 'a', importers })
    const p2 = pos(s)
    for (const k of Object.keys(p1)) assert.equal(p2[k], p1[k], `${k} 가 움직였다`)
    s = reveal(s, calls.get('b'), { why: 'b 가 부르는 것', parent: 'b', importers })
    const p3 = pos(s)
    for (const k of Object.keys(p2)) assert.equal(p3[k], p2[k], `${k} 가 움직였다`)
  })

  it('같은 것을 두 번 드러내도 자리가 안 바뀐다', () => {
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['b'], { why: 'y', parent: 'a', importers })
    const before = pos(s)
    s = reveal(s, ['b', 'b'], { why: '다시', parent: 'a', importers })
    assert.deepEqual(pos(s), before)
    assert.equal(s.order.filter((x) => x === 'b').length, 1, '중복으로 들어갔다')
  })

  it('🔴 여러 경로로 닿는 노드도 처음 층에 남는다', () => {
    // c 는 b 를 통해서도 d 를 통해서도 닿는다. 나중 경로가 층을 바꾸면
    // 이미 그려진 화면이 재배치된다.
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['b', 'd'], { why: 'y', parent: 'a', importers })
    s = reveal(s, ['c'], { why: 'b 에서', parent: 'b', importers })
    const d1 = s.at.c.depth
    s = reveal(s, ['c'], { why: 'd 에서도', parent: 'd', importers })
    assert.equal(s.at.c.depth, d1)
  })
})

describe('층을 정하는 규칙', () => {
  const edges = [E('a', 'b'), E('b', 'c')]
  const { importers } = ctx(edges)

  it('부르는 쪽이 이미 있으면 그 아래', () => {
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['b'], { why: 'y', parent: 'a', importers })
    assert.equal(s.at.b.depth, 1)
  })

  it('🔴 아직 안 드러난 것을 근거로 층을 정하지 않는다', () => {
    // c 를 먼저 열면 b 는 아직 화면에 없다. b 를 근거로 c 를 2층에 두면,
    // 나중에 b 가 드러났을 때 자리를 다시 맞춰야 한다 — 불변식 위반.
    const s = reveal(emptyReveal(), ['c'], { why: '검색으로 바로', importers })
    assert.equal(s.at.c.depth, 0, '없는 것을 근거로 층을 정했다')
  })

  it('연결이 없으면 새 뿌리가 된다', () => {
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['혼자.go'], { why: '사이드바에서', importers })
    assert.equal(s.at['혼자.go'].depth, 0)
    assert.equal(s.at['혼자.go'].col, 1, '같은 층 끝에 붙어야 한다')
  })

  it('같은 층에는 도착 순서대로 붙는다', () => {
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['b'], { why: 'y', parent: 'a', importers })
    s = reveal(s, ['z1', 'z2'], { why: 'z', parent: 'a', importers })
    assert.equal(s.at.b.col, 0)
    assert.equal(s.at.z1.col, 1)
    assert.equal(s.at.z2.col, 2)
  })

  it('방향 모르는 연결도 통과시킨다', () => {
    const { importers: im } = ctx([{ source: 'x', target: 'y', directed: false }])
    let s = reveal(emptyReveal(), ['y'], { why: 'x', importers: im })
    s = reveal(s, ['x'], { why: 'y', parent: 'y', importers: im })
    assert.equal(s.at.x.depth, 1)
  })
})

describe('누르기 전에 몇 개인지 알려준다', () => {
  const edges = [E('a', 'b'), E('a', 'c'), E('a', 'd')]
  const { importers, calls } = ctx(edges)

  it('펼치면 나올 개수를 미리 낸다', () => {
    // 🔴 몇 개가 나올지 모르고 누르는 것이 곧 벽이다. 3개면 눌러도 되고
    //    200개면 마음의 준비가 필요하다.
    const s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    assert.equal(preview(s, 'a', calls).count, 3)
  })

  it('이미 드러난 것은 안 센다', () => {
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['b'], { why: 'y', parent: 'a', importers })
    assert.equal(preview(s, 'a', calls).count, 2)
  })

  it('부르는 것이 없으면 0', () => {
    const s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    assert.equal(preview(s, '없는파일', calls).count, 0)
  })
})

describe('규모 감각을 숫자로 돌려준다', () => {
  it('여기서 몇 개나 더 닿는지 센다', () => {
    // 🔴 "드러난 것만" 보여주면 5개를 보고 "이 저장소는 5개짜리" 로 읽는다.
    const edges = [E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e')]
    const { importers, calls } = ctx(edges)
    const s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    assert.deepEqual(reachable(s, calls), { shown: 1, more: 4 })
  })

  it('다 드러나면 더 닿을 것이 없다', () => {
    const edges = [E('a', 'b')]
    const { importers, calls } = ctx(edges)
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['b'], { why: 'y', parent: 'a', importers })
    assert.deepEqual(reachable(s, calls), { shown: 2, more: 0 })
  })

  it('순환이 있어도 안 멈춘다', () => {
    const edges = [E('a', 'b'), E('b', 'a')]
    const { importers, calls } = ctx(edges)
    const s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    assert.equal(reachable(s, calls).more, 1)
  })
})

describe('layers — 화면이 그릴 모양', () => {
  it('층별로 col 순서대로 낸다', () => {
    const edges = [E('a', 'b'), E('a', 'c')]
    const { importers } = ctx(edges)
    let s = reveal(emptyReveal(), ['a'], { why: 'x', importers })
    s = reveal(s, ['b', 'c'], { why: 'y', parent: 'a', importers })
    const L = layers(s, new Map([['a', { lines: 10 }]]))
    assert.deepEqual(L.map((r) => r.depth), [0, 1])
    assert.deepEqual(L[1].cells.map((c) => c.id), ['b', 'c'])
    assert.equal(L[0].cells[0].lines, 10, '줄 수를 같이 낸다')
  })
})

describe('개념 축 — 묶음의 현관문', () => {
  /**
   * 🔴 묶음을 통째로 열면 벽이 그대로 돌아온다. syft 의 `syft/pkg` 는 595개다.
   *    한 번 눌러서 595개가 쏟아지면 우리가 없애려던 것을 다시 만드는 것이다.
   */
  const byId = new Map([['in/big.go', { lines: 900 }], ['in/door.go', { lines: 20 }]])

  it('바깥에서 많이 불리는 것을 먼저 낸다 — 크기가 아니라', () => {
    const paths = ['in/big.go', 'in/door.go', 'in/quiet.go']
    const edges = [E('out/a.go', 'in/door.go'), E('out/b.go', 'in/door.go')]
    const d = frontDoor(paths, edges, byId)
    assert.equal(d.ids[0], 'in/door.go', '900줄짜리가 앞에 왔다')
    assert.equal(d.calledFrom['in/door.go'], 2)
    // 셋 중 하나만 바깥에서 불린다 — 근거도 그렇게 적혀야 한다
    assert.match(d.why, /1개는 바깥에서 부르는 수/)
  })

  it('묶음 안끼리 부르는 것은 안 센다 — 그건 문이 아니라 내부다', () => {
    const paths = ['in/a.go', 'in/b.go']
    const edges = [E('in/a.go', 'in/b.go'), E('in/a.go', 'in/b.go')]
    assert.equal(frontDoor(paths, edges, byId).why, '바깥에서 부르는 곳이 없어 크기 순')
  })

  it('🔴 근거가 약하면 약하다고 적는다', () => {
    // 내부 전용 묶음은 순위의 근거가 없다. 있는 척하면 그게 거짓말이다.
    const d = frontDoor(['in/a.go', 'in/b.go'], [], byId)
    assert.match(d.why, /크기 순/)
  })

  it('한 번에 여는 수를 제한하고 전체 수를 알려준다', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `in/f${i}.go`)
    const d = frontDoor(paths, [], new Map(), { limit: 4 })
    assert.equal(d.ids.length, 4)
    assert.equal(d.total, 50, '몇 개 중 몇 개인지 안 알려주면 전부 본 줄 안다')
  })

  it('테스트·예제는 현관문이 못 된다', () => {
    const paths = ['in/a_test.go', 'in/testdata/x.go', 'in/real.go']
    assert.deepEqual(frontDoor(paths, [], new Map()).ids, ['in/real.go'])
  })

  it('전부 테스트뿐이면 그거라도 낸다 — 빈 화면보다 낫다', () => {
    const paths = ['in/a_test.go', 'in/b_test.go']
    assert.equal(frontDoor(paths, [], new Map()).ids.length, 2)
  })

  it('묶음 이름이 why 로 들어간다 — 개념이 쌓이려면 이름이 있어야 한다', () => {
    const edges = [E('out/a.go', 'in/door.go')]
    const { importers } = ctx(edges)
    const r = revealFeature(emptyReveal(), { name: 'SBOM 생성', paths: ['in/door.go'] },
      { edges, importers })
    assert.equal(r.state.at['in/door.go'].why, 'SBOM 생성')
  })

  /**
   * 🔴 실측으로 잡은 것. click 에서 `click` 묶음을 누르면 현관문 6개를 고르는데
   *    그중 5개가 이미 화면에 있어서 실제로 는 것은 1개였고, 우리 저장소에서는
   *    6개 중 6개가 이미 열려 있어 **눌러도 아무 일도 안 났다.**
   *
   *    현관문은 "많이 불리는 파일" 이고 그건 import 사슬로도 먼저 닿는 파일이다.
   *    두 축이 같은 것을 고르는 게 정상이므로, 안 빼면 개념 축이 있으나 마나다 —
   *    import 로 못 가는 곳을 열려고 만든 축인데 정작 이미 간 곳만 다시 연다.
   */
  it('이미 열린 것은 현관문 후보에서 빠진다', () => {
    const edges = [E('out/x.go', 'in/a.go'), E('out/y.go', 'in/a.go'), E('out/z.go', 'in/b.go')]
    const { importers } = ctx(edges)
    // a 를 먼저 봤다 (import 사슬로 닿았다고 치자)
    const s = reveal(emptyReveal(), ['in/a.go'], { why: '진입점', importers })
    const r = revealFeature(s, { name: '묶음', paths: ['in/a.go', 'in/b.go', 'in/c.go'] },
      { edges, importers, limit: 2 })
    assert.ok(!r.door.ids.includes('in/a.go'), '이미 열린 a 가 또 뽑혔다')
    assert.equal(r.door.already, 1)
    // 고른 수와 실제로 는 수가 같아야 한다 — 다르면 화면이 거짓말을 한다
    assert.equal(r.state.order.length - s.order.length, r.door.ids.length)
  })

  it('묶음이 이미 다 열려 있으면 그렇게 말한다 — 0개를 열고 침묵하지 않는다', () => {
    const edges = [E('out/x.go', 'in/a.go')]
    const { importers } = ctx(edges)
    const s = reveal(emptyReveal(), ['in/a.go'], { why: '진입점', importers })
    const r = revealFeature(s, { name: '묶음', paths: ['in/a.go'] }, { edges, importers })
    assert.deepEqual(r.door.ids, [])
    assert.equal(r.door.already, 1)
    assert.equal(r.door.why, '이 묶음은 이미 다 열려 있다')
  })

  it('개념을 열어도 이미 놓인 것은 안 움직인다', () => {
    const edges = [E('a', 'b')]
    const { importers } = ctx(edges)
    let s = reveal(emptyReveal(), ['a'], { why: '진입점', importers })
    s = reveal(s, ['b'], { why: 'y', parent: 'a', importers })
    const before = pos(s)
    const r = revealFeature(s, { name: '다른 개념', paths: ['z1', 'z2'] }, { edges, importers })
    for (const k of Object.keys(before)) assert.equal(pos(r.state)[k], before[k], `${k} 가 움직였다`)
  })
})

describe('🔴 근거는 낸 것에 대해서만 말한다', () => {
  /**
   * 실측(syft)에서 5개 중 2개만 바깥에서 불리고 나머지는 크기로 뽑혔는데
   * 화면은 다섯 줄 전부에 "바깥에서 부르는 수" 를 붙였다.
   * 반은 맞고 반은 틀린 설명은 전부 틀린 설명이다 — 읽는 사람이 어느 줄이
   * 어느 근거인지 가릴 수 없기 때문이다.
   */
  it('일부만 불리면 몇 개인지 적는다', () => {
    const paths = ['in/a.go', 'in/b.go', 'in/c.go']
    const edges = [E('out/x.go', 'in/a.go')]
    const d = frontDoor(paths, edges, new Map(), { limit: 3 })
    assert.match(d.why, /1개는 바깥에서 부르는 수/)
    assert.match(d.why, /나머지는 크기 순/)
  })

  it('전부 불리면 단순하게 적는다', () => {
    const paths = ['in/a.go', 'in/b.go']
    const edges = [E('out/x.go', 'in/a.go'), E('out/y.go', 'in/b.go')]
    assert.equal(frontDoor(paths, edges, new Map()).why, '바깥에서 부르는 수')
  })

  it('한도에 잘려서 안 나온 것은 근거 계산에 안 넣는다', () => {
    // 낸 것에 대해서만 말한다 — 안 낸 파일이 근거 문구를 바꾸면 안 된다
    const paths = ['in/a.go', 'in/b.go', 'in/c.go']
    const edges = [E('out/x.go', 'in/a.go'), E('out/y.go', 'in/b.go')]
    assert.equal(frontDoor(paths, edges, new Map(), { limit: 2 }).why, '바깥에서 부르는 수')
  })
})

describe('🔴 첫 클릭이 벽이 되지 않게', () => {
  /**
   * 예고만으로는 모자랐다. axMap 자신에서 진입점을 한 번 누르면 17개가
   * 한꺼번에 쏟아진다. "+17개" 라고 미리 알려주지만 **알고도 할 수 있는
   * 것이 없다** — 누르거나 안 누르거나 둘뿐이다. 그건 선택이 아니다.
   */
  const many = ['a', ...Array.from({ length: 17 }, (_, i) => `k${i}.go`)]
  const edges = Array.from({ length: 17 }, (_, i) => E('a', `k${i}.go`))
  const { importers, calls } = ctx(edges)
  const s = reveal(emptyReveal(), ['a'], { why: '진입점', importers })

  it('한 번에 여는 수를 자르고 남은 수를 낸다', () => {
    const pv = preview(s, 'a', calls, { limit: 6 })
    assert.equal(pv.count, 17)
    assert.equal(pv.ids.length, 6)
    assert.equal(pv.more, 11, '자른 것을 숨기면 전부 본 줄 안다')
  })

  it('많이 여는 것부터', () => {
    // 큰 파일이 중요한 파일은 아니다 — importTree 에서 배운 것과 같다
    const es = [E('a', 'hub'), E('a', 'leaf'), E('hub', 'x'), E('hub', 'y')]
    const c = ctx(es)
    const st = reveal(emptyReveal(), ['a'], { why: 'x', importers: c.importers })
    assert.equal(preview(st, 'a', c.calls, { limit: 1 }).ids[0], 'hub')
  })

  it('테스트·예제는 많이 열어도 뒤로', () => {
    const es = [E('a', 'big_test.go'), E('a', 'real.go'),
      E('big_test.go', 'p'), E('big_test.go', 'q'), E('big_test.go', 'r')]
    const c = ctx(es)
    const st = reveal(emptyReveal(), ['a'], { why: 'x', importers: c.importers })
    assert.equal(preview(st, 'a', c.calls, { limit: 1 }).ids[0], 'real.go')
  })

  it('어느 영역이 열리는지 함께 낸다', () => {
    // 벽이라고 느끼게 하는 것은 개수보다 구별이 안 되는 이름들이다
    const es = [E('a', 'lib/x.go'), E('a', 'lib/y.go'), E('a', 'src/z.go')]
    const c = ctx(es)
    const st = reveal(emptyReveal(), ['a'], { why: 'x', importers: c.importers })
    assert.deepEqual(preview(st, 'a', c.calls).dirs, [{ dir: 'lib', n: 2 }, { dir: 'src', n: 1 }])
  })

  it('자른 것은 사라지지 않는다 — 다시 누르면 이어서 열린다', () => {
    let st = s
    const first = preview(st, 'a', calls, { limit: 6 })
    st = reveal(st, first.ids, { why: 'a 가 부르는 것', parent: 'a', importers })
    const second = preview(st, 'a', calls, { limit: 6 })
    assert.equal(second.count, 11, '이미 연 것은 후보에서 빠진다')
    assert.equal(second.ids.filter((x) => first.ids.includes(x)).length, 0)
  })

  it('다 열렸으면 0을 내고 침묵하지 않는다', () => {
    let st = s
    st = reveal(st, calls.get('a'), { why: 'x', parent: 'a', importers })
    const pv = preview(st, 'a', calls)
    assert.equal(pv.count, 0)
    assert.deepEqual(pv.ids, [])
  })
})
