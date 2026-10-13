/**
 * 저장소 하나를 재서 레코드 하나로 만든다.
 *
 * 여기만 git 과 fs 를 만진다. 집계(stats.mjs)는 순수 함수다.
 *
 * ── 무엇을 재는가 ─────────────────────────────────────────────────────────
 *
 *   파일마다   길이 · 그 파일을 건드린 커밋 수 · 디렉터리 깊이
 *              공변경 팬아웃(함께 바뀌는 이웃 수)
 *              🔴 재수정률 — 그 파일을 건드린 커밋 중 "고침" 커밋의 비율
 *
 *   저장소마다 언어 · 커밋 수 · 기여자 수 · 나이
 *              🔴 우리 파서의 커버리지 (내부 import 중 몇 개를 실제로 이었나)
 *
 * ── 🔴 왜 재수정률인가 ───────────────────────────────────────────────────
 *
 * 인기 저장소를 긁어 "이렇게 하세요" 라고 하면 생존 편향을 규범으로 만든다.
 * 별 개수는 코드 품질의 증거가 아니다.
 *
 * git 안에서 관측 가능한 결과 신호 중 가장 곧은 것이 **나중에 고치게 됐는가**
 * 다. 커밋 제목에 fix/bug/hotfix/수정 이 들어간 커밋이 그 파일을 얼마나
 * 자주 건드렸는지를 센다.
 *
 * ⚠️ 완벽하지 않다. 팀마다 커밋 관습이 다르고, `fix` 를 안 쓰는 저장소에서는
 *    0에 몰린다. 그래서 저장소별 fix 커밋 비율을 함께 기록해서, 집계 쪽에서
 *    관습이 없는 저장소를 걸러낼 수 있게 한다.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { build, scan } from '../app/lib/analyze.mjs'
import { PARSER_VERSION } from '../app/lib/langs.mjs'
import { sweepRepo } from './clustersweep.mjs'

/**
 * 레코드 스키마 번호. **지표를 더하거나 뺄 때 올린다.**
 *
 * 🔴 이것이 없으면 새 지표를 넣어도 옛 저장소를 영영 다시 못 잰다.
 *
 * `seen.txt` 는 저장소 **이름만** 들고 있었다. 그래서 "봤다" 와 "지금 쓰는
 * 지표로 쟀다" 가 같은 값이 됐고, 군집 스윕을 넣은 날 옛 레코드 전부가
 * 재측정 대상에서 조용히 빠졌다 — 사람이 알아채지 못한 채로.
 *
 * 이제 seen 은 `이름<TAB>스키마` 이고, 워커는 자기 스키마보다 낮은 것을
 * 자동으로 다시 잡는다. **무엇을 다시 재야 하는가가 사람의 기억이 아니라
 * 질의가 된다.**
 *
 * 파서 버전은 여기 넣지 않는다. 파서가 언어를 하나 더 읽게 됐다고 수만 개를
 * 다시 재지 않는다 — 그건 `ssot.mjs` 가 `coverage.from` (current/mixed/stale)
 * 으로 이미 다루는 문제다. 이 번호는 **레코드의 모양**만 가리킨다.
 *
 *   1  파일 모양 통계까지
 *   2  군집 하이퍼파라미터 스윕(`cluster`) 추가
 */
export const RECORD_SCHEMA = 2

/**
 * seen.txt 를 읽는다 — `이름<TAB>스키마`, 탭이 없으면 옛 줄.
 *
 * 순수 함수로 빼 둔 이유: 이 판정이 틀리면 **재측정이 조용히 안 일어난다.**
 * 조용한 실패는 프로세스를 돌려 보는 테스트로 못 잡는다 — 옛 코드로도
 * "이미 본 저장소 N개" 는 똑같이 찍히기 때문이다. 실제로 그 함정에 한 번
 * 빠져서, 통과하지만 아무것도 판별 못 하는 테스트를 썼다.
 */
export function parseSeen(text) {
  const out = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const tab = t.indexOf('\t')
    if (tab < 0) { out.set(t, Math.max(out.get(t) ?? 0, 0)); continue }
    const name = t.slice(0, tab)
    const v = Number(t.slice(tab + 1))
    // 🔴 숫자가 아니면 0 으로 친다. 지어낸 값으로 통과시키지 않는다 —
    //    애매한 것을 최신으로 둔갑시키면 낡은 값이 기준으로 나간다.
    out.set(name, Math.max(out.get(name) ?? -1, Number.isFinite(v) ? v : 0))
  }
  return out
}

/** 이 저장소를 `schema` 로 이미 쟀는가. 애매하면 안 쟀다고 답한다. */
export const isMeasured = (seen, name, schema = RECORD_SCHEMA) =>
  (seen.get(name) ?? -1) >= schema

/** 커밋 제목이 "고침" 인가. 관습이 다양해서 넓게 잡되 근거를 남긴다. */
const FIX_RE = /\b(fix(e[sd])?|bug(fix)?|hotfix|patch|regression|revert|broken|crash|issue\s*#?\d+)\b|버그|고침|수정|오류|장애/i

/**
 * 테스트·문서 파일 판별. 경로로만 본다 — **언어와 무관**해야 하기 때문이다.
 * (flow.mjs 의 소비자 판정과 같은 계열)
 */
const TEST_RE = /(^|\/)(tests?|spec|specs|__tests__|testing|e2e)(\/|$)|(^|\/)test_[^/]*$|[._-](test|spec)\.[^/.]+$|Tests?\.[a-z]+$/i
const DOC_RE = /(^|\/)(docs?|documentation|website|guides?)(\/|$)|\.(md|mdx|rst|adoc)$/i

/**
 * 신입이 처음 건드린 파일을 셀 때, 한 사람의 **첫 몇 커밋**까지 볼 것인가.
 *
 * 🔴 이 숫자가 곧 "신입" 의 정의다.
 *
 * 크게 잡으면 그 사람이 이미 익숙해진 뒤의 커밋이 섞여 "처음 밟은 길" 이
 * 아니게 되고, 작게 잡으면 오타 수정 한 건이 그 사람의 전부가 된다.
 * 5로 둔다 — 근거는 없다. 코퍼스가 쌓이면 이 값도 재산정할 수 있다 (Q5 와 같은 문제).
 */
const FIRST_COMMITS = 5

/**
 * 결합도→재수정률 판정에 이 저장소를 쓸 것인가.
 *
 * 🔴 파서가 눈먼 저장소를 섞으면 관계가 통째로 깨진다.
 *
 * 실측(코퍼스 388개): ruby 커버리지 8%, c# 3%. 그 저장소들은 거의 모든 파일이
 * 결합 0으로 잡힌다. 그대로 넣으면 "결합 0인 파일이 수만 개인데 재수정률은
 * 제각각" 이 되어, 우리 제품의 핵심 가설을 우리 파서의 눈먼 정도로 반박하게 된다.
 */
const DEG_MIN_COVERAGE = 0.6

/** 한 커밋이 이보다 많은 파일을 건드리면 버린다 (cochange.mjs 와 같은 판단). */
const MAX_FILES_PER_COMMIT = 50

/** 커밋을 이 개수까지만 본다. 커널 같은 것에서 12시간이 한 저장소로 다 간다. */
const MAX_COMMITS = 20000

const git = (dir, args, timeout = 300_000) => {
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout, windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`git ${args[0]} 실패: ${(r.stderr ?? '').trim().slice(0, 200)}`)
  return r.stdout ?? ''
}

/**
 * blobless 클론. 공변경에는 커밋과 트리만 있으면 된다.
 *
 * 🔴 rename 탐지를 끈다. blobless 에서 켜 두면 커밋마다 네트워크를 타서
 *    실질적으로 못 돌린다 (cochange.mjs 주석의 307배 실측).
 *    잃는 것: 이름이 바뀐 파일의 히스토리가 끊긴다 → 커밋 수가 **적게** 나온다.
 *    fail-closed 쪽이라 조용히 부풀리지는 않는다.
 */
export function cloneRepo(url, dir, { depth = null, timeout = 900_000 } = {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const args = ['clone', '--filter=blob:none', '--single-branch', '--quiet']
  if (depth) args.push(`--depth=${depth}`)
  args.push(url, dir)
  const r = spawnSync('git', args, { encoding: 'utf8', timeout, windowsHide: true })
  if (r.status !== 0) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 못 지우면 그대로 */ }
    throw new Error(`클론 실패: ${(r.stderr ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200)}`)
  }
}

/** 커밋 목록 — 제목과 파일. */
export function readCommits(dir) {
  const raw = git(dir, [
    'log', `-n${MAX_COMMITS}`, '--no-merges', '--no-renames',
    '--format=%x01%H%x02%at%x02%an%x02%s', '--name-only',
  ])
  const out = []
  let cur = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      const [hash, at, author, ...rest] = line.slice(1).split('\x02')
      cur = { hash, at: Number(at) * 1000, author, subject: rest.join('\x02'), files: [] }
      out.push(cur)
      continue
    }
    const t = line.trim()
    if (t && cur) cur.files.push(t)
  }
  return out
}

/**
 * 우리 파서가 이 저장소에서 얼마나 보고 있나.
 *
 * 🔴 이 숫자가 없으면 코퍼스가 조용히 편향된다.
 *
 * 우리가 잘 못 읽는 언어일수록 결합도가 낮게 나오고, 그러면 기준이
 * 그 언어 팀에게 "당신들은 건강합니다" 라고 말한다 — 사실은 못 본 것뿐인데.
 * 실측으로 겪었다: syft(Go) 정적 엣지 1개, baritone(Java) 0개,
 * clips/pattern 은 내부 import 304개 중 48개(16%).
 */
export function parseCoverage(root, graph) {
  const files = graph.nodes.length
  const parsed = graph.nodes.filter((n) => n.parsed !== false && n.lang !== 'other' && n.lang !== 'data').length
  const imports = graph.edges.filter((e) => e.kind === 'import')

  /**
   * 🔴 **그려지는 엣지만 센다.** `hub:true` 는 "알지만 안 그린다" 는 뜻이고
   *    (D9), `deg` 와 기본 화면에서 이미 빠져 있다. 여기서 같이 세면
   *    사람이 보는 것과 지표가 재는 것이 갈린다.
   */
  const drawn = imports.filter((e) => !e.hub)

  /**
   * 🔴 커서 안 그린 import 의 수. `edgesPerFile` 이 0 에 가까울 때 이것이
   *    0 이 아니면, 그 저장소는 **결합이 없는 것이 아니라 모듈이 큰 것**이다.
   *
   *    스위프트에서 이 구별이 없으면 코퍼스가 반대로 속는다. 모듈 하나가
   *    수십 개 파일이라 상한을 넘는 것이 기본값인데, 그것을 "엣지 0" 으로만
   *    기록하면 `MIN_COVERAGE_FOR_COUPLING` 게이트가 막으라고 만들어진 바로
   *    그 거짓말("이 저장소는 잘 분리돼 있군요")을 승인하게 된다.
   */
  const wideImports = (graph.wideModules ?? []).reduce((a, m) => a + m.importers, 0)

  return {
    files,
    parsedFiles: parsed,
    staticEdges: drawn.length,
    // 파일당 정적 엣지. 0 에 가까우면 그 저장소의 import 축은 못 믿는다.
    edgesPerFile: files ? drawn.length / files : 0,
    wideImports,
    ratio: files ? parsed / files : 0,
  }
}

/**
 * 저장소 하나를 잰다.
 *
 * @returns 레코드 (JSON 으로 그대로 한 줄 저장)
 */
export function measureRepo(dir, meta = {}, { sweep = false } = {}) {
  const t0 = Date.now()
  const commits = readCommits(dir)
  if (!commits.length) throw new Error('커밋이 없다')

  const files = scan(dir, { maxFiles: 6000 })
  const graph = build(files)
  const cov = parseCoverage(dir, graph)

  // ── 파일별 카운트 ────────────────────────────────────────────────────
  const touch = new Map()      // path -> 건드린 커밋 수
  const fixTouch = new Map()   // path -> 그중 고침 커밋 수
  const together = new Map()   // path -> Map(이웃 -> 함께 바뀐 횟수)
  const byAuthor = new Map()   // path -> Map(작성자 -> 횟수)
  const withTest = new Map()   // path -> 테스트도 함께 바뀐 커밋 수
  const withDoc = new Map()    // path -> 문서도 함께 바뀐 커밋 수
  const authorCommits = new Map() // 작성자 -> [{at, files}]
  const authors = new Set()
  let fixCommits = 0
  let usedCommits = 0
  let testFiles = 0
  let docFiles = 0

  for (const c of commits) {
    authors.add(c.author)
    const isFix = FIX_RE.test(c.subject)
    if (isFix) fixCommits++
    const uniq = [...new Set(c.files)]
    if (!uniq.length) continue
    for (const f of uniq) {
      touch.set(f, (touch.get(f) ?? 0) + 1)
      if (isFix) fixTouch.set(f, (fixTouch.get(f) ?? 0) + 1)
      // 누가 이 파일을 얼마나 만졌나 — 지식이 한 사람에게 몰려 있는지 본다
      if (!byAuthor.has(f)) byAuthor.set(f, new Map())
      const m = byAuthor.get(f)
      m.set(c.author, (m.get(c.author) ?? 0) + 1)
    }

    // 이 커밋에 테스트·문서가 함께 있었나 (경로로만 본다 — 언어 무관)
    const hasTest = uniq.some((f) => TEST_RE.test(f))
    const hasDoc = uniq.some((f) => DOC_RE.test(f))
    for (const f of uniq) {
      if (hasTest && !TEST_RE.test(f)) withTest.set(f, (withTest.get(f) ?? 0) + 1)
      if (hasDoc && !DOC_RE.test(f)) withDoc.set(f, (withDoc.get(f) ?? 0) + 1)
    }

    // 작성자별 커밋 — 나중에 "그 사람의 첫 커밋" 을 고른다
    if (!authorCommits.has(c.author)) authorCommits.set(c.author, [])
    authorCommits.get(c.author).push({ at: c.at, files: uniq })

    // 🔴 대량 커밋은 공변경에서 뺀다. 일괄 포맷팅 한 번이 모든 파일을 서로 잇는다.
    if (uniq.length > MAX_FILES_PER_COMMIT) continue
    usedCommits++
    for (const a of uniq) {
      if (!together.has(a)) together.set(a, new Map())
      const m = together.get(a)
      // Set 이 아니라 **횟수**를 센다. 엔트로피(동반이 얼마나 정해져 있나)에 필요하다.
      for (const b of uniq) if (b !== a) m.set(b, (m.get(b) ?? 0) + 1)
    }
  }

  /**
   * 🔴 신입이 처음 건드린 파일.
   *
   * 지금 우리 진입점은 **우리가 추측한 것**이다 — 매니페스트·main 함수·파일명.
   * 이건 수백 개 저장소에서 **실제 사람들이 밟은 길**이다. 관찰이지 추측이 아니다.
   *
   * 사람마다 자기 첫 커밋 몇 개를 보고, 거기 나온 파일에 표를 준다.
   *
   * ⚠️ 한계: 오타 하나 고치고 떠난 사람도 한 표를 갖는다. 그래서 표를 정규화하지
   *    않고 **원시 표 수와 작성자 수를 함께** 낸다 — 걸러내는 것은 집계 쪽 몫이다.
   */
  const firstTouch = new Map()
  for (const [, list] of authorCommits) {
    list.sort((x, y) => x.at - y.at)
    const mine = new Set()
    for (const c of list.slice(0, FIRST_COMMITS)) {
      for (const f of c.files) {
        if (mine.has(f)) continue   // 같은 사람이 두 번 세지 않게
        mine.add(f)
        firstTouch.set(f, (firstTouch.get(f) ?? 0) + 1)
      }
    }
  }

  for (const n of graph.nodes) {
    if (TEST_RE.test(n.id)) testFiles++
    else if (DOC_RE.test(n.id)) docFiles++
  }

  /** 정적 import 차수 — 이 파일에 붙은 import 엣지 수. */
  const deg = new Map()
  for (const e of graph.edges) {
    if (e.kind !== 'import') continue
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }

  /**
   * 동반 예측도 — 이 파일이 바뀔 때 따라오는 것이 얼마나 정해져 있나.
   *
   * 정규화 섀넌 엔트로피. 0 에 가까우면 **늘 같은 짝**과 바뀌고(진짜 모듈),
   * 1 에 가까우면 매번 다른 것과 바뀐다(허브·만능 파일).
   *
   * 🔴 지금 우리 허브 판정(hubCap 6)은 "이웃이 몇 개냐" 만 본다. 이웃이 많아도
   *    늘 같은 이웃이면 그건 큰 모듈이지 허브가 아니다. 엔트로피는 그 둘을 가른다.
   *
   * 이웃이 하나뿐이면 엔트로피가 정의상 0인데 그건 "예측된다" 가 아니라
   * "표본이 없다" 이므로 null 을 낸다 (fail-closed).
   */
  const MIN_COMMITS_FOR_SHAPE = 5

  const shapeOf = (m, commits) => {
    /**
     * 🔴 커밋이 적으면 이 지표들은 **뜻이 없다.**
     *
     * 실측에서 바로 물렸다. 커밋 1회에 이웃 5개인 파일은 이웃이 전부 1번씩
     * 나오므로 균등분포가 되어 정규화 엔트로피가 정확히 1.00 이 된다.
     * 그건 "아무거나와 바뀐다(허브)" 가 아니라 **"표본이 없다"** 다.
     * 그대로 두면 새로 만든 파일이 전부 허브로 잡힌다.
     */
    if (!m || m.size < 2 || commits < MIN_COMMITS_FOR_SHAPE) return { entropy: null, partnerShare: null }
    let total = 0
    for (const v of m.values()) total += v
    if (!total) return { entropy: null, partnerShare: null }
    let h = 0
    for (const v of m.values()) { const q = v / total; h -= q * Math.log(q) }
    /**
     * 상위 3개 짝이 동반의 몇 %를 차지하나.
     *
     * 정규화 엔트로피는 이웃 수로 나누기 때문에 "고르게 퍼졌나" 만 말하고
     * **몇 개에 몰렸나**는 말하지 못한다. 사람이 알고 싶은 것은 후자다 —
     * "이 파일을 고치면 보통 저 둘도 고친다" 가 쓸모 있는 문장이다.
     *
     * 높다 = 정해진 짝이 있다(진짜 모듈) · 낮다 = 아무거나와 바뀐다(허브)
     */
    const top = [...m.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, v) => a + v, 0)
    return { entropy: h / Math.log(m.size), partnerShare: top / total }
  }

  const rows = []
  for (const n of graph.nodes) {
    const t = touch.get(n.id) ?? 0
    // 🔴 히스토리가 없는 파일은 결과 신호를 낼 수 없다. 0 으로 치면
    //    "새로 만든 파일은 전부 완벽하다" 는 뜻이 되어 분포가 무너진다.
    const fixRate = t > 0 ? (fixTouch.get(n.id) ?? 0) / t : null
    const am = byAuthor.get(n.id)
    const shape = shapeOf(together.get(n.id), t)
    let topAuthor = 0
    if (am) for (const v of am.values()) if (v > topAuthor) topAuthor = v
    rows.push({
      lines: n.lines,
      commits: t,
      depth: n.id.split('/').length - 1,
      fanout: together.get(n.id)?.size ?? 0,
      fixRate,
      lang: n.lang,
      // 정적 import 차수. 커버리지가 낮은 저장소에서는 집계가 쓰지 않는다.
      deg: deg.get(n.id) ?? 0,
      // 지식 집중도 — 이 파일 커밋의 몇 %가 한 사람에게서 나왔나. 1이면 그 사람만 안다.
      authorShare: t > 0 && am ? topAuthor / t : null,
      authorsOnFile: am?.size ?? 0,
      // 동반이 얼마나 정해져 있나. 커밋이 적으면 둘 다 null (위 주석 참조)
      entropy: shape.entropy,
      // 상위 3개 짝이 차지하는 비율. 높다 = 정해진 짝이 있다(모듈)
      partnerShare: shape.partnerShare,
      // 테스트·문서를 같이 고치는 비율. 테스트가 아예 없는 저장소에서는 null.
      testWith: t > 0 && testFiles > 0 && !TEST_RE.test(n.id) ? (withTest.get(n.id) ?? 0) / t : null,
      docWith: t > 0 && docFiles > 0 && !DOC_RE.test(n.id) ? (withDoc.get(n.id) ?? 0) / t : null,
      // 몇 명이 자기 첫 커밋에서 이 파일을 만났나
      firstTouch: firstTouch.get(n.id) ?? 0,
    })
  }

  const firstAt = commits[commits.length - 1]?.at ?? null
  const lastAt = commits[0]?.at ?? null

  return {
    ...meta,
    commits: commits.length,
    commitsUsed: usedCommits,
    authors: authors.size,
    // 저장소가 fix 관습을 쓰는가. 0 에 가까우면 재수정률이 뜻이 없다.
    fixCommitRatio: commits.length ? fixCommits / commits.length : 0,
    firstAt,
    lastAt,
    ageDays: firstAt && lastAt ? Math.round((lastAt - firstAt) / 86400000) : null,
    parseCoverage: cov.ratio,
    // 🔴 잰 순간에 읽을 수 있던 언어들. 이게 없으면 옛 기록과 새 기록이
    //    섞여 평균이 되고, 새 파서를 붙여도 게이트가 안 열린다.
    parser: PARSER_VERSION,
    // 레코드가 스스로 어느 모양인지 말한다. seen.txt 가 없어져도 이건 남는다.
    schema: RECORD_SCHEMA,
    edgesPerFile: cov.edgesPerFile,
    staticEdges: cov.staticEdges,
    // 커서 안 그린 import 수. 0 이 아니면 '결합 없음' 이라고 읽으면 안 된다.
    wideImports: cov.wideImports,
    fileCount: graph.nodes.length,
    loc: graph.nodes.reduce((a, n) => a + (n.lines ?? 0), 0),
    testFiles,
    docFiles,
    /**
     * 🔴 군집 하이퍼파라미터. 여기서 재는 이유는 **이미 읽어둔 것을 다시 안
     *    읽기 위해서**다. 커밋(git log)과 그래프(파일 전체 파싱)가 저장소
     *    하나당 계측 시간의 대부분인데, 스윕을 따로 돌리면 그 둘을 두 번 한다.
     *
     * 끄고 켤 수 있게 둔 것은 옛 레코드와 새 레코드가 섞이기 때문이다 —
     * 이 칸이 없는 레코드는 "군집을 안 잰 것" 이지 "못 잰 것" 이 아니다.
     */
    cluster: sweep ? sweepRepo(graph.nodes.map((n) => n.id), graph.edges, commits) : null,
    // 신입 경로를 정규화할 때 필요한 분모
    authorCount: authorCommits.size,
    // 신입들이 자기 첫 커밋에서 가장 많이 만난 파일 — 관찰된 진입로
    newcomerTop: [...firstTouch.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([path, n]) => ({ path, authors: n })),
    // 결합도→재수정률 판정에 이 저장소를 쓸 수 있는가 (위 DEG_MIN_COVERAGE 주석)
    degUsable: cov.ratio >= DEG_MIN_COVERAGE,
    files: rows,
    measuredMs: Date.now() - t0,
  }
}

/** 임시 작업 폴더. 잰 다음에는 반드시 지운다 — 안 지우면 디스크가 먼저 죽는다. */
export const workDir = (name) => path.join(os.tmpdir(), 'axmap-corpus', name)

export function withRepo(url, name, fn) {
  const dir = workDir(name)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 없으면 그만 */ }
  try {
    cloneRepo(url, dir)
    return fn(dir)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 못 지우면 다음 실행이 지운다 */ }
  }
}

export { DEG_MIN_COVERAGE, DOC_RE, FIRST_COMMITS, FIX_RE, MAX_FILES_PER_COMMIT, TEST_RE, execFileSync }
