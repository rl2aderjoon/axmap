/**
 * 사다리 — 힘 그래프를 대신하는 배치.
 *
 * 🔴 왜 만드는가.
 *
 * 온보딩 실험에서 여섯 회차 연속 같은 말이 나왔다. 오른쪽 3D 힘 그래프는
 * **장식**이라는 것이다. 그대로 옮기면:
 *
 *   - "노드가 계속 움직여서 클릭이 빗나간다"
 *   - "점이 700개 엉켜 있는데 무엇이 무엇인지 알 수 없다"
 *   - "위치가 무엇을 뜻하는지 모르겠다. 가까우면 뭔데?"
 *   - "결국 왼쪽 안내록만 읽고 그래프는 한 번도 안 봤다"
 *
 * 마지막 줄이 핵심이다. 성공한 회차들은 전부 **왼쪽 글**로 이해에 도달했다.
 * 변형 ①(호출 사슬)이 M3 도달을 31호출 → 9~10호출로 줄인 이유도 같다 —
 * 그림이 아니라 **읽을 수 있는 순서**를 줬기 때문이다.
 *
 * 그렇다면 오른쪽 넓은 자리를 힘 그래프가 계속 차지할 이유가 없다.
 * 같은 데이터를 **아무것도 움직이지 않는 배치**로 그린다:
 *
 *   - 세로 = 진입점에서 몇 겹 안쪽인가 (위치에 뜻이 있다)
 *   - 가로 = 같은 겹 안에서 디렉터리별 묶음
 *   - 모든 칸에 이름이 적혀 있고, 좌표가 고정이라 클릭이 빗나가지 않는다
 *
 * 힘 그래프를 지우지는 않는다. 둘 다 두고 어느 쪽이 빠른지 **재는 것**이
 * 이번 회차의 목적이다.
 *
 * 순수 함수만 둔다 — git 도 fs 도 시계도 없다 (CLAUDE.md).
 */

import { classifyUnreached } from './flow.mjs'

/**
 * 묶음 이름 — 위에서 두 마디까지.
 *
 * 🔴 최상위 한 마디로 묶었더니 syft 에서 `syft/` 하나가 한 겹의 50개를
 *    삼켰다. 묶음이 "그 파일이 어느 영역인가" 를 말해야 하는데 저장소
 *    이름을 반복할 뿐이었다. 반대로 부모 디렉터리 전체로 묶으면
 *    `syft/pkg/cataloger/golang` 같은 1개짜리 묶음이 수십 개 생긴다.
 *
 *    두 마디가 실측에서 맞았다 — `syft/pkg`, `syft/internal`, `cmd/syft`.
 *    저장소마다 다르겠지만, 한 마디는 늘 너무 굵고 전체는 늘 너무 가늘다.
 */
export function groupDir(p) {
  const seg = p.split('/')
  if (seg.length <= 1) return '(루트)'
  return seg.slice(0, Math.min(2, seg.length - 1)).join('/')
}

/**
 * 테스트·예제·생성물인가.
 *
 * 🔴 정렬에서 뒤로 보내려고 판정한다. **테스트는 많은 것을 import 하므로
 *    "여는 파일 수" 정렬에서 1등을 한다.** syft 실측에서 2겹 1위가
 *    `cataloger_test.go`(31개 엶)였다. 신입이 두 번째로 읽을 파일이
 *    테스트일 리가 없는데, 순위는 그렇게 말하고 있었다.
 *
 *    지우지는 않는다 — 테스트는 그 코드가 무엇을 하는지 보여주는 가장
 *    정직한 문서이기도 하다. 순서만 뒤로 보내고 화면에 그렇다고 적는다.
 */
export function isAux(p) {
  return /(^|\/)(testdata|examples?|tests?|spec|fixtures?|benchmarks?|mocks?)(\/|$)/i.test(p)
    || /(^|\/)(test_[^/]+|[^/]+_test|[^/]+\.test|[^/]+_spec|[^/]+\.spec)\.[^/.]+$/i.test(p)
    || /\.(pb|gen|generated)\.[^/.]+$/i.test(p)
}

/**
 * 진입점에서 내려가는 층을 만든다.
 *
 * `layersFrom` 과 **같은 도달 규칙**을 쓴다(허브 제외·공변경 제외·방향 모르면
 * 양쪽). 두 함수가 서로 다른 답을 내면 같은 화면 두 곳이 다른 말을 하게 된다.
 * 그래서 `test/ladder.test.mjs` 가 둘의 도달 수가 같은지 못박는다.
 *
 * `layersFrom` 을 그대로 부르지 않는 이유는 여기서는 **누가 불렀는가(from)**와
 * **그 가지가 여는 파일 수(opens)**가 더 필요하기 때문이다. 앞의 것은 화면에
 * 적어야 하고(변형 ①에서 이게 결정적이었다), 뒤의 것은 정렬 근거다.
 */
export function ladder(nodes, edges, starts, { perGroup = 8, maxGroups = 6 } = {}) {
  const have = new Set(nodes.map((n) => n.id))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seeds = starts.filter((s) => have.has(s))

  const out = new Map()
  const push = (a, b) => {
    if (!out.has(a)) out.set(a, new Set())
    out.get(a).add(b)
  }
  for (const e of edges) {
    if (e.hub) continue
    if (e.origin === 'cochange') continue
    if (!have.has(e.source) || !have.has(e.target)) continue
    push(e.source, e.target)
    if (e.directed === false) push(e.target, e.source)
  }

  const depth = new Map()
  const parent = new Map()
  for (const s of seeds) { depth.set(s, 0); parent.set(s, null) }
  let frontier = [...seeds]
  let d = 0
  while (frontier.length) {
    d++
    const next = []
    for (const a of frontier) {
      for (const b of out.get(a) ?? []) {
        if (depth.has(b)) continue
        depth.set(b, d); parent.set(b, a); next.push(b)
      }
    }
    frontier = next
  }

  // 이 가지가 여는 파일 수. 큰 파일이 아니라 **많이 여는 파일**을 위에 둔다
  // (importTree 가 자식 정렬에서 내린 것과 같은 판단).
  const kids = new Map()
  for (const [c, p] of parent) { if (p !== null) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(c) } }
  const sub = new Map()
  const opensOf = (id) => {
    if (sub.has(id)) return sub.get(id)
    sub.set(id, 1)
    let n = 1
    for (const c of kids.get(id) ?? []) n += opensOf(c)
    sub.set(id, n)
    return n
  }
  for (const id of parent.keys()) opensOf(id)

  const byDepth = new Map()
  for (const [id, dd] of depth) {
    if (!byDepth.has(dd)) byDepth.set(dd, [])
    byDepth.get(dd).push(id)
  }

  const cell = (id) => ({
    path: id,
    lines: byId.get(id)?.lines ?? 0,
    opens: sub.get(id) ?? 1,
    from: parent.get(id) ?? null,
    // 화면이 "왜 이게 아래에 있나" 를 말할 수 있어야 한다
    aux: isAux(id),
  })

  const layers = [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([dd, ids]) => {
    const g = new Map()
    for (const id of ids) {
      const k = groupDir(id)
      if (!g.has(k)) g.set(k, [])
      g.get(k).push(id)
    }
    const groups = [...g.entries()]
      .map(([dir, list]) => {
        // 0겹만은 ②가 정한 순서를 그대로 쓴다 — layersFrom 이 같은 이유로
        // 같은 예외를 둔다. 같은 질문에 두 화면이 다른 순서를 주면 안 된다.
        const sorted = dd === 0
          ? seeds.filter((p) => list.includes(p))
          : [...list].sort((a, b) =>
              // 테스트·예제가 먼저다 → 아니다. 많이 열어도 뒤로 보낸다.
              (isAux(a) ? 1 : 0) - (isAux(b) ? 1 : 0)
              || (sub.get(b) ?? 1) - (sub.get(a) ?? 1)
              || (byId.get(b)?.lines ?? 0) - (byId.get(a)?.lines ?? 0) || (a < b ? -1 : 1))
        return {
          dir,
          count: sorted.length,
          files: sorted.slice(0, perGroup).map(cell),
          truncated: Math.max(0, sorted.length - perGroup),
        }
      })
      /**
       * 🔴 0겹의 묶음 순서도 ②가 정한다.
       *
       * 개수로 정렬했더니 syft 에서 `syft/pkg`(코드 생성기 4개)가
       * `cmd/syft`(진짜 진입점 1개) 위에 앉았다. 파일 순서는 ②를 지키게
       * 해놨는데 묶음 순서가 그걸 도로 뒤집은 것이다. 신입은 묶음을 먼저 본다.
       *
       * 아래 겹은 개수가 맞다 — 거기서는 "어느 영역이 두꺼운가" 가 읽는 순서다.
       */
      .sort((a, b) => (dd === 0
        ? seeds.indexOf(a.files[0]?.path) - seeds.indexOf(b.files[0]?.path)
        : b.count - a.count) || (a.dir < b.dir ? -1 : 1))
    return {
      depth: dd,
      count: ids.length,
      groups: groups.slice(0, maxGroups),
      moreGroups: Math.max(0, groups.length - maxGroups),
    }
  })

  const reachedSet = new Set(depth.keys())
  const unreachedIds = nodes.map((n) => n.id).filter((id) => !reachedSet.has(id))

  return {
    starts: seeds,
    layers,
    reached: depth.size,
    total: nodes.length,
    maxDepth: Math.max(0, d - 1),
    unreached: { count: unreachedIds.length, by: classifyUnreached(unreachedIds) },
    // 조용히 빈 결과를 결과로 내지 않는다 (fail-closed).
    why: seeds.length ? null : '시작점이 그래프에 없다 — 진입점부터 정해야 한다',
  }
}

/* ── 변형 ③ — 두 파일 사이 경로 ────────────────────────────────────── */

/**
 * A 에서 B 까지 어떻게 이어지나.
 *
 * 🔴 변형 ① 벤치마크가 정확히 여기서 멈췄다. 관찰자의 말을 그대로 옮기면:
 *
 *    "정작 '진입점에서 기능까지'의 핵심 연결(scan→create_sbom)은 스스로
 *     안 보여주고 사용자가 파일명을 추측해 검색해야 하는 구멍이 있다."
 *
 *    사슬 뷰(①)는 **위에서 아래로 펴는** 것이라 목적지를 정해두고 묻지
 *    못한다. 사다리(②)도 마찬가지다 — 어디에 무엇이 있는지는 보여주지만
 *    "그래서 여기서 저기까지 어떻게 가나" 는 여전히 사람이 이어야 한다.
 *
 * 🔴 그리고 여기가 이 저장소의 논지가 실제로 값을 내는 자리다.
 *
 *    `scan.go` → `create_sbom.go` 는 **정적 import 그래프에 없다.**
 *    `syft.CreateSBOM(...)` 은 패키지 수준 호출이라 파일 단위 import 로는
 *    안 잡힌다. 정적 분석만 하는 도구는 여기서 "경로 없음" 을 내고 끝이다.
 *    그건 사실이지만 쓸모가 없고, 신입에게는 거짓말처럼 느껴진다.
 *
 *    우리에게는 두 번째 자료가 있다 — **함께 바뀐 기록**. import 로 못 이으면
 *    히스토리로 이어보고, **그 경로가 어느 근거로 이어졌는지 hop 마다 적는다.**
 *    섞어놓고 뭉뚱그리면 그게 곧 거짓말이 된다.
 */
/**
 * @param maxBridges 공변경 hop 을 몇 개까지 허용하나.
 *
 * 🔴 **공변경은 전이적이지 않다.** A·B 가 함께 바뀌고 B·C 가 함께 바뀐다고
 *    A 와 C 가 관계있는 것이 아니다. import 는 전이적이지만("A가 B를 부르고
 *    B가 C를 부르면 A는 C에 닿는다") 공변경은 그런 성질이 없다.
 *
 *    그래서 다리는 **하나까지**만 놓는다. 정적 파싱이 끊긴 자리 한 곳을
 *    히스토리로 잇는 것은 근거가 있지만, 두 번 이으면 그건 추론이 아니라
 *    연상이다. 실제로 두 번 허용했을 때 나온 경로가 앞의 go.mod 사례다.
 */
function bfsPath(adj, from, to, maxHops, maxBridges = 0) {
  if (from === to) return []
  // 상태는 (파일, 지금까지 쓴 다리 수) 다. 같은 파일이라도 다리를 덜 쓰고
  // 도착했으면 다시 볼 값이 있다.
  const key = (id, b) => `${b}\u0000${id}`
  const prev = new Map([[key(from, 0), null]])
  let frontier = [{ id: from, b: 0 }]
  for (let d = 0; d < maxHops && frontier.length; d++) {
    const next = []
    for (const { id: a, b } of frontier) {
      for (const e of adj.get(a) ?? []) {
        const nb = b + (e.kind === 'cochange' ? 1 : 0)
        if (nb > maxBridges) continue
        if (prev.has(key(e.to, nb))) continue
        prev.set(key(e.to, nb), { from: a, fb: b, e })
        if (e.to === to) {
          const hops = []
          let cur = e.to
          let cb = nb
          while (prev.get(key(cur, cb))) {
            const { from: f, fb, e: ed } = prev.get(key(cur, cb))
            hops.unshift({ path: cur, from: f, kind: ed.kind, directed: ed.directed, support: ed.support, lift: ed.lift })
            cur = f; cb = fb
          }
          return hops
        }
        next.push({ id: e.to, b: nb })
      }
    }
    frontier = next
  }
  return null
}

/**
 * 공변경 다리의 최소 조건.
 *
 * 🔴 lift 는 "우연보다 몇 배 자주 함께 바뀌나" 다. 1 이면 무관하다는 뜻이다.
 *    실측(syft): `go.mod` 은 91개 파일과 함께 바뀌는데 lift 가 0.1~2.9 다 —
 *    **모든 것과 함께 바뀌므로 어느 것과도 관계없다.** 그런데 처음에는 이걸
 *    안 걸러서 `main.go → go.mod → licenses.go → create_sbom.go` 라는 경로가
 *    나왔다. 사실이 아니면서 그럴듯한, 가장 나쁜 종류의 답이다.
 *
 *    5배는 통계적 진술이지 손으로 고른 숫자가 아니다 — "우연의 다섯 배"다.
 *    같은 저장소의 공변경 lift 중앙값이 30이므로 넉넉히 낮은 문턱이고,
 *    go.mod 의 최대치(2.9)보다는 확실히 위다.
 */
const BRIDGE_MIN_LIFT = 5
const BRIDGE_MIN_SUPPORT = 3

function pathAdj(nodes, edges, { cochange }) {
  const have = new Set(nodes.map((n) => n.id))
  const adj = new Map()
  const add = (a, b, e, kind) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a).push({ to: b, kind, directed: e.directed !== false, support: e.support, lift: e.lift })
  }
  for (const e of edges) {
    // 허브를 타면 아무 두 파일이나 2단계로 이어진다. 경로가 아니라 소음이다.
    if (e.hub) continue
    if (!have.has(e.source) || !have.has(e.target)) continue
    const isCo = e.origin === 'cochange'
    if (isCo && !cochange) continue
    // 약한 공변경은 다리가 되지 못한다. 위 주석의 go.mod 사례.
    if (isCo && !((e.lift ?? 0) >= BRIDGE_MIN_LIFT && (e.support ?? 0) >= BRIDGE_MIN_SUPPORT)) continue
    const kind = isCo ? 'cochange' : 'import'
    add(e.source, e.target, e, kind)
    // 공변경은 방향이 없다. import 도 방향을 모르면 양쪽으로 두되
    // 화면이 "모른다" 고 말할 수 있게 directed 를 그대로 들고 간다.
    if (isCo || e.directed === false) add(e.target, e.source, e, kind)
  }
  return adj
}

export function pathBetween(nodes, edges, from, to, { maxHops = 12 } = {}) {
  const have = new Set(nodes.map((n) => n.id))
  // 애매하면 거부한다. 없는 파일을 조용히 무시하면 "경로 없음" 과 구분이 안 된다.
  if (!have.has(from)) return { from, to, found: false, why: `출발 파일이 그래프에 없습니다: ${from}` }
  if (!have.has(to)) return { from, to, found: false, why: `도착 파일이 그래프에 없습니다: ${to}` }
  if (from === to) return { from, to, found: true, via: 'import', hops: [], why: '같은 파일입니다' }

  const impAdj = pathAdj(nodes, edges, { cochange: false })

  // 1) import 만으로 이어지나. 가장 강한 근거이므로 더 길어도 이쪽이 먼저다.
  const imp = bfsPath(impAdj, from, to, maxHops)
  if (imp) {
    return {
      from, to, found: true, via: 'import', hops: imp,
      unknownDir: imp.filter((h) => !h.directed).length,
      why: null,
    }
  }

  // 2) 안 되면 함께 바뀐 기록까지 섞는다. **어느 hop 이 어느 근거인지 표시한다.**
  const mixed = bfsPath(pathAdj(nodes, edges, { cochange: true }), from, to, maxHops, 1)
  if (mixed) {
    return {
      from, to, found: true, via: 'mixed', hops: mixed,
      cochangeHops: mixed.filter((h) => h.kind === 'cochange').length,
      why: 'import 만으로는 이어지지 않습니다. 끊긴 한 곳을 함께 바뀐 기록으로 이었습니다 —'
        + ' 호출 관계라는 뜻이 아니라 같은 커밋에서 자주 함께 고쳐졌다는 뜻입니다.'
        + ' 패키지 수준 호출·동적 등록처럼 파일 단위 import 로는 안 잡히는 연결이 여기에 걸립니다.'
        + ' 공변경은 전이적이지 않으므로 이런 다리는 한 번만 놓습니다.',
    }
  }

  // 3) 그래도 없으면 반대 방향을 본다. "없다" 보다 "반대로는 있다" 가 훨씬 쓸모 있다.
  const back = bfsPath(impAdj, to, from, maxHops)

  /**
   * 4) 그래도 없으면 **목적지 쪽에서 한 걸음**을 준다.
   *
   * 🔴 "경로 없음" 은 정직하지만 쓸모가 없다. 벤치마크 관찰자가 두 회차 연속
   *    같은 자리에서 멈췄고, 두 번 다 "모른다" 로 보고했다. 정직한 실패지만
   *    실패는 실패다. 도착지에 들어오는 연결을 보여주면 거기서 거꾸로 올라갈
   *    수 있다 — 신입이 실제로 하는 일이 그것이다.
   *
   * 지어내지 않는다. 이미 관측한 이웃을 세기 순으로 낼 뿐이다.
   */
  const inbound = []
  for (const e of edges) {
    if (e.hub) continue
    const isCo = e.origin === 'cochange'
    const hitsTo = e.target === to || (isCo || e.directed === false ? e.source === to : false)
    if (!hitsTo) continue
    const other = e.source === to ? e.target : e.source
    if (!have.has(other) || other === to) continue
    inbound.push({ path: other, kind: isCo ? 'cochange' : 'import', support: e.support, lift: e.lift })
  }
  inbound.sort((a, b) =>
    (a.kind === 'import' ? 0 : 1) - (b.kind === 'import' ? 0 : 1)
    // 🔴 발판 목록에도 같은 규칙을 쓴다. 실측에서 testdata 아래 껍데기
    //    카탈로거들이 위로 올라왔다 — 진짜 사용처를 밀어내고서.
    || (isAux(a.path) ? 1 : 0) - (isAux(b.path) ? 1 : 0)
    || (b.lift ?? 0) - (a.lift ?? 0))

  return {
    from, to, found: false,
    reverse: back ? { hops: back, length: back.length } : null,
    // 여기서부터 거꾸로 올라가면 된다
    inbound: inbound.slice(0, 8),
    why: back
      ? `${from} 에서 ${to} 로는 이어지지 않습니다. 반대 방향으로는 ${back.length}단계로 이어집니다.`
      : `${maxHops}단계 안에서는 어느 방향으로도 이어지지 않습니다.`
        + ' 정적 파싱이 못 보는 연결(동적 로딩·설정 기반 등록·패키지 수준 호출)이거나,'
        + ' 정말로 무관한 두 파일입니다.'
        + (inbound.length ? ' 대신 도착지로 들어오는 연결을 아래에 냅니다 — 거기서 거꾸로 올라가세요.' : ''),
  }
}
