#!/usr/bin/env node
/**
 * 저장소 하나에서 군집 하이퍼파라미터를 쓸어본다 — 미래를 떼어놓고 채점한다.
 *
 *   node tools/cluster-sweep.mjs <저장소경로> [--out out.json]
 *   node tools/cluster-sweep.mjs . --holdout 0.25 --seeds 5
 *
 * 🔴 이 도구의 전부는 **커밋 이력을 앞뒤로 자르는 한 줄**이다.
 *
 * 앞쪽(오래된 쪽) 커밋만으로 공변경을 만들어 블록을 나누고, 뒤쪽(최근) 커밋에서
 * 실제로 같이 바뀐 쌍을 그 블록이 품고 있었는지 센다. 만든 데 쓴 엣지로 채점하면
 * 무조건 잘 맞는다 — 그건 채점이 아니라 동어반복이다.
 *
 * docs/SSOT.md 가 "떼어놓고 검증(held-out)하지 않았다. 이것이 있어야 기준이
 * 관찰에서 검증된 지침이 된다" 를 못 한 일로 적어 두었다. 여기가 그 고리다.
 *
 * ⚠️ 아직 코퍼스에 연결하지 않았다. 저장소 하나에서 이 값들이 말이 되는지
 *    먼저 눈으로 보고 나서 `corpus/measure.mjs` 에 붙인다. 검증 안 된 계측을
 *    16,876개에 먼저 거는 것은 순서가 거꾸로다.
 */
import fs from 'node:fs'
import path from 'node:path'

import { build, scan } from '../app/lib/analyze.mjs'
import { coChange, readCommitSets } from '../app/lib/cochange.mjs'
import { buildGraph, cluster } from '../corpus/cluster.mjs'
import {
  agreement, ari, containment, directoryPartition, rank, shape,
} from '../corpus/clusterscore.mjs'

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const root = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true)
  ?? argv[0]

if (!root || root.startsWith('--')) {
  console.error('사용법: node tools/cluster-sweep.mjs <저장소경로> [--out out.json] [--holdout 0.2] [--seeds 4]')
  process.exit(1)
}

const HOLDOUT = Number(flag('holdout', '0.2'))
const SEEDS = Number(flag('seeds', '4'))
const OUT = flag('out', null)
const MAX_FILES = Number(flag('max-files', '4000'))

// 쓸어볼 격자. 넓이가 먼저다 — 좁게 깊이 파면 다른 조합이 더 나았는지 영영 모른다.
const GRID = {
  algorithm: (flag('algos', 'leiden,louvain,labelprop')).split(','),
  objective: (flag('objectives', 'modularity,cpm')).split(','),
  resolution: (flag('gammas', '0.25,0.5,0.75,1,1.5,2,3')).split(',').map(Number),
  coWeight: (flag('coweights', '0,0.5,1,2')).split(',').map(Number),
}

// ---------------------------------------------------------------------------
// 재료
// ---------------------------------------------------------------------------

const t0 = Date.now()
const say = (s) => process.stderr.write(`${s}\n`)

say(`저장소 ${path.resolve(root)}`)
const files = scan(root, { maxFiles: MAX_FILES })
const graph = build(files)
const ids = graph.nodes.map((n) => n.id)
const nodeIds = new Set(ids)
say(`파일 ${ids.length}개 · 정적 엣지 ${graph.edges.length}개`)

if (ids.length < 20) {
  say('파일이 20개도 안 된다 — 군집을 말할 그래프가 아니다.')
  process.exit(1)
}

/**
 * 커밋을 앞뒤로 자른다.
 *
 * `readCommitSets` 는 **최신이 먼저**다 (git log 순서). 그래서 앞쪽 slice 가
 * 미래고 뒤쪽 slice 가 과거다 — 직관과 반대이므로 이름을 분명히 붙인다.
 */
const raw = readCommitSets(root)
if (!raw || raw.length < 50) {
  say(`커밋이 ${raw?.length ?? 0}개뿐이다 — 떼어놓을 미래가 없다.`)
  process.exit(1)
}
const cut = Math.max(10, Math.floor(raw.length * HOLDOUT))
const withCoverage = (arr) => { arr.coverage = raw.coverage; return arr }
const futureSets = withCoverage(raw.slice(0, cut))
const pastSets = withCoverage(raw.slice(cut))
say(`커밋 ${raw.length}개 → 과거 ${pastSets.length} / 미래 ${futureSets.length} (holdout ${HOLDOUT})`)

/**
 * 🔴 origin 을 여기서 붙인다. `coChange().edges` 에는 없다 — 붙이는 것은
 *    `overlayEdges` 인데 우리는 그걸 안 거치기 때문이다. 안 붙이면
 *    `buildGraph` 가 거부한다 (전에는 조용히 정적 엣지로 삼켰다).
 */
const tag = (edges) => edges.map((e) => ({ ...e, origin: 'cochange' }))

const pastCo = tag(coChange(root, nodeIds, { raw: pastSets, minSupport: 2 })?.edges ?? [])
const futureCo = tag(coChange(root, nodeIds, { raw: futureSets, minSupport: 1 })?.edges ?? [])
say(`공변경 엣지 — 과거 ${pastCo.length} · 미래(채점용) ${futureCo.length}`)

if (futureCo.length < 20) {
  say('미래 공변경이 20쌍도 안 된다 — 채점할 수 없다. holdout 을 늘려보라.')
  process.exit(1)
}

const dirTruth = directoryPartition(ids, { depth: 1 })

// ---------------------------------------------------------------------------
// 쓸기
// ---------------------------------------------------------------------------

const candidates = []
let done = 0
const total = GRID.algorithm.length * GRID.objective.length * GRID.resolution.length * GRID.coWeight.length

for (const coWeight of GRID.coWeight) {
  // 공변경 무게가 바뀌면 그래프 자체가 바뀐다. 격자 바깥에서 한 번만 만든다.
  const g = buildGraph(ids, [...graph.edges, ...pastCo], { coWeight, minSupport: 2 })

  for (const algorithm of GRID.algorithm) {
    for (const objective of GRID.objective) {
      for (const resolution of GRID.resolution) {
        // label propagation 은 파라미터가 없다. 격자를 돌면 같은 답을 수십 번 낸다.
        if (algorithm === 'labelprop' && (objective !== GRID.objective[0] || resolution !== GRID.resolution[0])) {
          done++
          continue
        }

        const runs = []
        for (let s = 1; s <= SEEDS; s++) {
          runs.push(cluster(algorithm, g, { resolution, objective, seed: s }).membership)
        }
        const m = runs[0]
        const sh = shape(m)

        candidates.push({
          label: `${algorithm}/${objective} γ=${resolution} co=${coWeight}`,
          algorithm,
          objective,
          resolution,
          coWeight,
          shape: sh,
          stability: agreement(runs),
          dirAgreement: ari(m, dirTruth),
          // 🔴 만든 데 안 쓴 엣지로만 잰다
          heldOut: containment(ids, futureCo, m),
          // 대조군: 만든 데 쓴 엣지로 재면 얼마나 나오나. 둘의 차이가 곧 과적합이다.
          inSample: containment(ids, pastCo, m),
        })

        if (++done % 10 === 0) say(`  ${done}/${total}`)
      }
    }
  }
}

const result = rank(candidates)

// ---------------------------------------------------------------------------
// 내기
// ---------------------------------------------------------------------------

const pct = (v) => (v == null ? '  —  ' : `${(v * 100).toFixed(1)}%`.padStart(6))
const num = (v) => (v == null ? ' —  ' : v.toFixed(2))

console.log(`\n저장소  ${path.resolve(root)}`)
console.log(`파일 ${ids.length} · 정적엣지 ${graph.edges.length} · 과거커밋 ${pastSets.length} · 미래커밋 ${futureSets.length}`)
console.log(`후보 ${candidates.length}개 중 제약 통과 ${result.passed.length}개\n`)

console.log('상위 12 (제약 통과분, 미래 공변경 적중률 순)')
console.log('  ' + '조합'.padEnd(34) + '블록'.padEnd(6) + '최대'.padEnd(7) + '안정'.padEnd(7)
  + '폴더'.padEnd(7) + '미래'.padEnd(8) + '과거')
for (const c of result.passed.slice(0, 12)) {
  console.log('  ' + c.label.padEnd(34)
    + String(c.shape.usableBlocks).padEnd(6)
    + pct(c.shape.maxShare).padEnd(7)
    + num(c.stability.mean).padEnd(7)
    + num(c.dirAgreement).padEnd(7)
    + pct(c.heldOut.weighted).padEnd(8)
    + pct(c.inSample.weighted))
}

if (!result.best) {
  console.log(`\n고르지 못했다: ${result.why}`)
  // 왜 다 떨어졌는지 사유를 세어 보여준다. 빈 답만 주면 다음 사람이 격자를 헤맨다.
  const tally = new Map()
  for (const c of result.judged) for (const f of c.fail) {
    const kind = f.replace(/[\d.]+/g, 'N')
    tally.set(kind, (tally.get(kind) ?? 0) + 1)
  }
  console.log('\n탈락 사유')
  for (const [why, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}회  ${why}`)
} else {
  const b = result.best
  console.log(`\n고른 것  ${b.label}`)
  console.log(`  블록 ${b.shape.usableBlocks}개 · 최대 블록 ${pct(b.shape.maxShare)} · 혼자 ${pct(b.shape.singletonShare)}`)
  console.log(`  안정성 평균 ${num(b.stability.mean)} / 최악 ${num(b.stability.min)}`)
  console.log(`  폴더와의 일치 ${num(b.dirAgreement)}  (낮을수록 폴더가 모르는 것을 찾았다는 뜻)`)
  console.log(`  미래 공변경 적중 ${pct(b.heldOut.weighted)} · 같은 것을 과거로 재면 ${pct(b.inSample.weighted)}`)
  const gap = (b.inSample.weighted ?? 0) - (b.heldOut.weighted ?? 0)
  console.log(`  과적합 폭 ${pct(gap)}  (클수록 과거에만 맞는 분할이다)`)
}

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({
    root: path.resolve(root),
    at: new Date().toISOString(),
    files: ids.length,
    staticEdges: graph.edges.length,
    commits: { past: pastSets.length, future: futureSets.length, holdout: HOLDOUT },
    seeds: SEEDS,
    grid: GRID,
    best: result.best?.label ?? null,
    why: result.why,
    candidates: result.judged,
  }, null, 1))
  say(`\n적었다: ${OUT}`)
}
say(`${((Date.now() - t0) / 1000).toFixed(1)}초`)
