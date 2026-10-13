/**
 * 가운데 칸 — `ladder()` 가 내는 것을 번호 카드로 그린다.
 *
 * 🔴 새 시각화를 만드는 것이 아니다. **이미 이긴 텍스트를 다시 조판하는 것**이다.
 *
 * 벤치 3회차는 다섯 조건 전부에서 7/7 이었다 — 그림 없이 글자만 있어도 답은
 * 같았다. 그런데 `answers-graph.md` 가 이렇게도 적었다:
 *
 *   "걸음 ②에서 노드 2 / 엣지 0, 걸음 ③에서 노드 8 / 엣지 3 — 화면의 3분의 2가
 *    검은 여백인 채로, 정작 그 걸음의 답은 전부 왼쪽 좁은 패널에 글자로 쏟아졌다"
 *
 * 그건 렌더링 문제가 아니라 **데이터 공급 문제**다. 예쁜 캔버스를 만들어도 거기에
 * 노드 2개만 흘려보내면 똑같이 빈다. 그래서 이 파일이 하는 일은 하나다 —
 * 왼쪽 패널이 글자로 쏟아내던 것을 가운데 큰 자리로 옮긴다.
 * 자세한 근거는 `docs/RESEARCH-FLOWCANVAS.md` 4.1.
 *
 * ── 규율 (Zap 편집기에서 가져온 것) ──────────────────────────────────────
 *
 *   번호가 붙는다        그림을 안 봐도 "2.5 를 보세요" 라고 말할 수 있다
 *   카드 폭이 같다       읽는 눈이 좌우로 흔들리지 않는다
 *   분기는 버스 하나     자식마다 선을 뽑으면 "각각의 관계" 로 읽힌다.
 *                        한 줄기에서 갈라져야 "여기서 한 번 갈린다" 가 된다
 *   선은 조용하다        주인공은 카드의 글자다. 실측한 Zapier 연결선은
 *                        바탕 대비 4.4:1 밖에 안 된다
 *   아무것도 안 움직인다  물리도 rAF 도 없다. 온보딩 실험 네 회차가 보고한
 *                        "찍고 누르는 사이에 대상이 이동" 이 구조적으로 사라진다
 *
 * 🔴 **좌표를 우리가 계산하지 않는다.** 카드는 평범한 DOM 이고 배치는 CSS 가
 * 한다. 선만 그릴 때 실제로 놓인 자리를 읽어서(`getBoundingClientRect`) 잇는다.
 * 손으로 좌표를 짜기 시작하면 창 크기가 바뀔 때마다 어긋난다.
 */

const $ = (s) => document.querySelector(s)

/**
 * 한 화면에 그리는 카드의 상한.
 *
 * Deutsch limit — 화면에 시각 요소를 50개 넘게 두면 사람이 못 읽는다 — 은
 * Zapier 에게는 제약이 아니다. 워크플로가 원래 30단계 미만이니까.
 * 우리는 저장소 하나가 2,000개를 넘는다. "전부 보여주고 사용자가 줄이게 한다" 는
 * D14 가 이미 버린 대안이므로, 넘치면 **넘쳤다고 말하고 자른다.**
 */
const MAX_CARDS = 60

/**
 * 화면에 나가는 말은 전부 여기서 온다.
 *
 * 🔴 문자열을 이 파일에 직접 쓰지 않는다. 어휘를 바꾸려면 그리기 코드를 읽어야
 * 하는 상태가 되면 `docs/WORDS.md` 의 판정 규칙("벤치에서 막힌 것만 바꾼다")을
 * 한 회차도 못 돌린다. 바꾸는 비용이 싸야 재서 정할 수 있다.
 */
import { W } from './words.js'

/** 부모 카드 아래에서 버스까지 내려가는 길이(px). CSS 의 층 간격과 맞춰 둔다. */
const STUB = 18

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const svgEl = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag)

/** 마지막으로 그린 결과. 창 크기가 바뀌면 선만 다시 긋는다. */
let drawn = null

/**
 * 지금 보고 있는 하위 프로젝트. `''` 면 저장소 전체다.
 *
 * 🔴 모노레포에서 "어디서부터 읽나" 의 **첫 답은 파일이 아니라 프로젝트**다.
 * 실측(SSAFY S15P11E101): 저장소 전체로 겹을 만들면 549개 중 14개만 닿았다.
 * `FE/bbiyong-react` 하나로 좁히면 150개 중 93개가 5겹으로 이어진다.
 * 자세한 근거는 `app/lib/roots.mjs` 머리말.
 */
let pick = null
const REMEMBER = 'axmap.root'

// ── 그리기 ──────────────────────────────────────────────────────────────────

/**
 * 프로젝트 고르는 줄. 하나뿐이면 그리지 않는다 —
 * 고를 것이 없는데 고르라고 하면 걸음만 하나 는다.
 */
function projectBar(info) {
  if (!info?.multi) return null
  const bar = el('div', 'projs')
  for (const r of info.roots) {
    const b = el('button', `proj${r.dir === pick ? ' on' : ''}`)
    // 저장소 루트 자체가 프로젝트일 수 있다. 빈 문자열을 그대로 그리면 이름이 없다.
    b.append(el('span', 'pn', r.dir || W.allRoots))
    b.append(el('span', 'pf', String(r.files)))
    // 🔴 선언된 것과 우리가 짐작한 것을 구분해 보여준다 (D5).
    b.title = r.manifest ? W.declaredBy(r.manifest) : W.guessedDir
    if (!r.manifest) b.append(el('span', 'guess', W.guess))
    b.onclick = () => {
      pick = r.dir
      try { localStorage.setItem(REMEMBER, pick) } catch { /* 그만 */ }
      drawStage()
    }
    bar.append(b)
  }
  if (info.outside) {
    bar.append(el('span', 'pout', W.outside(info.outside)))
  }
  return bar
}

export async function drawStage() {
  const stage = $('#stage')
  stage.replaceChildren()
  stage.className = 'loading'
  stage.textContent = W.loading

  let info = null
  try { info = await (await fetch('/api/roots')).json() } catch { /* 없으면 전체로 간다 */ }

  if (info?.multi && pick === null) {
    let saved = null
    try { saved = localStorage.getItem(REMEMBER) } catch { /* 그만 */ }
    // 기억해 둔 것이 아직 있으면 그것, 없으면 **가장 큰 프로젝트**로 시작한다.
    pick = info.roots.some((r) => r.dir === saved) ? saved : (info.roots[0]?.dir ?? '')
  }

  let d
  try {
    const q = pick ? `?root=${encodeURIComponent(pick)}` : ''
    const r = await fetch(`/api/ladder${q}`)
    d = await r.json()
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
  } catch (e) {
    stage.className = 'note'
    stage.textContent = W.readFailed(e.message)
    return
  }

  /**
   * 🔴 조용히 빈 화면을 내지 않는다.
   * `ladder()` 는 시작점을 못 찾으면 `why` 에 이유를 담아 준다. 그것을 삼키면
   * 사용자는 "저장소가 비었나" 로 잘못 읽는다 (fail-closed, CLAUDE.md).
   */
  if (d.why) {
    stage.className = 'note'
    stage.textContent = d.why
    return
  }
  if (!d.layers?.length) {
    stage.className = 'note'
    stage.textContent = W.noLayers
    return
  }

  // 🔴 "읽는 중…" 을 지운다. `append` 는 있던 것 뒤에 붙이므로 안 지우면 남는다.
  stage.replaceChildren()
  stage.className = ''
  const wires = svgEl('svg')
  wires.setAttribute('class', 'wires')
  stage.append(wires)

  const board = el('div', 'board')
  const bar = projectBar(info)
  if (bar) board.append(bar)
  stage.append(board)

  /** path → 그 카드의 DOM. 선을 그을 때 부모를 찾는 데 쓴다. */
  const byPath = new Map()
  let cards = 0
  let cut = 0

  for (const layer of d.layers) {
    const row = el('div', 'layer')

    const head = el('div', 'lhead')
    head.append(el('span', 'lno', W.layerNo(layer.depth)))
    head.append(el('span', 'lcount', W.layerCount(layer.count)))
    row.append(head)

    const cols = el('div', 'cols')
    row.append(cols)

    for (const g of layer.groups) {
      const col = el('div', 'grp')
      // 묶음 이름 = 디렉터리. Zap 편집기가 가지 머리에 조건 칩을 두는 자리다.
      const chip = el('div', 'chip', g.dir || W.topDir)
      chip.append(el('span', 'cn', String(g.count)))
      col.append(chip)

      for (const f of g.files) {
        if (cards >= MAX_CARDS) { cut++; continue }
        const card = card_(f, layer.depth, cards)
        byPath.set(f.path, card)
        col.append(card)
        cards++
      }
      if (g.truncated) col.append(el('div', 'more', W.moreFiles(g.truncated)))
      cols.append(col)
    }

    if (layer.moreGroups) cols.append(el('div', 'more', W.moreGroups(layer.moreGroups)))
    board.append(row)
  }

  const foot = el('div', 'foot2')
  foot.append(el('span', null, W.reach(d.reached, d.total, d.maxDepth)))

  /**
   * 🔴 "1 / 213" 을 숫자만 내면 고장으로 읽힌다.
   *
   * 실측: BE_system 은 진입점을 정확히 찾았는데(`@SpringBootApplication`)
   * 거기서 닿는 파일이 1개다. 고장이 아니라 **Spring 이 import 가 아니라
   * 애노테이션으로 배선**하기 때문이다. D5 가 예고한 한계이고, 그 문서는
   * "확신 있게 틀린 답이 가장 해롭다" 고 적었다 — 아무 말 없이 빈 화면을 내는
   * 것이 정확히 그 실패다. 무엇을 못 보고 있는지 말한다.
   */
  if (d.total >= 20 && d.reached / d.total < 0.25) {
    foot.append(el('span', 'warn2', W.staticLimit))
  }
  for (const g of d.unreached?.by?.groups ?? []) {
    foot.append(el('span', null, W.groupCount(g.label, g.count)))
  }
  // 🔴 자른 것은 자랐다고 말한다. 조용히 자르면 "이게 전부" 로 읽힌다.
  if (cut) foot.append(el('span', 'warn2', W.cutCards(MAX_CARDS, cut)))
  if (d.unreached?.count) foot.append(el('span', null, W.unreached(d.unreached.count)))
  board.append(foot)

  drawn = { wires, byPath, stage }
  wire()
}

/**
 * 카드 두 줄.
 *   줄 1 — 여는 파일 수 · 테스트/예제 표시
 *   줄 2 — `겹.순번` + 파일 이름
 *
 * 🔴 `title` 을 반드시 붙인다. 벤치의 ladder 회차가 잘린 이름 때문에 `zoom` 을
 * 썼다가 **"잘린 글자는 픽셀을 키운다고 되살아나지 않는다"** 고 적고, `title`
 * 하나면 막힌 지점이 없었을 것이라고 스스로 진단했다. DOM 에서는 공짜다.
 */
function card_(f, depth, seq) {
  const c = el('div', `card${f.aux ? ' aux' : ''}`)
  c.title = f.path

  const l1 = el('div', 'r1')
  l1.append(el('span', 'opens', W.opens(f.opens)))
  if (f.aux) l1.append(el('span', 'tag', W.aux))
  if (f.lines) l1.append(el('span', 'lines', W.lines(f.lines)))
  c.append(l1)

  const l2 = el('div', 'r2')
  // 번호가 이 카드의 정체다. 그림을 안 봐도 이 번호로 서로를 가리킬 수 있다.
  l2.append(el('span', 'no', `${depth}.${seq + 1}`))
  l2.append(el('span', 'nm', f.path.split('/').pop()))
  c.append(l2)

  const dir = f.path.split('/').slice(0, -1).join('/')
  if (dir) c.append(el('div', 'dir', dir))

  c.dataset.path = f.path
  c.dataset.from = f.from ?? ''
  return c
}

// ── 선 ──────────────────────────────────────────────────────────────────────

/**
 * 부모 아래 → 가로 버스 한 줄 → 각 자식 위.
 *
 * 🔴 자식마다 부모에서 각각 선을 뽑으면 **세 개의 독립된 관계**로 보인다.
 * 한 줄기에서 갈라지면 "여기서 한 번 갈린다" 로 읽힌다. Zapier 가 분기를
 * 하나의 결정으로 읽히게 만드는 장치가 정확히 이것이고, 순수 기하라 공짜로 온다.
 * 모서리는 둥글지 않다 — Zap 편집기가 직각이다.
 */
function busPath(px, py, kids) {
  if (!kids.length) return ''
  /**
   * 🔴 버스는 부모 바로 아래가 아니라 **부모와 첫 자식 사이**에 둔다.
   *
   * Zapier 는 부모와 자식이 붙어 있어서 어디에 두든 같다. 우리는 겹 사이가
   * 멀어서, 부모 바로 아래에 두면 거기서부터 자식까지 **긴 세로선이 다른 카드를
   * 가로지른다.** 실제로 그렇게 그려졌다. 중간에 두면 낙하가 짧아지고
   * "여기서 갈린다" 가 눈에 남는다.
   */
  const top = Math.min(...kids.map((k) => k.y))
  const bus = Math.max(py + STUB, (py + top) / 2)
  const left = Math.min(px, ...kids.map((k) => k.x))
  const right = Math.max(px, ...kids.map((k) => k.x))
  let d = `M${px} ${py}V${bus}`
  if (right - left > 0.5) d += `M${left} ${bus}H${right}`
  for (const k of kids) d += `M${k.x} ${bus}V${k.y}`
  return d
}

/**
 * 놓인 자리를 읽어서 잇는다.
 *
 * 카드 배치는 CSS 가 했으므로 우리는 결과만 본다. 좌표를 직접 계산하면
 * 창 크기·글꼴·줄바꿈이 바뀔 때마다 선이 어긋난다.
 */
function wire() {
  if (!drawn) return
  const { wires, byPath, stage } = drawn
  const base = stage.getBoundingClientRect()

  wires.setAttribute('width', String(stage.scrollWidth))
  wires.setAttribute('height', String(stage.scrollHeight))
  wires.setAttribute('viewBox', `0 0 ${stage.scrollWidth} ${stage.scrollHeight}`)
  wires.replaceChildren()

  const mid = (r) => r.left - base.left + stage.scrollLeft + r.width / 2

  // 부모별로 자식을 모은다 — 그래야 버스를 공유할 수 있다
  const kidsOf = new Map()
  for (const card of byPath.values()) {
    const from = card.dataset.from
    if (!from || !byPath.has(from)) continue
    if (!kidsOf.has(from)) kidsOf.set(from, [])
    kidsOf.get(from).push(card)
  }

  for (const [from, kids] of kidsOf) {
    const p = byPath.get(from).getBoundingClientRect()
    const px = mid(p)
    const py = p.bottom - base.top + stage.scrollTop
    const pts = kids.map((k) => {
      const r = k.getBoundingClientRect()
      return { x: mid(r), y: r.top - base.top + stage.scrollTop }
    })
    const path = svgEl('path')
    path.setAttribute('class', 'w')
    path.setAttribute('d', busPath(px, py, pts))
    wires.append(path)
  }
}

/**
 * 창이나 칸 크기가 바뀌면 선만 다시 긋는다.
 *
 * 🔴 `requestAnimationFrame` 을 걸지 않는다. 카드는 안 움직이므로 다시 그릴 일이
 * 바뀔 때뿐이다. D16 이 "정지한 화면을 초당 60번 다시 칠하지 않는다" 로 정한
 * 방향 그대로이고, DOM 이라 저절로 그렇게 된다.
 */
export function watchStage() {
  const stage = $('#stage')
  if (!stage || typeof ResizeObserver === 'undefined') return
  new ResizeObserver(() => wire()).observe(stage)
}
