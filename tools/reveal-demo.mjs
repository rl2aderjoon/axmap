#!/usr/bin/env node
/**
 * 그래프 → 트리. `app/lib/reveal.mjs` 를 실제 저장소로 돌려 **화면 없이** 본다.
 *
 * 🔴 왜 따로 도구인가.
 *
 * 점진 공개의 주장은 "한꺼번에 다 보여주지 않으면 벽이 안 생긴다" 이고,
 * 그 주장은 **숫자로만 확인된다** — 몇 번 눌러서 몇 개를 봤나, 한 번에
 * 몇 개가 쏟아졌나, 자리가 안 바뀌었나. 브라우저에서는 이걸 셀 수 없다.
 *
 * 화면(app/web)은 다른 세션이 잡고 있다. 로직은 순수 함수라 화면 없이도
 * 전부 돌릴 수 있으므로, 여기서 먼저 재고 화면은 그 뒤에 붙인다.
 *
 * 사용:
 *   node tools/reveal-demo.mjs <저장소> [--steps 5] [--width 100]
 */

import fs from 'node:fs'
import path from 'node:path'

import { build, scan } from '../app/lib/analyze.mjs'
import { entryStarts } from '../app/lib/flow.mjs'
import { featureGraph } from '../app/lib/featuregraph.mjs'
import { commitFiles } from '../app/lib/live.mjs'
import {
  callsOf, emptyReveal, importersOf, layers, preview, reachable, reveal, revealFeature,
} from '../app/lib/reveal.mjs'

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const ROOT = path.resolve(argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true) ?? '.')
const STEPS = Number(flag('steps', 5))

const short = (p) => (p.length <= 26 ? p : `…${p.slice(-25)}`)

/** 층 하나를 한 줄로. 자리(col)가 곧 순서라 왼쪽부터 도착 순이다. */
function draw(state, opened) {
  const rows = layers(state)
  const out = []
  for (const r of rows) {
    const cells = r.cells.map((c) => {
      const mark = opened.has(c.id) ? '▣' : '□'
      return `${mark} ${short(c.id)}`
    })
    // 한 줄이 너무 길면 접는다 — 화면에서도 줄바꿈이 일어날 자리다.
    const head = `층 ${String(r.depth).padStart(2)} │ `
    const pad = ' '.repeat(head.length)
    let line = head
    const lines = []
    for (const c of cells) {
      if (line.length + c.length + 3 > 96) { lines.push(line); line = pad }
      line += `${c}   `
    }
    lines.push(line)
    out.push(...lines.map((l) => l.replace(/\s+$/, '')))
  }
  return out.join('\n')
}

// ── 그래프를 만든다 (지금 화면이 그리는 것과 같은 재료) ────────────────────
const g = build(scan(ROOT))
const importers = importersOf(g.edges)
const calls = callsOf(g.edges)
const byId = new Map(g.nodes.map((n) => [n.id, n]))

console.log(`\n저장소  ${ROOT}`)
console.log(`━`.repeat(78))
console.log(`지금 그래프가 한 번에 그리는 것 :  노드 ${g.nodes.length}개 · 엣지 ${g.edges.length}개`)
console.log(`                                  ← 이것이 "벽" 이다\n`)

// ── ① 진입점 하나로 시작 ──────────────────────────────────────────────────
const starts = entryStarts(ROOT, g.nodes, g.edges)
if (!starts.length) {
  console.log('진입점을 못 찾았다. 이 저장소로는 시연할 수 없다.')
  process.exit(1)
}
let st = reveal(emptyReveal(), [starts[0]], { why: '진입점', importers })
const opened = new Set()

console.log(`┌─ 0번째 ─ 시작`)
console.log(draw(st, opened))
let r = reachable(st, calls)
console.log(`└─ 보이는 것 ${r.shown}개 · 여기서 import 로 더 닿는 것 ${r.more}개\n`)

// ── ② 누른다. 누르기 **전에** 몇 개가 나올지 알려준다 ─────────────────────
for (let step = 1; step <= STEPS; step++) {
  // 아직 안 펼친 것 중 가장 먼저 드러난 것부터 — 사람이 위에서부터 읽는 순서
  const target = st.order.find((id) => !opened.has(id) && preview(st, id, calls).count > 0)
  if (!target) {
    console.log(`더 펼칠 것이 없다 (import 사슬이 ${step - 1}번 만에 말랐다).`)
    console.log(`🔴 이래서 개념 축이 필요하다 — 아래 참조.\n`)
    break
  }
  const pv = preview(st, target, calls)
  // 🔴 예고는 **실제로 뜨는 수**여야 한다. `count` 는 후보 전체이고 한 번에
  //    여는 것은 `ids` 다. 둘이 다른데 후보 수를 적으면 화면이 거짓말을 한다
  //    (개념 축에서 "고른 수와 는 수가 다르면 거짓말" 이라고 정한 것과 같다).
  const say = pv.more ? `+${pv.ids.length}개 (후보 ${pv.count}개 중)` : `+${pv.ids.length}개`
  console.log(`┌─ ${step}번째 ─ "${short(target)}" 를 누른다   (누르기 전 예고: ${say})`)
  const before = { ...st.at }
  st = reveal(st, pv.ids, { why: `${path.basename(target)} 가 부른다`, parent: target, importers })
  opened.add(target)

  // 🔴 불변식 확인 — 한 번 잡은 자리는 다시는 안 움직인다.
  const moved = Object.keys(before).filter(
    (k) => before[k].depth !== st.at[k].depth || before[k].col !== st.at[k].col)
  console.log(draw(st, opened))
  r = reachable(st, calls)
  console.log(`└─ 보이는 것 ${r.shown}개 · 더 닿는 것 ${r.more}개 · 자리가 움직인 노드 ${moved.length}개`
    + (moved.length ? `  ❌ 불변식 위반` : `  ✅`))
  console.log()
}

// ── ③ 개념 축 — import 가 마르면 README 가 이름 붙인 묶음을 연다 ──────────
let readme = null
for (const f of ['README.md', 'README.rst', 'readme.md', 'README']) {
  try { readme = fs.readFileSync(path.join(ROOT, f), 'utf8'); break } catch { /* 다음 후보 */ }
}
const { available, commits } = commitFiles(ROOT, { since: '10 years ago', maxCommits: 2000 })
const fg = featureGraph({
  paths: g.nodes.map((n) => n.id),
  commits: available ? commits : [],
  readme,
  edges: g.edges,
})
const feats = (fg.nodes ?? []).filter((n) => (n.paths ?? []).length > 1)
if (!feats.length) {
  console.log('묶음을 못 찾았다 (README 에서 이름을 못 얻었거나 파일이 흩어져 있다).')
} else {
  const f = feats.sort((a, b) => b.paths.length - a.paths.length)[0]
  console.log(`┌─ 개념 축 ─ 묶음 "${f.name ?? f.id}" 를 누른다   (안에 ${f.paths.length}개)`)
  const before = { ...st.at }
  const shownBefore = st.order.length
  const out = revealFeature(st, f, { edges: g.edges, importers, byId })
  st = out.state
  const moved = Object.keys(before).filter(
    (k) => before[k].depth !== st.at[k].depth || before[k].col !== st.at[k].col)
  console.log(draw(st, opened))
  const grew = st.order.length - shownBefore
  console.log(`└─ ${f.paths.length}개 중 현관문 ${out.door.ids.length}개를 골랐다`)
  console.log(`   근거: ${out.door.why}`)
  for (const id of out.door.ids) {
    const isNew = !before[id]
    console.log(`     ${isNew ? '새로' : '이미'}  ${short(id).padEnd(28)} 바깥에서 부르는 곳 ${out.door.calledFrom[id]}`)
  }
  // 🔴 고른 수와 실제로 는 수가 다르면 사람은 "눌렀는데 아무 일도 안 났다" 를 본다.
  console.log(`   ⇒ 화면에 실제로 는 것 ${grew}개`
    + (grew === out.door.ids.length ? '' : `  ❌ ${out.door.ids.length}개를 골랐는데 ${out.door.ids.length - grew}개는 이미 열려 있던 것`))
  console.log(`   자리가 움직인 노드 ${moved.length}개` + (moved.length ? ' ❌' : ' ✅'))
}

r = reachable(st, calls)
console.log(`\n${'━'.repeat(78)}`)
console.log(`한꺼번에 그렸다면 ${g.nodes.length}개.  ${STEPS}번 눌러서 본 것은 ${r.shown}개.`)
console.log(`읽은 흔적이 곧 화면이고, 안 연 것은 화면에 없다.`)
