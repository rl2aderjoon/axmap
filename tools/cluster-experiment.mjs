#!/usr/bin/env node
/**
 * 실험 1 — 폴더 정답표와 미래 공변경 중 어느 쪽이 진짜인가.
 *
 *   node tools/cluster-experiment.mjs --list repos.txt --out result.jsonl [--work /tmp/exp]
 *
 * 🔴 이 실험이 답해야 하는 질문은 하나다.
 *
 *    **군집이 폴더보다 나은가?**
 *
 * D17 은 "폴더가 다른데 실제로 얽혀 있는 것을 찾는 것이 목적" 이라고 적었다.
 * 그런데 axMap 자기 자신에서 재보니 미래적중 순위와 폴더일치 순위의 상관이
 * 0.906 이었다 — 미래를 잘 맞히는 설정이 곧 폴더와 잘 맞는 설정이었다.
 * 저장소 하나로는 "정리가 잘 된 저장소라서" 인지 "채점기가 폴더를 재고 있어서"
 * 인지 구별할 수 없다. 그래서 여럿에 건다.
 *
 * ── 기준선 셋을 함께 낸다 ────────────────────────────────────────────────
 *
 * 군집의 미래적중률만 내면 그 숫자가 높은지 낮은지 알 수가 없다. 비교 대상이
 * 없으면 45% 가 훌륭한 건지 형편없는 건지 말할 수 없기 때문이다.
 *
 *   dir1·dir2·dir3  디렉터리를 깊이별로 나눈 분할. **이걸 못 이기면 군집을
 *                   할 이유가 없다.** 깊이를 셋 다 내는 것은 폴더 쪽을
 *                   최대한 세우기 위해서다
 *   shuffled        블록 크기 분포는 그대로 두고 배정만 섞은 것
 *
 * 그리고 셋을 **lift = 적중률 ÷ 섞었을 때의 적중률** 로 환산해 비교한다.
 * 적중률을 날것으로 비교하면 굵은 분할이 무조건 이기기 때문이다.
 *
 * 🔴 기준선을 약하게 잡으면 아무 의미가 없다. 폴더 쪽을 이길 수 있게 만들어
 *    놓고 이겼다고 하는 것은 우리 자신을 속이는 것이다.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { build, scan } from '../app/lib/analyze.mjs'
import { coChange, readCommitSets } from '../app/lib/cochange.mjs'
import { buildGraph, cluster, rng } from '../corpus/cluster.mjs'
import { ari, containment, directoryPartition, shape } from '../corpus/clusterscore.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const LIST = flag('list', null)
const OUT = flag('out', 'cluster-exp.jsonl')
const WORK = flag('work', path.join(os.tmpdir(), 'axmap-cluster-exp'))
const HOLDOUT = Number(flag('holdout', '0.2'))
const SEEDS = Number(flag('seeds', '3'))
const MAX_FILES = Number(flag('max-files', '3000'))

if (!LIST) { console.error('--list 이 필요하다 (한 줄에 owner/name 또는 git 주소)'); process.exit(1) }

// 격자는 좁게. 이 실험의 질문은 "어느 설정이 최고인가" 가 아니라
// "군집이 폴더를 이기는가" 이므로, 순위상관을 낼 만큼만 있으면 된다.
const GRID = {
  algorithm: ['leiden', 'louvain'],
  objective: ['modularity', 'cpm'],
  resolution: [0.25, 0.5, 0.75, 1, 1.5, 2],
  coWeight: [0, 1],
}

const say = (s) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${s}\n`)
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })

// ---------------------------------------------------------------------------

function rankOf(v) {
  const idx = v.map((x, k) => [x, k]).sort((a, b) => a[0] - b[0])
  const out = new Array(v.length)
  for (let k = 0; k < idx.length;) {
    let j = k
    while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++
    const r = (k + j) / 2 + 1
    for (let m = k; m <= j; m++) out[idx[m][1]] = r
    k = j + 1
  }
  return out
}

function spearman(a, b) {
  const p = []
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) p.push([a[i], b[i]])
  if (p.length < 8) return null
  const ra = rankOf(p.map((x) => x[0])), rb = rankOf(p.map((x) => x[1]))
  const n = p.length, m = (n + 1) / 2
  let num = 0, da = 0, db = 0
  for (let k = 0; k < n; k++) { const x = ra[k] - m, y = rb[k] - m; num += x * y; da += x * x; db += y * y }
  if (!da || !db) return null
  return num / Math.sqrt(da * db)
}

/**
 * 블록 크기 분포는 그대로 두고 배정만 섞는다.
 *
 * 🔴 이 기준선이 없으면 속는다. 블록이 크면 그 안에 떨어지는 쌍이 자동으로
 *    많아진다 — 구조를 못 찾아도 적중률이 오른다. 크기 효과를 뺀 나머지가
 *    진짜로 찾아낸 몫이다.
 */
function shuffledLike(membership, seed) {
  const rand = rng(seed)
  const out = Int32Array.from(membership)
  for (let i = out.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0
    const t = out[i]; out[i] = out[j]; out[j] = t
  }
  return out
}

// ---------------------------------------------------------------------------

function measure(dir, name) {
  const files = scan(dir, { maxFiles: MAX_FILES })
  const graph = build(files)
  const ids = graph.nodes.map((n) => n.id)
  if (ids.length < 40) return { name, skip: `파일 ${ids.length}개` }

  const raw = readCommitSets(dir)
  if (!raw || raw.length < 80) return { name, skip: `커밋 ${raw?.length ?? 0}개` }

  const cut = Math.max(15, Math.floor(raw.length * HOLDOUT))
  const withCov = (a) => { a.coverage = raw.coverage; return a }
  const futureSets = withCov(raw.slice(0, cut))
  const pastSets = withCov(raw.slice(cut))

  const nodeIds = new Set(ids)
  const tag = (e) => e.map((x) => ({ ...x, origin: 'cochange' }))
  const pastCo = tag(coChange(dir, nodeIds, { raw: pastSets, minSupport: 2 })?.edges ?? [])
  const futureCo = tag(coChange(dir, nodeIds, { raw: futureSets, minSupport: 1 })?.edges ?? [])
  if (futureCo.length < 30) return { name, skip: `미래 공변경 ${futureCo.length}쌍` }

  // ── 기준선 ──────────────────────────────────────────────────────────────
  /**
   * 🔴 적중률을 그대로 비교하면 **무조건 굵은 분할이 이긴다.**
   *
   * 블록이 크면 그 안에 떨어지는 쌍이 자동으로 많아진다. 실제로 첫 실행에서
   * "폴더 100%" 가 나왔는데, 그건 폴더 하나가 전부를 삼켜서 모든 쌍이
   * 자동으로 안에 들어간 것이었다 — 아무것도 안 맞힌 것이 만점으로 보였다.
   *
   * 그래서 모든 분할에 대해 **같은 크기 분포로 섞은 대조군**을 함께 낸다.
   *
   *   lift = 적중률 ÷ 섞었을 때의 적중률
   *
   * lift 1.0 은 "크기 때문에 맞은 것일 뿐 구조는 못 찾았다" 는 뜻이다.
   * 이 값이라야 블록 5개짜리와 40개짜리를 같은 자로 잴 수 있다.
   */
  const withBase = (m) => {
    const hit = containment(ids, futureCo, m).weighted
    const sh = containment(ids, futureCo, shuffledLike(m, 99)).weighted
    return { ...shape(m), weighted: hit, shuffled: sh, lift: sh ? hit / sh : null }
  }
  const dirs = { 1: directoryPartition(ids, { depth: 1 }), 2: directoryPartition(ids, { depth: 2 }), 3: directoryPartition(ids, { depth: 3 }) }
  const base = { dir1: withBase(dirs[1]), dir2: withBase(dirs[2]), dir3: withBase(dirs[3]) }

  // ── 격자 ────────────────────────────────────────────────────────────────
  const cands = []
  for (const coWeight of GRID.coWeight) {
    const g = buildGraph(ids, [...graph.edges, ...pastCo], { coWeight, minSupport: 2 })
    for (const algorithm of GRID.algorithm) {
      for (const objective of GRID.objective) {
        for (const resolution of GRID.resolution) {
          const runs = []
          for (let s = 1; s <= SEEDS; s++) runs.push(cluster(algorithm, g, { resolution, objective, seed: s }).membership)
          const m = runs[0]
          const sh = shape(m)
          let stab = 0, np = 0
          for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
            const v = ari(runs[i], runs[j]); if (v != null) { stab += v; np++ }
          }
          cands.push({
            label: `${algorithm}/${objective} γ=${resolution} co=${coWeight}`,
            algorithm, objective, resolution, coWeight,
            blocks: sh.usableBlocks, maxShare: sh.maxShare, singletonShare: sh.singletonShare,
            stability: np ? stab / np : null,
            ariDir1: ari(m, dirs[1]),
            ariDir2: ari(m, dirs[2]),
            heldOut: containment(ids, futureCo, m).weighted,
            // 같은 크기 분포로 섞은 것. 구조가 아니라 크기로 맞는 몫.
            heldOutShuffled: containment(ids, futureCo, shuffledLike(m, 99)).weighted,
          })
        }
      }
    }
  }

  for (const c of cands) c.lift = c.heldOutShuffled ? c.heldOut / c.heldOutShuffled : null
  const usable = cands.filter((c) => c.heldOut != null)
  const best = [...usable].sort((a, b) => b.heldOut - a.heldOut)[0] ?? null
  // 얼룩(한 블록이 다 삼킨 것)을 뺀 뒤의 최고. 이쪽이 실제로 쓸 수 있는 답이다.
  const bestSane = [...usable].filter((c) => c.maxShare <= 0.4 && c.blocks >= 3)
    .sort((a, b) => b.heldOut - a.heldOut)[0] ?? null

  return {
    name,
    files: ids.length,
    staticEdges: graph.edges.length,
    commits: { past: pastSets.length, future: futureSets.length },
    coEdges: { past: pastCo.length, future: futureCo.length },
    parseCoverage: graph.nodes.filter((n) => n.parsed).length / ids.length,
    base,
    best,
    bestSane,
    // 🔴 실험의 핵심 숫자
    rankCorr: {
      heldOutVsDir1: spearman(usable.map((c) => c.heldOut), usable.map((c) => c.ariDir1)),
      heldOutVsDir2: spearman(usable.map((c) => c.heldOut), usable.map((c) => c.ariDir2)),
      heldOutVsStability: spearman(usable.map((c) => c.heldOut), usable.map((c) => c.stability)),
      heldOutVsBlocks: spearman(usable.map((c) => c.heldOut), usable.map((c) => c.blocks)),
    },
    candidates: cands,
  }
}

// ---------------------------------------------------------------------------

const repos = fs.readFileSync(LIST, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
fs.mkdirSync(WORK, { recursive: true })
say(`저장소 ${repos.length}개 · 격자 ${GRID.algorithm.length * GRID.objective.length * GRID.resolution.length * GRID.coWeight.length}칸 · 씨앗 ${SEEDS}`)

let ok = 0, skipped = 0, failed = 0
for (const [i, entry] of repos.entries()) {
  const url = entry.includes('://') || entry.startsWith('git@') ? entry : `https://github.com/${entry}.git`
  const safe = entry.replace(/[^\w.-]/g, '_')
  const dir = path.join(WORK, safe)
  const t0 = Date.now()
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.rmSync(dir, { recursive: true, force: true })
      // 🔴 blob:none — 필요한 것은 커밋 이력이지 파일 내용의 모든 판본이 아니다.
      //    다만 작업 트리는 필요하므로 얕은(shallow) 클론은 쓰지 않는다.
      git(['clone', '-q', '--filter=blob:none', url, dir])
    }
    const r = measure(dir, entry)
    r.at = new Date().toISOString()
    r.ms = Date.now() - t0
    fs.appendFileSync(OUT, `${JSON.stringify(r)}\n`)
    if (r.skip) { skipped++; say(`  [${i + 1}/${repos.length}] 건너뜀 ${entry} — ${r.skip}`) }
    else {
      ok++
      const b = r.bestSane ?? r.best
      const dirBest = Math.max(r.base.dir1.lift ?? 0, r.base.dir2.lift ?? 0, r.base.dir3.lift ?? 0)
      say(`  [${i + 1}/${repos.length}] ${entry} 파일 ${r.files} · lift 군집 ${b?.lift?.toFixed(2)}`
        + ` vs 폴더 ${dirBest.toFixed(2)}`
        + ` · 순위상관 ${r.rankCorr.heldOutVsDir1?.toFixed(2) ?? '—'} (${((Date.now() - t0) / 1000).toFixed(0)}초)`)
    }
  } catch (e) {
    failed++
    fs.appendFileSync(OUT, `${JSON.stringify({ name: entry, error: String(e.message).slice(0, 300), at: new Date().toISOString() })}\n`)
    say(`  [${i + 1}/${repos.length}] 실패 ${entry} — ${String(e.message).slice(0, 120)}`)
  } finally {
    // 재고 나서 즉시 지운다. 안 지우면 디스크가 먼저 죽는다 (docs/SSOT.md 와 같은 이유).
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
say(`끝. 성공 ${ok} · 건너뜀 ${skipped} · 실패 ${failed} → ${OUT}`)
