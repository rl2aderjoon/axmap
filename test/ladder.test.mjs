import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ladder, groupDir, isAux, pathBetween } from '../app/lib/ladder.mjs'
import { layersFrom } from '../app/lib/flow.mjs'

const N = (id, lines = 10) => ({ id, lines })
const E = (source, target, extra = {}) => ({ source, target, directed: true, ...extra })

describe('groupDir', () => {
  it('위에서 두 마디까지 묶는다', () => {
    assert.equal(groupDir('cmd/syft/main.go'), 'cmd/syft')
    assert.equal(groupDir('syft/pkg/cataloger/go/a.go'), 'syft/pkg')
  })
  it('마디가 모자라면 있는 만큼만', () => {
    assert.equal(groupDir('internal/a.go'), 'internal')
  })
  it('루트 파일은 (루트) 로 묶는다', () => {
    // 빈 문자열로 묶으면 화면에 이름 없는 칸이 생긴다
    assert.equal(groupDir('go.mod'), '(루트)')
  })
})

describe('isAux — 테스트·예제', () => {
  it('테스트 파일을 알아본다', () => {
    for (const p of ['a/foo_test.go', 'test_thing.py', 'src/x.test.js', 'lib/y_spec.rb']) {
      assert.equal(isAux(p), true, p)
    }
  })
  it('디렉터리로도 알아본다', () => {
    for (const p of ['testdata/a.json', 'examples/demo.go', 'spec/x.rb', 'internal/mocks/m.go']) {
      assert.equal(isAux(p), true, p)
    }
  })
  it('본 코드를 테스트로 오인하지 않는다', () => {
    // 🔴 과하게 잡으면 정작 읽어야 할 것이 뒤로 밀린다
    for (const p of ['syft/pkg/cataloger.go', 'cmd/syft/main.go', 'internal/latest.go', 'contest/a.go']) {
      assert.equal(isAux(p), false, p)
    }
  })
  it('테스트는 많이 열어도 뒤로 간다', () => {
    // syft 2겹 1위가 cataloger_test.go(31개 엶)였다. 테스트는 많이 import 한다.
    const ns = [N('m.go'), N('p/a_test.go'), N('p/real.go'), N('p/x.go'), N('p/y.go'), N('p/z.go')]
    const es = [E('m.go', 'p/a_test.go'), E('m.go', 'p/real.go'),
      E('p/a_test.go', 'p/x.go'), E('p/a_test.go', 'p/y.go'), E('p/a_test.go', 'p/z.go')]
    const r = ladder(ns, es, ['m.go'])
    const files = r.layers[1].groups[0].files
    assert.equal(files[0].path, 'p/real.go', '테스트가 아닌 것이 먼저다')
    assert.equal(files.at(-1).path, 'p/a_test.go')
    assert.equal(files.at(-1).aux, true, '왜 뒤에 있는지 화면이 말할 수 있어야 한다')
  })
})

describe('ladder — 층', () => {
  const nodes = [N('a.go'), N('b.go'), N('c.go'), N('d.go')]
  const edges = [E('a.go', 'b.go'), E('b.go', 'c.go'), E('a.go', 'd.go')]

  it('진입점이 0겹이다', () => {
    const r = ladder(nodes, edges, ['a.go'])
    assert.equal(r.layers[0].depth, 0)
    assert.deepEqual(r.layers[0].groups[0].files.map((f) => f.path), ['a.go'])
  })

  it('한 겹씩 내려간다', () => {
    const r = ladder(nodes, edges, ['a.go'])
    assert.deepEqual(r.layers.map((l) => l.depth), [0, 1, 2])
    assert.deepEqual(r.layers[1].groups[0].files.map((f) => f.path).sort(), ['b.go', 'd.go'])
    assert.deepEqual(r.layers[2].groups[0].files.map((f) => f.path), ['c.go'])
  })

  it('누가 불렀는지를 칸마다 들고 있다', () => {
    // 🔴 변형 ① 에서 결정적이었던 정보다. 층만 알려주면 "무엇이 무엇을
    //    부르나" 를 사람이 다시 추측해야 한다.
    const r = ladder(nodes, edges, ['a.go'])
    const c = r.layers[2].groups[0].files[0]
    assert.equal(c.from, 'b.go')
  })

  it('시작점의 from 은 null 이다', () => {
    const r = ladder(nodes, edges, ['a.go'])
    assert.equal(r.layers[0].groups[0].files[0].from, null)
  })

  it('여는 파일 수(opens)를 센다', () => {
    const r = ladder(nodes, edges, ['a.go'])
    const one = r.layers[1].groups[0].files
    const b = one.find((f) => f.path === 'b.go')
    const d = one.find((f) => f.path === 'd.go')
    assert.equal(b.opens, 2, 'b 는 자기 + c')
    assert.equal(d.opens, 1)
  })

  it('많이 여는 것을 위에 둔다 — 큰 것이 아니라', () => {
    // 🔴 줄 수로 정렬하면 큰 곁가지가 본류를 밀어낸다 (importTree 와 같은 판단)
    const ns = [N('a.go'), N('big.go', 900), N('hub.go', 10), N('x.go'), N('y.go')]
    const es = [E('a.go', 'big.go'), E('a.go', 'hub.go'), E('hub.go', 'x.go'), E('hub.go', 'y.go')]
    const r = ladder(ns, es, ['a.go'])
    assert.equal(r.layers[1].groups[0].files[0].path, 'hub.go')
  })
})

describe('ladder — 묶음', () => {
  it('같은 겹 안에서 최상위 디렉터리로 묶는다', () => {
    const ns = [N('main.go'), N('cmd/a.go'), N('cmd/b.go'), N('lib/c.go')]
    const es = [E('main.go', 'cmd/a.go'), E('main.go', 'cmd/b.go'), E('main.go', 'lib/c.go')]
    const r = ladder(ns, es, ['main.go'])
    const g = r.layers[1].groups
    assert.deepEqual(g.map((x) => x.dir), ['cmd', 'lib'], '큰 묶음이 앞이다')
    assert.equal(g[0].count, 2)
  })

  it('묶음이 잘리면 몇 개 잘렸는지 낸다', () => {
    // 조용한 절단은 "전부 봤다" 로 읽힌다
    const ns = [N('m.go'), ...Array.from({ length: 10 }, (_, i) => N(`p/f${i}.go`))]
    const es = Array.from({ length: 10 }, (_, i) => E('m.go', `p/f${i}.go`))
    const r = ladder(ns, es, ['m.go'], { perGroup: 3 })
    assert.equal(r.layers[1].groups[0].files.length, 3)
    assert.equal(r.layers[1].groups[0].truncated, 7)
  })

  it('묶음 자체가 잘려도 말한다', () => {
    const ns = [N('m.go'), ...Array.from({ length: 5 }, (_, i) => N(`d${i}/f.go`))]
    const es = Array.from({ length: 5 }, (_, i) => E('m.go', `d${i}/f.go`))
    const r = ladder(ns, es, ['m.go'], { maxGroups: 2 })
    assert.equal(r.layers[1].groups.length, 2)
    assert.equal(r.layers[1].moreGroups, 3)
  })
})

describe('ladder — 안 닿는 것', () => {
  it('닿지 않은 파일을 분류해서 낸다', () => {
    const ns = [N('m.go'), N('x.go'), N('examples/e.go')]
    const r = ladder(ns, [E('m.go', 'x.go')], ['m.go'])
    assert.equal(r.unreached.count, 1)
    assert.ok(r.unreached.by.groups.length > 0)
  })

  it('시작점이 없으면 이유를 낸다 — 빈 결과를 결과로 내지 않는다', () => {
    const r = ladder([N('a.go')], [], ['없는파일.go'])
    assert.equal(r.layers.length, 0)
    assert.match(r.why, /시작점/)
  })
})

describe('🔴 ladder 와 layersFrom 은 같은 도달 규칙을 쓴다', () => {
  /**
   * 두 함수가 갈라지면 같은 화면의 두 곳(③ 안내록 / 사다리 뷰)이 같은 질문에
   * 다른 답을 준다. 코드를 합치는 대신 **계약을 못박는다** — 각자 필요한
   * 부수 정보가 다르므로 합치면 한쪽 요구가 다른 쪽을 조용히 끌고 간다.
   */
  const cases = [
    {
      name: '방향 있는 사슬',
      nodes: [N('a'), N('b'), N('c')],
      edges: [E('a', 'b'), E('b', 'c')],
      starts: ['a'],
    },
    {
      name: '방향 모르는 엣지는 양쪽으로 통과',
      nodes: [N('a'), N('b'), N('c')],
      edges: [E('a', 'b'), { source: 'c', target: 'b', directed: false }],
      starts: ['a'],
    },
    {
      name: '허브 경유는 세지 않는다',
      nodes: [N('a'), N('b')],
      edges: [E('a', 'b', { hub: true })],
      starts: ['a'],
    },
    {
      name: '공변경은 방향이 없으므로 세지 않는다',
      nodes: [N('a'), N('b')],
      edges: [E('a', 'b', { origin: 'cochange' })],
      starts: ['a'],
    },
    {
      name: '진입점이 여럿',
      nodes: [N('a'), N('b'), N('c'), N('d')],
      edges: [E('a', 'c'), E('b', 'd')],
      starts: ['a', 'b'],
    },
  ]

  for (const c of cases) {
    it(`${c.name} — 도달 수가 같다`, () => {
      const l = ladder(c.nodes, c.edges, c.starts)
      const f = layersFrom(c.nodes, c.edges, c.starts)
      assert.equal(l.reached, f.reached, '두 배치가 다른 파일 집합을 본다')
      assert.deepEqual(l.layers.map((x) => x.depth), f.layers.map((x) => x.depth), '겹 수가 다르다')
      for (let i = 0; i < f.layers.length; i++) {
        assert.equal(l.layers[i].count, f.layers[i].count, `${i}겹의 개수가 다르다`)
      }
    })
  }

  it('🔴 검사기가 실제로 어긋남을 잡는다', () => {
    // 한 번도 실패하지 않는 검사기는 검사기가 아니다 (CLAUDE.md)
    const nodes = [N('a'), N('b')]
    const l = ladder(nodes, [E('a', 'b')], ['a'])
    const f = layersFrom(nodes, [], ['a'])   // 일부러 엣지를 뺀다
    assert.notEqual(l.reached, f.reached)
  })
})

describe('0겹은 ②걸음의 답을 그대로 쓴다', () => {
  /**
   * 🔴 같은 질문에 두 화면이 다른 순서를 주면 신입은 어느 쪽을 믿을지 모른다.
   *
   * 실측: syft 에서 개수로 묶음을 정렬했더니 코드 생성기 4개가 든 `syft/pkg`가
   * 진짜 진입점 1개가 든 `cmd/syft` 위에 앉았다.
   */
  const ns = [N('cmd/app/main.go'), N('gen/a/main.go'), N('gen/b/main.go'), N('gen/c/main.go')]
  const starts = ['cmd/app/main.go', 'gen/a/main.go', 'gen/b/main.go', 'gen/c/main.go']

  it('묶음 순서가 시작점 순서를 따른다 — 개수가 아니라', () => {
    const r = ladder(ns, [], starts)
    assert.equal(r.layers[0].groups[0].dir, 'cmd/app', '개수로 정렬하면 gen 이 앞에 온다')
  })

  it('아래 겹은 개수 순이 맞다', () => {
    const ns2 = [N('m.go'), N('big/a.go'), N('big/b.go'), N('small/c.go')]
    const es2 = [E('m.go', 'big/a.go'), E('m.go', 'big/b.go'), E('m.go', 'small/c.go')]
    const r = ladder(ns2, es2, ['m.go'])
    assert.deepEqual(r.layers[1].groups.map((g) => g.dir), ['big', 'small'])
  })
})

describe('pathBetween — 두 파일 사이 (변형 ③)', () => {
  const nodes = [N('a.go'), N('b.go'), N('c.go'), N('d.go'), N('lonely.go')]
  const edges = [E('a.go', 'b.go'), E('b.go', 'c.go')]

  it('import 로 이어지면 순서대로 낸다', () => {
    const r = pathBetween(nodes, edges, 'a.go', 'c.go')
    assert.equal(r.found, true)
    assert.equal(r.via, 'import')
    assert.deepEqual(r.hops.map((h) => h.path), ['b.go', 'c.go'])
    assert.equal(r.hops[0].from, 'a.go')
    assert.equal(r.hops[1].from, 'b.go')
  })

  it('hop 마다 근거 종류를 들고 있다', () => {
    const r = pathBetween(nodes, edges, 'a.go', 'c.go')
    assert.ok(r.hops.every((h) => h.kind === 'import'))
  })

  it('같은 파일이면 빈 경로', () => {
    const r = pathBetween(nodes, edges, 'a.go', 'a.go')
    assert.equal(r.found, true)
    assert.deepEqual(r.hops, [])
  })

  it('없는 파일은 조용히 넘기지 않고 거부한다', () => {
    // fail-closed: 없는 파일을 무시하면 "경로 없음" 과 구분이 안 된다
    assert.equal(pathBetween(nodes, edges, '없다.go', 'c.go').found, false)
    assert.match(pathBetween(nodes, edges, '없다.go', 'c.go').why, /출발 파일/)
    assert.match(pathBetween(nodes, edges, 'a.go', '없다.go').why, /도착 파일/)
  })

  it('import 로 안 되면 함께 바뀐 기록으로 잇고 그렇다고 말한다', () => {
    const es = [E('a.go', 'b.go'),
      { source: 'b.go', target: 'd.go', origin: 'cochange', directed: false, support: 9, lift: 40 }]
    const r = pathBetween(nodes, es, 'a.go', 'd.go')
    assert.equal(r.found, true)
    assert.equal(r.via, 'mixed')
    assert.equal(r.cochangeHops, 1)
    assert.equal(r.hops.at(-1).kind, 'cochange')
    assert.equal(r.hops.at(-1).support, 9, '근거 세기를 화면에 낼 수 있어야 한다')
    assert.match(r.why, /호출 관계라는 뜻이 아니라/, '섞어놓고 뭉뚱그리면 거짓말이 된다')
  })

  it('🔴 import 로 갈 수 있으면 공변경 지름길을 쓰지 않는다', () => {
    // 더 길어도 import 가 강한 근거다. 짧은 것을 고르면 근거가 약해진다.
    const es = [E('a.go', 'b.go'), E('b.go', 'c.go'),
      { source: 'a.go', target: 'c.go', origin: 'cochange', directed: false, support: 20 }]
    const r = pathBetween(nodes, es, 'a.go', 'c.go')
    assert.equal(r.via, 'import')
    assert.equal(r.hops.length, 2, '한 단계짜리 공변경 지름길을 골랐다')
  })

  it('안 이어지면 반대 방향을 알려준다', () => {
    const r = pathBetween(nodes, edges, 'c.go', 'a.go')
    assert.equal(r.found, false)
    assert.ok(r.reverse, '반대로는 이어진다는 것이 "없다" 보다 훨씬 쓸모 있다')
    assert.equal(r.reverse.length, 2)
    assert.match(r.why, /반대 방향/)
  })

  it('정말로 없으면 왜 없을 수 있는지 말한다', () => {
    const r = pathBetween(nodes, edges, 'a.go', 'lonely.go')
    assert.equal(r.found, false)
    assert.equal(r.reverse, null)
    assert.match(r.why, /동적 로딩|설정 기반|패키지 수준/)
  })

  it('허브 경유로는 잇지 않는다', () => {
    // 허브를 타면 아무 두 파일이나 2단계로 이어진다 — 경로가 아니라 소음이다
    const es = [E('a.go', 'hub.go', { hub: true }), E('hub.go', 'd.go', { hub: true })]
    assert.equal(pathBetween([...nodes, N('hub.go')], es, 'a.go', 'd.go').found, false)
  })

  it('방향 모르는 연결의 수를 낸다', () => {
    const es = [{ source: 'a.go', target: 'b.go', directed: false, kind: 'import' }]
    const r = pathBetween(nodes, es, 'a.go', 'b.go')
    assert.equal(r.found, true)
    assert.equal(r.unknownDir, 1, '모르는 것을 아는 척하지 않는다')
  })
})

describe('공변경 다리는 함부로 놓지 않는다', () => {
  const nodes = [N('a.go'), N('b.go'), N('c.go'), N('d.go')]
  const CO = (source, target, lift, support) => ({ source, target, origin: 'cochange', directed: false, lift, support })

  it('🔴 모든 것과 함께 바뀌는 파일은 다리가 되지 못한다', () => {
    /**
     * 실측(syft): `go.mod` 은 91개 파일과 함께 바뀌는데 lift 가 0.1~2.9 다.
     * 안 걸렀더니 `main.go → go.mod → licenses.go → create_sbom.go` 가 나왔다.
     * 사실이 아니면서 그럴듯한, 가장 나쁜 종류의 답이다.
     */
    const es = [CO('a.go', 'gomod', 2.9, 40), CO('gomod', 'd.go', 2.1, 30)]
    const r = pathBetween([...nodes, N('gomod')], es, 'a.go', 'd.go')
    assert.equal(r.found, false, 'lift 가 우연 수준인 연결로 이었다')
  })

  it('표본이 모자라면 다리를 놓지 않는다', () => {
    assert.equal(pathBetween(nodes, [CO('a.go', 'd.go', 900, 1)], 'a.go', 'd.go').found, false)
  })

  it('🔴 공변경 다리는 하나까지만 — 전이적이지 않으므로', () => {
    /**
     * import 는 전이적이다("A가 B를 부르고 B가 C를 부르면 A는 C에 닿는다").
     * 공변경에는 그 성질이 없다. 두 번 이으면 추론이 아니라 연상이다.
     */
    const es = [CO('a.go', 'b.go', 50, 9), CO('b.go', 'd.go', 50, 9)]
    assert.equal(pathBetween(nodes, es, 'a.go', 'd.go').found, false)
  })

  it('다리 하나짜리는 놓는다', () => {
    const es = [E('a.go', 'b.go'), CO('b.go', 'd.go', 50, 9)]
    const r = pathBetween(nodes, es, 'a.go', 'd.go')
    assert.equal(r.found, true)
    assert.equal(r.cochangeHops, 1)
  })

  it('다리 앞뒤로 import 가 이어져도 된다', () => {
    // import* → 다리 하나 → import* 가 허용하는 모양이다
    const ns = [N('a.go'), N('b.go'), N('c.go'), N('d.go'), N('e.go')]
    const es = [E('a.go', 'b.go'), CO('b.go', 'c.go', 50, 9), E('c.go', 'd.go'), E('d.go', 'e.go')]
    const r = pathBetween(ns, es, 'a.go', 'e.go')
    assert.equal(r.found, true)
    assert.equal(r.cochangeHops, 1)
    assert.deepEqual(r.hops.map((h) => h.kind), ['import', 'cochange', 'import', 'import'])
  })
})

describe('못 이으면 도착지의 발판을 준다', () => {
  const nodes = [N('a.go'), N('b.go'), N('t.go'), N('x.go')]

  it('도착지로 들어오는 연결을 낸다', () => {
    // 🔴 "경로 없음" 은 정직하지만 쓸모가 없다. 관찰자가 두 회차 연속
    //    같은 자리에서 "모른다" 로 끝냈다. 거꾸로 올라갈 발판을 준다.
    const es = [E('b.go', 't.go'),
      { source: 'x.go', target: 't.go', origin: 'cochange', directed: false, lift: 90, support: 7 }]
    const r = pathBetween(nodes, es, 'a.go', 't.go')
    assert.equal(r.found, false)
    assert.deepEqual(r.inbound.map((i) => i.path), ['b.go', 'x.go'], 'import 가 먼저다')
    assert.equal(r.inbound[0].kind, 'import')
    assert.match(r.why, /거꾸로 올라가세요/)
  })

  it('발판이 없으면 있다고 하지 않는다', () => {
    const r = pathBetween(nodes, [E('a.go', 'b.go')], 'a.go', 't.go')
    assert.deepEqual(r.inbound, [])
    assert.doesNotMatch(r.why, /거꾸로/)
  })

  it('자기 자신은 발판이 아니다', () => {
    const r = pathBetween(nodes, [E('t.go', 't.go')], 'a.go', 't.go')
    assert.deepEqual(r.inbound, [])
  })
})

describe('발판 목록도 테스트·예제를 뒤로 보낸다', () => {
  it('실측: testdata 아래 껍데기가 진짜 사용처를 밀어냈다', () => {
    const nodes = [N('a.go'), N('t.go'), N('real.go'), N('testdata/x/fake.go')]
    const es = [E('testdata/x/fake.go', 't.go'), E('real.go', 't.go')]
    const r = pathBetween(nodes, es, 'a.go', 't.go')
    assert.deepEqual(r.inbound.map((i) => i.path), ['real.go', 'testdata/x/fake.go'])
  })
})
