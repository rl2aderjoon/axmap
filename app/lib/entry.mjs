/**
 * 진입점 — "어디서부터 읽어야 하나".
 *
 * 왜 필요한가. 신입 온보딩 관찰에서 나온 지적이다.
 * 그래프가 전부 그려지는데 **무엇을 먼저 봐야 하는지는 아무도 말해주지 않는다.**
 * 노드 629개를 다 그리는 것은 "여기 다 있습니다" 이지 "여기부터 보세요" 가 아니다.
 *
 * 🔴 점수 하나로 줄 세우지 않는다.
 *
 * "중요도 = 0.4·빈도 + 0.3·연결도 + 0.3·크기" 같은 합성 점수를 만들고 싶은
 * 유혹이 크지만, 그 가중치를 정당화할 근거가 없다. 근거 없는 숫자로 순위를
 * 매기면 사용자는 그것이 측정값인 줄 안다 — 이 도구에서 가장 나쁜 실패다 (D5).
 *
 * 대신 **각각 다른 질문에 답하는 목록 넷**을 준다. 질문이 다르면 답도 다르고,
 * 사용자는 자기 상황에 맞는 질문을 고르면 된다.
 */

/**
 * @param {object} graph  build() 결과 {nodes, edges}
 * @param {object[]} overlayEdges  origin 이 붙은 엣지
 * @param {Object<string,number>} freq  파일별 등장 커밋 수
 */
export function entryPoints(graph, overlayEdges, freq, { limit = 12, isolatedMaxFreq = 5 } = {}) {
  // 🔴 정적 이웃과 공변경 이웃을 따로 센다.
  //
  // 예전에는 합계 하나만 셌다. 그러면 두 가지가 동시에 틀린다 —
  //   ① "고치면 파급이 큰 곳" 이 사실상 "같이 자주 바뀌는 곳" 이 된다.
  //      flask 에서 전체 781 엣지 중 568이 공변경이었다. 두 축을 나누는 것이
  //      이 도구의 핵심 주장인데 정작 진입 목록에서 합쳐져 있었다.
  //   ② "아무와도 안 이어진 곳" 의 설명문은 "정적 엣지 0개" 라고 적어놓고
  //      계산은 합계를 썼다. flask 에서 6개 전부 오탐이었고, 정작 진짜
  //      정적 고립인 `docs/conf.py`(커밋 78회)는 목록에서 빠졌다.
  //      설명과 계산이 다르면 설명이 거짓말이 된다.
  const degStatic = new Map()
  const hidden = new Map()
  for (const e of overlayEdges) {
    const isCo = e.origin === 'cochange'
    const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
    if (!isCo) { bump(degStatic, e.source); bump(degStatic, e.target) }
    else { bump(hidden, e.source); bump(hidden, e.target) }
  }

  const info = (n) => ({
    path: n.id,
    lines: n.lines,
    freq: freq[n.id] ?? 0,
    deg: degStatic.get(n.id) ?? 0,
    hidden: hidden.get(n.id) ?? 0,
  })
  const all = graph.nodes.map(info)

  const top = (rows, key, min = 1) =>
    rows.filter((r) => r[key] >= min).sort((a, b) => b[key] - a[key] || b.lines - a.lines).slice(0, limit)

  /**
   * 고립 노드 — 죽은 코드 후보.
   *
   * 이 목록은 **실제로 성과를 냈다.** 컨텍스트 없는 에이전트가 이 저장소를
   * 처음 볼 때, `ansi.js`·`highlight.js` 가 deg 0 으로 뜬 것을 단서로
   * 죽은 코드 199줄과 낡은 문서를 연쇄로 찾아냈다.
   *
   * 다만 **정적 파싱이 못 보는 연결이 있다**는 것을 함께 말해야 한다.
   * 같은 저장소에서 `mcp/server.mjs` 도 고립으로 나오는데, 그건 오답이다 —
   * 자식 프로세스로 CLI 를 부르므로 import 가 없을 뿐 실제로는 이어져 있다.
   */
  /**
   * 🔴 커밋 빈도로 한 번 더 거른다.
   *
   * syft 에서 이 목록이 3/3 오탐이었고, 실질적으로 "저장소에서 가장 큰 파일 12개"
   * 였다 — `lines` 내림차순으로만 정렬했기 때문이다. 그중 하나는
   * `binary/classifier_cataloger_test.go` 로 **커밋 76개에 import 14개**였다.
   *
   * `freq` 는 이미 같은 행에 표시돼 있었는데 거르는 데 쓰지 않았다.
   * 활발하게 바뀌는 파일은 죽은 코드가 아니다 — 그건 우리가 못 읽은 파일이다.
   * 그리고 크기가 아니라 **커밋이 적은 순**으로 정렬한다. "안 쓰이는 것"을
   * 찾는 목록에서 크기순 정렬은 질문과 무관하다.
   */
  const isolated = all
    .filter((r) => r.deg === 0 && r.freq <= isolatedMaxFreq)
    .sort((a, b) => a.freq - b.freq || b.lines - a.lines)
    .slice(0, limit)

  return {
    lists: [
      {
        key: 'churn',
        title: '가장 자주 바뀌는 곳',
        question: '지금 개발이 활발한 영역은 어디인가',
        hint: '커밋에 자주 등장한 순서. 팀이 실제로 시간을 쓰는 자리다.',
        metric: 'freq',
        unit: '커밋',
        rows: top(all, 'freq'),
      },
      {
        key: 'hub',
        title: '가장 많이 연결된 곳',
        question: '고치면 파급이 큰 곳은 어디인가',
        hint: 'import 로 이어진 이웃 수(공변경은 안 센다 — 그건 아래 목록이다). 여기를 건드리면 확인할 것이 많다.',
        metric: 'deg',
        unit: 'import 이웃',
        rows: top(all, 'deg'),
      },
      {
        key: 'risk',
        title: '숨은 결합이 많은 곳',
        question: '리뷰에서 사고가 날 확률이 높은 곳은 어디인가',
        hint: 'import 없이 함께 바뀌는 이웃 수. 코드를 읽어서는 안 보이는 연결이다.',
        metric: 'hidden',
        unit: '숨은 이웃',
        rows: top(all, 'hidden'),
      },
      {
        key: 'isolated',
        title: '아무와도 안 이어진 곳',
        question: '죽은 코드이거나, 파서가 못 보는 연결이다',
        /**
         * 🔴 개발자용 근거를 사용자 문구에 섞지 않는다.
         *
         * 예전에는 여기에 "flask 6/6, syft 3/3 이 오탐이었다" 가 붙어 있었다.
         * 우리에게는 이 목록을 믿지 말라는 강력한 증거지만, 화면에서는 **이
         * 저장소와 아무 상관 없는 남의 프로젝트 이름** 두 개일 뿐이다.
         * 5회차 온보딩 실험에서 에이전트가 "해석 못 한 라벨" 로 꼽았다.
         *
         * 실측 근거는 여기 주석에 남긴다 — flask 6개 전부, syft 3개 전부가
         * 오탐이었다. 그래서 이 목록은 후보이지 판정이 아니다.
         */
        hint: 'import 엣지 0개이면서 커밋도 5회 이하. 실제로 죽었을 수도 있고, 파서가 못 푼 import 이거나(자식 프로세스·리플렉션·생성 파일) 애초에 import 가 없는 파일(패키지 마커·데이터 테이블)일 수도 있다. 이 목록은 후보이지 판정이 아니다 — 반드시 열어서 확인하라.',
        metric: 'freq',
        unit: '커밋',
        rows: isolated,
      },
    ].filter((l) => l.rows.length > 0),
  }
}

/**
 * 밀집 완화 — 처음에 무엇을 그릴지 고른다.
 *
 * 노드 629개에 엣지 2,500개를 한꺼번에 그리면 "여기 다 있습니다" 라는 말밖에
 * 못 한다. 사람은 그 화면에서 아무것도 못 읽는다.
 *
 * 🔴 무작위로 자르거나 상위 N개만 남기면 **끊긴 조각들**이 남는다.
 *    이웃 없이 떠 있는 점은 정보가 아니라 노이즈다.
 *    그래서 씨앗을 고른 뒤 **그 이웃까지 함께** 데려온다.
 *
 * 자른 사실은 반드시 알린다. 조용한 절단은 "전부 봤다"로 읽힌다.
 */
export function coreSubset(nodes, edges, freq, { budget = 90 } = {}) {
  if (nodes.length <= budget) return { ids: null, seeds: 0, reason: null }

  const deg = new Map()
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }

  // 씨앗은 "자주 바뀌면서 많이 이어진" 노드다. 두 축 각각의 순위를 더해 고른다 —
  // 값 자체를 더하면 단위가 달라 한쪽이 다른 쪽을 삼킨다(커밋 160 vs 이웃 12).
  const byFreq = [...nodes].sort((a, b) => (freq[b.id] ?? 0) - (freq[a.id] ?? 0))
  const byDeg = [...nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0))
  const rank = new Map()
  byFreq.forEach((n, i) => rank.set(n.id, i))
  byDeg.forEach((n, i) => rank.set(n.id, (rank.get(n.id) ?? 0) + i))

  const seedCount = Math.max(10, Math.floor(budget / 4))
  const seeds = [...nodes].sort((a, b) => rank.get(a.id) - rank.get(b.id)).slice(0, seedCount)

  const nb = new Map()
  for (const e of edges) {
    if (!nb.has(e.source)) nb.set(e.source, [])
    if (!nb.has(e.target)) nb.set(e.target, [])
    nb.get(e.source).push(e.target)
    nb.get(e.target).push(e.source)
  }

  const ids = new Set(seeds.map((n) => n.id))
  // 씨앗의 이웃을 예산까지 채운다. 이웃을 많이 가진 씨앗부터 채워야
  // 끊긴 조각 대신 하나의 덩어리가 남는다.
  for (const s of seeds) {
    for (const q of nb.get(s.id) ?? []) {
      if (ids.size >= budget) break
      ids.add(q)
    }
    if (ids.size >= budget) break
  }

  return {
    ids,
    seeds: seeds.length,
    reason: `노드 ${nodes.length}개는 한 화면에서 읽을 수 없습니다. 자주 바뀌면서 많이 이어진 ${seeds.length}개와 그 이웃 ${ids.size - seeds.length}개만 그렸습니다.`,
  }
}
