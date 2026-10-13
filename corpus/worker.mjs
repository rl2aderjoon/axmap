#!/usr/bin/env node
/**
 * 코퍼스 일꾼 — git 저장소를 돌아다니며 기준을 학습한다.
 *
 *   node corpus/worker.mjs --data <폴더> [--hours 12] [--langs python,go,...]
 *
 * ── 설계에서 물러설 수 없는 것 ────────────────────────────────────────────
 *
 * 🔴 **학습 도중에도 언제든 기준을 낼 수 있어야 한다.**
 *
 * 그래서 저장소 하나를 잴 때마다
 *   ① 레코드를 `repos.jsonl` 에 **한 줄 덧붙이고**
 *   ② 스냅샷을 `baseline.json` 에 **원자적으로 다시 쓴다**
 * 원자적 = 임시 파일에 쓰고 rename. 반쯤 쓰인 JSON 을 서버가 읽으면
 * 기준이 깨진 채로 나가는데, 그건 기준이 없는 것보다 나쁘다.
 *
 * 🔴 죽어도 이어서 한다. 상태는 전부 파일에 있고 메모리에는 없다.
 *    12시간 돌리는 것이라 반드시 한 번은 죽는다고 가정한다.
 *
 * 🔴 클론은 재고 나서 **즉시 지운다.** 안 지우면 디스크가 먼저 죽는다.
 */

import fs from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'

import { isMeasured, measureRepo, parseSeen, RECORD_SCHEMA, withRepo } from './measure.mjs'
import { addRepo, cellKey, emptyCell, snapshot } from './stats.mjs'
import { PARSER_VERSION } from '../app/lib/langs.mjs'

const args = process.argv.slice(2)
const flag = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }

const DATA = path.resolve(flag('--data') ?? path.join(process.cwd(), 'corpus-data'))
const HOURS = Number(flag('--hours') ?? 12)
const LANGS = (flag('--langs') ?? 'python,javascript,typescript,go,java,rust,ruby,c++,c,c#,php,kotlin,swift,scala')
  .split(',').map((s) => s.trim()).filter(Boolean)
const MIN_COMMITS = Number(flag('--min-commits') ?? 400)
const MAX_MB = Number(flag('--max-mb') ?? 400)   // 이보다 큰 저장소는 건너뛴다 (시간·디스크)
/**
 * 군집 하이퍼파라미터를 함께 잴 것인가.
 *
 * 기본으로 켠다. 이걸 안 재면 파일 모양 통계만 또 쌓이고 정작 답해야 할
 * 질문(칸마다 γ 가 얼마인가)에는 한 글자도 못 답한다. 계측 시간은 저장소당
 * 수 초 늘어나는데, 병목은 여전히 클론이다.
 */
const SWEEP = !process.argv.includes('--no-sweep')
const DEADLINE = Date.now() + HOURS * 3600_000

const F = {
  repos: path.join(DATA, 'repos.jsonl'),
  seen: path.join(DATA, 'seen.txt'),
  baseline: path.join(DATA, 'baseline.json'),
  skips: path.join(DATA, 'skips.jsonl'),
  log: path.join(DATA, 'worker.log'),
}

fs.mkdirSync(DATA, { recursive: true })

const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`
  console.log(line)
  try { fs.appendFileSync(F.log, `${line}\n`) } catch { /* 기록 못 해도 계속한다 */ }
}

/** 원자적 쓰기. 반쯤 쓰인 JSON 을 서버가 읽으면 기준이 깨진 채로 나간다. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/**
 * 이미 본 저장소 -> 어느 스키마로 봤나. 파싱은 measure.mjs 의 순수 함수가 한다
 * (조용한 실패라 프로세스 테스트로는 못 잡는다 — 거기서 직접 검사한다).
 */
let seen = new Map()
try {
  seen = parseSeen(fs.readFileSync(F.seen, 'utf8'))
} catch { /* 처음이면 비어 있다 */ }

const measured = (name) => isMeasured(seen, name, RECORD_SCHEMA)

/**
 * 이미 모은 레코드로 칸을 복원한다 (죽었다 살아나도 이어서).
 *
 * 🔴 **한 줄씩 흘려 읽는다. 통째로 읽으면 어느 날 조용히 전부 잃는다.**
 *
 * 예전에는 파일을 통째로 읽어 줄로 갈랐다. 잘 돌다가 `repos.jsonl` 이
 * 962MB 가 되자 V8 문자열 한계(0x1fffffe8 = 537MB)에 걸려 던졌고,
 * `catch { 처음이면 없다 }` 가 그것을 삼켰다. 그래서 **워커가 켜질 때마다
 * 누적 6,470개를 버리고 0부터 다시 셌다.**
 *
 * 조용했다는 것이 최악이다. 공개 스냅샷이 42칸·41개 usable 에서
 * 20칸·0개 usable 로 무너졌는데 로그에는 "복원한 레코드 0개" 한 줄뿐이었고,
 * 그건 첫 실행과 구분되지 않는다. `serve.mjs` 에서 같은 버그를 이미 한 번
 * 고쳤는데(`recorded` 가 0으로 떨어지던 것) 여기는 남아 있었다 —
 * 같은 실수는 한 곳에만 있지 않다.
 */
const cells = {}
let restored = 0
let bad = 0
if (fs.existsSync(F.repos)) {
  const rl = readline.createInterface({
    input: fs.createReadStream(F.repos, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    const t = line.trim()
    if (!t) continue
    let rec
    try { rec = JSON.parse(t) } catch { bad++; continue }   // 반쯤 쓰인 마지막 줄은 버린다
    const key = cellKey(rec.lang, rec.commits)
    if (!key) continue
    cells[key] ??= emptyCell()
    addRepo(cells[key], rec)
    restored++
  }
}
log(`시작 - 이미 본 저장소 ${seen.size}개 · 복원한 레코드 ${restored}개`
  + `${bad ? ` · 못 읽은 줄 ${bad}개` : ''} · 마감 ${new Date(DEADLINE).toISOString()}`)

/**
 * 🔴 본 것은 많은데 복원한 것이 없으면 **멈춘다.**
 *
 * 그 상태로 계속하면 빈 칸에서 시작한 스냅샷이 공개 스냅샷을 덮어쓴다.
 * 원본은 멀쩡한데 집계만 사라지는 것이라 알아채기 어렵다.
 * 락에서 fail-open 을 금지한 것과 같은 판단이다 - 애매하면 거부한다.
 */
if (seen.size > 100 && restored === 0) {
  log(`중단 - 본 저장소가 ${seen.size}개인데 복원한 레코드가 0개다.`)
  log('  이 상태로 스냅샷을 쓰면 누적 통계를 빈 것으로 덮어쓴다.')
  log(`  ${F.repos} 를 확인하라.`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 저장소 고르기
// ---------------------------------------------------------------------------

/**
 * GitHub 검색.
 *
 * ⚠️ 토큰 없이 쓴다 (검색 분당 10회). 클론이 훨씬 느리므로 병목이 아니다.
 * 429/403 이 오면 기다렸다 다시 한다 — 남의 API 를 두드려 패지 않는다.
 */
async function search(lang, page, stars, born) {
  // 🔴 born 이 질의를 **다른 질의로** 만든다. 아래 CREATED 주석 참조.
  const q = `language:${encodeURIComponent(lang)}+stars:${stars}+created:${born}`
  const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=100&page=${page}`
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'axmap-corpus' },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null)
    if (r?.ok) return (await r.json()).items ?? []
    const wait = r?.status === 403 || r?.status === 429 ? 70_000 : 8_000
    log(`  검색 재시도 (${r?.status ?? '연결실패'}) — ${wait / 1000}초 대기`)
    await new Promise((res) => setTimeout(res, wait))
  }
  return []
}

/**
 * 다음에 잴 저장소.
 *
 * 🔴 언어와 별 구간을 **돌아가며** 뽑는다.
 *
 * 한 언어만 몰아서 하면 12시간 뒤 파이썬 기준만 생긴다. 그리고 별 상위만
 * 보면 "인기 저장소를 흉내내라" 가 되므로 별 구간도 넓게 돈다 —
 * 중간 규모 저장소가 실제로 사람들이 일하는 자리다.
 */
const STAR_RANGES = ['500..1500', '1500..5000', '5000..20000', '>20000']

/**
 * 🔴 생성 연도 구간. **이것이 없으면 며칠 뒤 반드시 멈춘다.**
 *
 * GitHub 검색은 질의 하나당 최대 1,000개(100개 × 10쪽)만 돌려준다. 그래서
 * 예전 격자(언어 14 × 별 4)의 도달 상한은 56,000개로 못박혀 있었고, 실제로
 * 31,553개를 본 시점에 **검색이 전부 이미 본 것만 뱉기 시작했다.** 1시간 45분
 * 동안 새로 기록된 저장소가 0개였고, `검색 지면을 다 돌았다` 가 10번 찍히며
 * 같은 질의를 4시간마다 다시 돌고 있었다.
 *
 * 생성 연도를 쪼개면 **질의마다 1,000개 예산이 새로 생긴다.** 구간 6개면
 * 도달 상한이 6배가 된다.
 *
 * 그리고 이것은 고갈 대책이면서 동시에 **편향 대책**이다. 별은 시간이 지나야
 * 쌓이므로 별 정렬로 뽑으면 오래된 저장소만 걸린다 — 실제로 옛 코퍼스는
 * 나이 중앙값이 8.0년이었고 3년 미만은 13.9% 뿐이었다. large 칸은 중앙값이
 * 11.0년이라 "큰 프로젝트는 이런 모습" 이 사실은 10년 전 방식이었다.
 * 연도로 쪼개면 젊은 저장소가 자기 몫의 질의를 갖는다.
 */
const CREATED = [
  '<2014-01-01',
  '2014-01-01..2016-12-31',
  '2017-01-01..2019-12-31',
  '2020-01-01..2021-12-31',
  '2022-01-01..2023-12-31',
  '>2024-01-01',
]

/** 검색 한 번에서 큐에 넣을 최대 개수. 위 주석 참조 — 넓이가 먼저다. */
const PER_SEARCH = 12
let pick = 0
const queue = []

async function nextRepo() {
  while (!queue.length) {
    // 언어 → 별 구간 → 생성 연도 → 쪽 순으로 자릿수가 올라간다.
    // 안쪽일수록 자주 바뀌므로 언어가 제일 안쪽이다 (한 언어만 몰아 돌지 않게).
    const lang = LANGS[pick % LANGS.length]
    const stars = STAR_RANGES[Math.floor(pick / LANGS.length) % STAR_RANGES.length]
    const bornIdx = Math.floor(pick / (LANGS.length * STAR_RANGES.length)) % CREATED.length
    const born = CREATED[bornIdx]
    const page = 1 + Math.floor(pick / (LANGS.length * STAR_RANGES.length * CREATED.length))
    pick++
    if (page > 10) { log('검색 지면을 다 돌았다 — 처음부터 다시'); pick = 0; continue }
    const items = await search(lang, page, stars, born)
    log(`검색 ${lang} · 별 ${stars} · 생성 ${born} · ${page}쪽 → ${items.length}개`)
    /**
     * 🔴 검색 한 번에서 **조금만** 가져온다.
     *
     * 처음에는 100개를 통째로 큐에 넣었다. 저장소 하나에 약 75초가 걸리므로
     * 그러면 **파이썬만 2시간 동안 돈다.** 12시간 뒤에 파이썬 기준만 생기고
     * "언어별로 다르다" 는 말을 못 하게 된다.
     *
     * 언어 14 × 별 구간 4 = 56칸을 골고루 채우려면 칸마다 조금씩 여러 번
     * 도는 편이 낫다. 기준은 넓이가 깊이보다 먼저다 — 한 언어를 아주 잘 아는
     * 것보다 여러 언어를 쓸 만큼 아는 쪽이 지금 필요하다.
     */
    let taken = 0
    for (const it of items) {
      if (taken >= PER_SEARCH) break
      if (measured(it.full_name)) continue
      if (it.archived && it.size > MAX_MB * 1024) continue
      if (it.size > MAX_MB * 1024) continue           // KB 단위다
      taken++
      queue.push({
        full_name: it.full_name,
        url: it.clone_url,
        lang: (it.language ?? '').toLowerCase() || null,
        stars: it.stargazers_count,
        sizeKB: it.size,
        archived: !!it.archived,
      })
    }
    if (!queue.length) await new Promise((r) => setTimeout(r, 3000))
  }
  return queue.shift()
}

// ---------------------------------------------------------------------------

function saveSnapshot() {
  // 지금 파서 도장을 넘긴다. 그래야 커버리지를 같은 도장끼리만 평균 낸다.
  const snap = snapshot(cells, { at: new Date().toISOString(), parser: PARSER_VERSION })
  writeAtomic(F.baseline, JSON.stringify({
    ...snap,
    reposSeen: seen.size,
    // 🔴 어느 스냅샷 기준인지 없으면 조언이 소리 없이 바뀐다.
    version: seen.size,
    generator: 'axmap corpus worker',
  }, null, 1))
}

function markSeen(name) {
  seen.set(name, RECORD_SCHEMA)
  // 덧붙이기만 한다. 같은 이름이 여러 줄 생겨도 읽을 때 큰 쪽을 쓴다 —
  // 줄을 고쳐 쓰면 두 워커가 같은 파일을 쓸 때 서로를 덮어쓴다.
  fs.appendFileSync(F.seen, `${name}\t${RECORD_SCHEMA}\n`)
}

let done = 0
let failed = 0

async function main() {
  saveSnapshot()   // 처음부터 뭔가는 답할 수 있어야 한다
  while (Date.now() < DEADLINE) {
    let r
    try { r = await nextRepo() } catch (e) { log(`고르기 실패: ${e.message}`); await new Promise((s) => setTimeout(s, 10_000)); continue }
    if (!r) break

    const t0 = Date.now()
    try {
      const rec = withRepo(r.url, r.full_name.replace(/[^\w.-]/g, '_'), (dir) =>
        measureRepo(dir, { full_name: r.full_name, lang: r.lang, stars: r.stars, archived: r.archived },
          { sweep: SWEEP }))

      if (rec.commits < MIN_COMMITS) {
        fs.appendFileSync(F.skips, `${JSON.stringify({ name: r.full_name, why: `커밋 ${rec.commits}개`, at: new Date().toISOString() })}\n`)
        markSeen(r.full_name)
        log(`  건너뜀 ${r.full_name} — 커밋 ${rec.commits}개`)
        continue
      }

      const key = cellKey(rec.lang, rec.commits)
      if (!key) {
        fs.appendFileSync(F.skips, `${JSON.stringify({ name: r.full_name, why: '언어·규모 칸 없음', at: new Date().toISOString() })}\n`)
        markSeen(r.full_name)
        continue
      }

      // 🔴 레코드를 먼저 남긴다. 스냅샷은 레코드에서 다시 만들 수 있지만
      //    레코드는 다시 만들려면 저장소를 또 받아야 한다.
      fs.appendFileSync(F.repos, `${JSON.stringify(rec)}\n`)
      cells[key] ??= emptyCell()
      addRepo(cells[key], rec)
      markSeen(r.full_name)
      saveSnapshot()
      done++
      log(`✓ ${r.full_name} [${key}] 커밋 ${rec.commits} · 파일 ${rec.fileCount} · `
        + `파서 ${(rec.parseCoverage * 100).toFixed(0)}% · fix ${(rec.fixCommitRatio * 100).toFixed(0)}% · `
        + `${((Date.now() - t0) / 1000).toFixed(0)}초 (누적 ${done})`)
    } catch (e) {
      failed++
      markSeen(r.full_name)   // 같은 것에 계속 걸리지 않게 한다
      fs.appendFileSync(F.skips, `${JSON.stringify({ name: r.full_name, why: e.message.slice(0, 200), at: new Date().toISOString() })}\n`)
      log(`✗ ${r.full_name} — ${e.message.slice(0, 120)}`)
    }
  }
  saveSnapshot()
  log(`마감 — 성공 ${done} · 실패 ${failed} · 본 것 ${seen.size}`)
}

main().catch((e) => { log(`치명적: ${e.stack}`); process.exit(1) })
