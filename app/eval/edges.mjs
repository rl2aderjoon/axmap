#!/usr/bin/env node
/**
 * 모델 비교 하네스 — 엣지 독해만 잰다.
 *
 * "모델을 바꾸면 이득이 있나" 에 감상 대신 숫자로 답하기 위한 것이다.
 * 요약문 품질은 기계로 잴 수 없다. 엣지 독해는 잴 수 있는데, 정답 세트가 없어도
 * 서로 독립된 판정 기준이 이미 두 개 있기 때문이다.
 *
 *   · verified   — 모델이 말한 채널이 파일에 문자열로 실재하는가 (llm.mjs, D5)
 *   · 정적 추출  — analyze.mjs 의 channelsOf 가 같은 채널을 찾았는가, 방향은 뭐라 했는가
 *
 * 그래서 이 하네스가 재는 것은 "모델이 똑똑한가" 가 아니라
 * **정적 파싱 위에 모델이 무엇을 더 얹어주는가** 다. README 의 표현대로
 * 모델이 더해주는 것은 방향과 문서에만 적힌 흐름이고, 그 둘이 여기서 숫자가 된다.
 *
 * 사용:
 *   AXMAP_MODEL=qwen2.5-coder:7b node app/eval/edges.mjs <대상저장소>
 *   AXMAP_MODEL=<다른모델>        node app/eval/edges.mjs <대상저장소>
 *   node app/eval/edges.mjs --compare
 *
 * 캐시는 모델별로 갈리므로(llm.mjs 의 key) 같은 모델을 다시 돌리면 즉시 끝난다.
 * 모델이 다르면 캐시가 겹치지 않는다 — 비교가 오염되지 않는 이유다.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan, channelsOf } from '../lib/analyze.mjs'
import { status, warmup, readEdges } from '../lib/llm.mjs'

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')

const slug = (model) => model.replace(/[^A-Za-z0-9._-]/g, '_')

// ---------------------------------------------------------------------------
// 한 파일의 측정
// ---------------------------------------------------------------------------

/**
 * @param st  Map<channel, 'pub'|'sub'|'unknown'|'both'>  정적 추출 결과
 * @param res readEdges 의 반환
 */
function measure(file, st, res, ms) {
  const edges = res.edges ?? []
  const verified = edges.filter((e) => e.verified)
  const seen = new Set(verified.map((e) => e.channel))

  let dirResolved = 0 // 정적이 방향을 확정 못 한 채널에 모델이 방향을 준 것 ← 부가가치
  let dirAgree = 0 // 정적도 확신했고 모델도 같은 방향
  let dirConflict = 0 // 정적은 확신했는데 모델이 반대 ← 둘 중 하나는 틀렸다
  let beyondStatic = 0 // 정적이 아예 못 본 채널인데 파일에 실재 ← 부가가치

  for (const e of verified) {
    if (!st.has(e.channel)) {
      beyondStatic++
      continue
    }
    const sd = st.get(e.channel)
    // 'both' 은 정적이 한 방향으로 확정하지 못한 상태이므로 unknown 과 같이 센다
    if (sd === 'unknown' || sd === 'both') dirResolved++
    else if (sd === e.direction) dirAgree++
    else dirConflict++
  }

  return {
    path: file.path,
    lines: file.lines,
    staticCount: st.size,
    claimed: edges.length,
    verified: verified.length,
    hallucinated: edges.length - verified.length,
    dirResolved,
    dirAgree,
    dirConflict,
    beyondStatic,
    staticMissed: [...st.keys()].filter((ch) => !seen.has(ch)).length,
    parseFailed: res.parseFailed === true,
    cached: res.cached === true,
    ms,
  }
}

const SUM_KEYS = [
  'staticCount', 'claimed', 'verified', 'hallucinated',
  'dirResolved', 'dirAgree', 'dirConflict', 'beyondStatic', 'staticMissed',
]

function totalsOf(rows) {
  const t = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]))
  for (const r of rows) for (const k of SUM_KEYS) t[k] += r[k]
  t.files = rows.length
  t.parseFailedFiles = rows.filter((r) => r.parseFailed).length
  const fresh = rows.filter((r) => !r.cached)
  t.freshFiles = fresh.length
  t.msMedian = fresh.length
    ? fresh.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(fresh.length / 2)]
    : null
  return t
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

async function run(root, nFiles) {
  const s = await status()
  // 여기서 통과시키면 "0개 찾음" 이 모델 탓인지 Ollama 탓인지 영영 구분되지 않는다.
  if (!s.available) {
    console.error(`Ollama 에 연결할 수 없습니다 (${s.host}). 켜고 다시 실행하세요.`)
    process.exit(1)
  }
  if (!s.modelReady) {
    console.error(`모델 ${s.model} 이 없습니다. 받은 것: ${s.models.join(', ') || '(없음)'}`)
    console.error(`  ollama pull ${s.model}`)
    process.exit(1)
  }

  const all = scan(root).filter((f) => !f.backup)
  if (!all.length) {
    console.error(`${root} 에서 분석할 파일을 찾지 못했습니다.`)
    process.exit(1)
  }

  // 채널이 많은 파일부터 본다. 재는 대상이 엣지 독해이므로 채널이 0인 파일을
  // 아무리 돌려도 판정에 기여하지 않는다. 대신 몇 개를 안 봤는지 반드시 찍는다.
  const ranked = all
    .map((f) => ({ f, st: channelsOf(f) }))
    .sort((a, b) => b.st.size - a.st.size || a.f.path.localeCompare(b.f.path))
  const picked = ranked.slice(0, nFiles)

  console.log(`모델   ${s.model}`)
  console.log(`대상   ${root}`)
  console.log(`파일   ${picked.length}개 (전체 ${ranked.length}개 중 채널 많은 순, ${ranked.length - picked.length}개 안 봄)\n`)

  await warmup() // 콜드 스타트 44초를 첫 파일의 측정치에 섞지 않는다

  const rows = []
  for (const { f, st } of picked) {
    const t0 = performance.now()
    const res = await readEdges(f.path, f.text)
    rows.push(measure(f, st, res, Math.round(performance.now() - t0)))
    process.stderr.write(`\r  ${rows.length}/${picked.length} ${f.path}`.padEnd(78).slice(0, 78))
  }
  process.stderr.write('\r'.padEnd(79) + '\r')

  report(rows, s.model, root)
}

function report(rows, model, root) {
  const t = totalsOf(rows)

  const head = ['파일', '정적', '주장', '실재', '환각', '방향+', '일치', '충돌', '정적밖', '누락', 'ms']
  const w = [38, 4, 4, 4, 4, 5, 4, 4, 6, 4, 6]
  const line = (cells) => cells.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join(' ')

  console.log(line(head))
  console.log('-'.repeat(w.reduce((a, b) => a + b + 1, -1)))
  for (const r of rows) {
    const name = r.path.length > w[0] ? '…' + r.path.slice(-(w[0] - 1)) : r.path
    console.log(line([
      name, r.staticCount, r.claimed, r.verified, r.hallucinated,
      r.dirResolved, r.dirAgree, r.dirConflict, r.beyondStatic, r.staticMissed,
      r.cached ? 'cache' : r.ms,
    ]) + (r.parseFailed ? '  ← 형식위반' : ''))
  }

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—')
  console.log(`\n합계 ${t.files}개 파일`)
  console.log(`  주장 ${t.claimed} · 실재 ${t.verified} · 환각 ${t.hallucinated} (${pct(t.hallucinated, t.claimed)})`)
  console.log(`  정적 위에 더한 것 : 방향 채움 ${t.dirResolved} + 정적 밖 채널 ${t.beyondStatic} = ${t.dirResolved + t.beyondStatic}`)
  console.log(`  정적과 충돌      : ${t.dirConflict}`)
  console.log(`  정적이 찾은 걸 놓침: ${t.staticMissed} / ${t.staticCount} (${pct(t.staticMissed, t.staticCount)})`)
  console.log(`  새로 추론한 파일 ${t.freshFiles}개, 중앙값 ${t.msMedian ?? '—'}ms`)

  if (t.parseFailedFiles) {
    console.log(`\n⚠ JSON 형식 위반 ${t.parseFailedFiles}개 파일.`)
    console.log(`  위 숫자는 믿을 수 없다. 모델이 사고 토큰을 뱉거나 num_predict 한도에 잘렸을 가능성이 크다.`)
    console.log(`  프롬프트/num_predict 를 그 모델에 맞추기 전까지는 품질 비교가 아니라 배관 문제다.`)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, `${slug(model)}.json`)
  fs.writeFileSync(file, JSON.stringify({ model, root, at: new Date().toISOString(), totals: t, rows }, null, 2))
  console.log(`\n기록 ${path.relative(process.cwd(), file)}`)
}

// ---------------------------------------------------------------------------
// 비교
// ---------------------------------------------------------------------------

function compare() {
  let names = []
  try {
    names = fs.readdirSync(OUT_DIR).filter((n) => n.endsWith('.json'))
  } catch {
    /* 아래에서 안내한다 */
  }
  if (names.length < 2) {
    console.error(`비교하려면 리포트가 2개 이상 필요합니다 (지금 ${names.length}개).`)
    console.error(`  AXMAP_MODEL=<모델> node app/eval/edges.mjs <대상저장소>  를 모델별로 돌리세요.`)
    process.exit(1)
  }

  const reps = names.map((n) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, n), 'utf8')))
  const roots = new Set(reps.map((r) => r.root))
  if (roots.size > 1) {
    // 대상이 다르면 숫자를 나란히 놓는 것 자체가 거짓말이다
    console.error(`대상 저장소가 서로 다릅니다: ${[...roots].join(' / ')}`)
    console.error(`같은 대상으로 다시 돌리거나 app/eval/out/ 을 비우세요.`)
    process.exit(1)
  }

  const rows = reps.map((r) => ({
    model: r.model,
    환각률: r.totals.claimed ? `${((r.totals.hallucinated / r.totals.claimed) * 100).toFixed(1)}%` : '—',
    부가가치: r.totals.dirResolved + r.totals.beyondStatic,
    충돌: r.totals.dirConflict,
    누락: r.totals.staticMissed,
    형식위반: r.totals.parseFailedFiles,
    'ms(중앙)': r.totals.msMedian ?? '—',
  }))
  console.log(`대상 ${reps[0].root} · 파일 ${reps[0].totals.files}개\n`)
  console.table(rows)
  console.log(`부가가치 = 정적이 방향을 확정 못 한 채널에 방향을 준 수 + 정적이 못 본 실재 채널 수`)
  console.log(`형식위반이 0이 아닌 모델의 숫자는 품질이 아니라 배관 문제를 보고 있는 것이다.`)
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
if (args.includes('--compare')) {
  compare()
} else {
  const root = args.find((a) => !a.startsWith('--'))
  if (!root) {
    console.error('사용: AXMAP_MODEL=<모델> node app/eval/edges.mjs <대상저장소> [--files N]')
    console.error('      node app/eval/edges.mjs --compare')
    process.exit(1)
  }
  const i = args.indexOf('--files')
  await run(root, i >= 0 ? Number(args[i + 1]) : 20)
}
