/**
 * 기능 범위 — "사진 업로드만 보여줘" 에 답한다.
 *
 * 이름으로 찾으면 안 된다. immich 에서 `upload` 로 파일명을 걸면 2개가 나오는데,
 * 실제 업로드 기능은 asset-media.controller · asset-media.service · media.repository
 * 로 퍼져 있다. 기능의 이름과 파일의 이름은 원래 다르다.
 *
 * 그래서 씨앗을 세 곳에서 뽑는다.
 *
 *   1. 경로/파일명 매칭        확실하지만 좁다
 *   2. **커밋 메시지 매칭**     사람이 "이건 업로드 작업이다" 라고 이미 적어놨다
 *   3. 공변경 확장             씨앗과 반복해서 함께 바뀐 것
 *
 * 2번이 핵심이다. 커밋 메시지는 **의도의 기록**이고, 그 커밋이 건드린 파일이
 * 곧 그 기능의 실제 범위다. 코드 어디에도 "이건 업로드다"라고 적혀 있지 않아도
 * 사람은 커밋할 때 그렇게 적었다.
 *
 * LLM 없이 돌아간다. 전부 결정론적이라 같은 질의는 같은 답을 준다.
 */

import { execFileSync } from 'node:child_process'
import { expandTerm } from './terms.ko.mjs'

/** 이 이상의 파일을 건드린 커밋은 씨앗 계산에서 뺀다 (cochange.mjs 와 같은 이유). */
const MAX_FILES = 50
/** 최소 이만큼의 매칭 커밋에 등장해야 핵심으로 친다. */
const MIN_HITS = 2
/**
 * 재현율 — "이 기능 커밋 중 몇 %가 이 파일을 건드렸나".
 *
 * 🔴 절대 문턱을 걸면 안 된다. 방향이 거꾸로 된다.
 *
 * syft 에서 실측된 상황이다. 문턱 0.12 를 절대값으로 걸었더니 —
 *
 *   "package detection"  매칭 커밋 355 · 사용 236  →  파일 0개
 *      파일 하나가 살아남으려면 236 × 0.12 = 28개 커밋에 나와야 한다
 *   "detection"          매칭 커밋  52 · 사용  38  →  파일 10개
 *      여기서는 4.5개만 넘으면 된다
 *
 * **질의가 넓을수록 문턱이 올라가 결과가 줄어든다.** 사용자가 넓게 물으면
 * 넓은 답을 기대하는데 정반대가 나온다. 그리고 결과는 0 아니면 수백 개로
 * 갈렸다 — `cataloger` 는 저장소 1,244개 중 592개를 내놨다.
 *
 * 그래서 **상대 문턱**으로 바꾼다. 1등 파일의 재현율을 기준으로 자르므로
 * 질의 폭에 따라 문턱이 함께 움직인다. 최소 하나는 항상 살아남는다.
 */
const REL_FLOOR = 0.25   // 1등의 이 비율 아래면 버린다
const ABS_FLOOR = 0.03   // 그래도 이보다 낮으면 스친 것이다
const TOP_K = 30         // 상위 몇 개까지 보여줄까

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8', maxBuffer: 1 << 30,
  })
}

/** 정규식 특수문자를 죽인다. 질의는 사람이 치는 자유 문자열이다. */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 주어진 기간 안에서 파일별 커밋 수를 센다. 정밀도의 **분모**다.
 *
 * 왜 기간으로 자르나. 파일의 생애 전체 커밋으로 나누면, 오래 살아남은 중심
 * 파일일수록 어떤 기능에도 못 속하게 된다 (호출부 주석 참조).
 * "그 기능을 손대던 시기" 로 좁히면 그 왜곡이 사라진다.
 *
 * 기간을 못 구하면 null 을 돌려주고, 호출부가 생애 커밋 수로 물러선다.
 */
function windowCounts(root, prefix, ids, window) {
  const out = new Map()
  if (!window) return out
  let raw
  try {
    raw = git(root, [
      'log', '--no-merges', '--pretty=format:@', '--name-only',
      // git 은 초 단위 유닉스 시각을 받는다. 경계를 하루씩 넉넉히 잡는다 —
      // 커밋 시각과 작성 시각이 다를 수 있고, 경계에서 1건 차이로 분모가
      // 분자보다 작아지면 정밀도가 1을 넘어 숫자가 아니라 버그로 읽힌다.
      `--since=${Math.floor(window.from) - 86400}`,
      `--until=${Math.ceil(window.to) + 86400}`,
    ])
  } catch {
    return out
  }
  for (const line of raw.split('\n')) {
    if (line.startsWith('@')) continue
    let f = line.trim()
    if (!f) continue
    if (prefix) { if (!f.startsWith(prefix)) continue; f = f.slice(prefix.length) }
    if (ids.has(f)) out.set(f, (out.get(f) ?? 0) + 1)
  }
  return out
}

/**
 * @param {string} root        저장소 경로
 * @param {string} query       사람이 친 질의 ("upload", "album share" 등)
 * @param {object} ctx
 * @param {Set<string>} ctx.ids      그래프에 있는 노드
 * @param {Map<string,number>} ctx.freq  파일별 전체 등장 커밋 수
 * @param {object[]} ctx.coEdges     공변경 엣지
 */
export function featureScope(root, query, { ids, freq, coEdges }, {
  minHits = MIN_HITS, relFloor = REL_FLOOR, absFloor = ABS_FLOOR, topK = TOP_K,
  expandLift = 3, expandSupport = 4,
} = {}) {
  const q = query.trim()
  if (!q) return null

  // ── 1. 질의 확장 ───────────────────────────────────────────────────────
  // 한국어 커밋 저장소에서는 원어가 그대로 맞고(e101 은 커밋 98% 가 한국어),
  // 영어 커밋 저장소에서는 사전이 다리를 놓는다. 원어는 항상 함께 남긴다.
  const tokens = q.split(/\s+/).filter(Boolean).map(expandTerm).filter((x) => x.terms.length)
  if (!tokens.length) return null
  const allTerms = [...new Set(tokens.flatMap((t) => t.terms))]

  // ── 2. 커밋 메시지 매칭 ────────────────────────────────────────────────
  //
  // git 의 --grep 은 여러 개를 주면 OR 이고, --all-match 를 붙이면 전부 AND 다.
  // 우리가 원하는 것은 그 중간이다 — **토큰끼리는 AND, 한 토큰의 동의어끼리는 OR**.
  // ("사진 업로드" = (사진|photo|image|asset) AND (업로드|upload))
  // git 으로는 표현할 수 없으므로 OR 로 넉넉히 받아 여기서 걸러낸다.
  const grepArgs = allTerms.flatMap((w) => ['--grep', esc(w)])

  let prefix = ''
  let raw = ''
  try {
    prefix = git(root, ['rev-parse', '--show-prefix']).trim()
    raw = git(root, [
      'log', '--no-merges', '-i', ...grepArgs,
      '--pretty=format:@%H\t%at\t%s', '--name-only',
    ])
  } catch {
    return null
  }

  // 토큰마다 "동의어 중 하나라도 들어 있나"를 검사할 정규식
  const perToken = tokens.map((t) => new RegExp(t.terms.map(esc).join('|'), 'i'))

  const commits = []
  let cur = null
  const tokenHits = tokens.map(() => 0)
  for (const line of raw.split('\n')) {
    if (line.startsWith('@')) {
      const [h, at, subject] = line.slice(1).split('\t')
      const matched = perToken.map((re) => re.test(subject ?? ''))
      matched.forEach((m, i) => { if (m) tokenHits[i]++ })
      const n = matched.filter(Boolean).length
      cur = { hash: h, at: +at || 0, subject: subject ?? '', files: [], matched: n }
      commits.push(cur)
      continue
    }
    let f = line.trim()
    if (!f || !cur) continue
    if (prefix) { if (!f.startsWith(prefix)) continue; f = f.slice(prefix.length) }
    if (ids.has(f)) cur.files.push(f)
  }

  /**
   * 🔴 토큰끼리 하드 AND 를 걸면 안 된다.
   *
   * 처음에 AND 로 짰더니 "얼굴 인식" 이 0개가 나왔다. `인식` 은 사전에 없어서
   * 한국어 그대로 남는데, 영어 커밋 저장소에는 그 글자가 한 번도 안 나온다.
   * **번역 못 한 단어 하나가 질의 전체를 죽인다.**
   * "사진 업로드" 도 3개로 쪼그라들었다 — 커밋 제목이 짧아서 "photo" 와 "upload"
   * 를 한 줄에 다 적는 사람이 드물기 때문이다.
   *
   * 그래서 **몇 개 토큰이 맞았는지로 가중**한다. 전부 맞은 커밋이 가장 무겁고,
   * 하나만 맞은 커밋도 버리지 않는다. 결과가 0 이 되는 실패 방식이 사라진다.
   */
  const nTok = tokens.length
  const weightOf = (c) => c.matched / nTok

  // 한 번도 안 걸린 토큰은 이 저장소에서 쓰이지 않는 말이다. 숨기지 않고 알려준다.
  const deadTokens = tokens.filter((_, i) => tokenHits[i] === 0).map((t) => t.token)

  // 가중 등장 횟수. 토큰을 다 맞춘 커밋은 1.0, 절반만 맞춘 커밋은 0.5 로 센다.
  const hits = new Map()
  const rawHits = new Map()
  let usedCommits = 0
  for (const c of commits) {
    const uniq = [...new Set(c.files)]
    if (uniq.length === 0 || uniq.length > MAX_FILES) continue
    usedCommits++
    const w = weightOf(c)
    for (const f of uniq) {
      hits.set(f, (hits.get(f) ?? 0) + w)
      rawHits.set(f, (rawHits.get(f) ?? 0) + 1)
    }
  }

  /**
   * 🔴 정밀도의 분모는 **그 기간 안의 커밋 수**여야 한다.
   *
   * 예전에는 파일의 전체 생애 커밋 수로 나눴다. 그러면 저장소가 성숙할수록
   * 중심 파일이 구조적으로 배제된다 — flask 에서 실측된 상황이다:
   *
   *   app.py 전체 커밋 136,  저장소 전체의 route 커밋 24
   *   → 문턱 0.2 를 넘으려면 route 커밋 28개가 전부 app.py 를 건드려야 한다
   *   → 존재하지 않는 조건. app.py 는 **어떤 질의로도** 기능 범위에 못 들어온다
   *
   *   error handling  커밋 231개 매칭 → 파일 0개
   *   url rule        커밋 119개 매칭 → 파일 0개
   *   blueprint       통과 — blueprints.py 의 전체 커밋이 60으로 작아서다
   *
   * **파일이 덜 중요할수록 기능 검색에 잘 잡혔다.** 의도와 정반대다.
   *
   * 매칭된 커밋들이 걸쳐 있는 기간으로 분모를 좁히면 이 왜곡이 사라진다.
   * "그 기능을 손대던 시기에, 이 파일이 바뀐 것 중 몇 %가 그 기능이었나" 라는
   * 원래 물어보려던 질문이 된다.
   */
  const times = commits.map((c) => c.at).filter(Boolean)
  const window = times.length ? { from: Math.min(...times), to: Math.max(...times) } : null
  const inWindow = windowCounts(root, prefix, ids, window)

  /**
   * 🔴 문턱은 **재현율**로 건다. 정밀도는 보여주기만 한다.
   *
   * 두 비율이 있고 서로 다른 질문에 답한다.
   *
   *   재현율 = 이 기능 커밋 중 이 파일을 건드린 비율
   *            "이 기능을 손댈 때 여기를 얼마나 자주 열었나"
   *   정밀도 = 이 파일 커밋 중 이 기능이었던 비율
   *            "이 파일이 바뀔 때 그게 이 기능일 확률"
   *
   * 정밀도로 문턱을 걸었더니 저장소의 중심 파일이 구조적으로 배제됐다.
   * flask 실측 — `app.py` 전체 커밋 136, route 커밋 24. 문턱 0.2 를 넘으려면
   * route 커밋 28개가 전부 app.py 를 건드려야 하는데 24개밖에 없다.
   * **존재할 수 없는 조건이다.** `error handling` 은 커밋 231개를 찾고 파일 0개를,
   * `url rule` 은 119개를 찾고 0개를 내놨다. 통과한 `blueprint` 는
   * `blueprints.py` 의 전체 커밋이 60으로 작아서였다 —
   * **파일이 덜 중요할수록 잘 잡혔다.** 의도와 정반대다.
   *
   * 기간을 좁혀도 안 풀린다. 오래 사는 기능은 커밋이 15년에 걸쳐 있어서
   * "그 기간" 이 곧 전체 히스토리다. 실제로 그렇게 고쳐보고 확인했다.
   *
   * 그래서 문턱을 재현율로 옮긴다. 정밀도는 버리지 않고 함께 보여준다 —
   * 낮은 정밀도는 "이 파일은 이 기능 말고도 많이 바뀐다" 는 **사실**이지
   * 배제할 이유가 아니다. 판단은 사람이 한다.
   */
  const featureCommits = Math.max(usedCommits, 1)
  const scored = []
  for (const [f, w] of hits) {
    if (w < minHits) continue
    const n = rawHits.get(f)
    const lifetime = freq.get(f) ?? n
    // 정밀도의 분모는 그 기능을 손대던 기간의 커밋 수. 없으면 생애 커밋 수.
    const denom = Math.max(inWindow.get(f) ?? 0, w, 1)
    scored.push({
      path: f, hits: n, weight: +w.toFixed(1),
      total: denom, lifetime,
      recall: +(w / featureCommits).toFixed(3),
      precision: +(w / denom).toFixed(2),
    })
  }
  scored.sort((a, b) => b.recall - a.recall || b.weight - a.weight)

  // 상대 문턱 — 1등 기준으로 자른다. 질의 폭에 따라 문턱이 함께 움직인다.
  const top = scored[0]?.recall ?? 0
  const cutoff = Math.max(top * relFloor, absFloor)
  const fromCommits = scored.filter((x) => x.recall >= cutoff).slice(0, topK)

  // ── 3. 경로/파일명 매칭 ────────────────────────────────────────────────
  // 여기서도 같은 규칙 — 토큰끼리 AND, 동의어끼리 OR.
  // 파일명은 거의 영어라 확장이 없으면 한국어 질의가 하나도 못 걸린다.
  const pathHits = [...ids].filter((f) => {
    const s = f.toLowerCase()
    return tokens.every((t) => t.terms.some((w) => s.includes(w.toLowerCase())))
  })

  /**
   * 🔴 경로 매칭이 디렉터리 이름을 만나면 폭발한다.
   *
   * syft 에서 `cataloger` 는 저장소 1,244개 중 **592개**를 이름으로 잡았다.
   * `syft/pkg/cataloger/` 아래 전부이기 때문이다. 절반이 한 기능일 리 없다.
   * "이 기능은 이만큼이다" 라는 말을 할 수 없게 된다.
   *
   * 저장소의 일정 비율을 넘으면 그건 기능 이름이 아니라 **디렉터리 이름**이다.
   * 그럴 때는 경로 매칭을 접고 그 사실을 알린다 — 조용히 자르면
   * "이 기능은 592개 파일" 로 읽힌다.
   */
  const pathCapRatio = 0.15
  const pathTooBroad = pathHits.length > Math.max(30, ids.size * pathCapRatio)
  const fromPath = pathTooBroad ? [] : pathHits

  const core = new Set([...fromCommits.map((x) => x.path), ...fromPath])

  // ── 3. 공변경 확장 ─────────────────────────────────────────────────────
  // 씨앗과 반복해서 함께 바뀐 것. import 로 넓히면 정적 그래프와 같아지므로
  // 여기서는 히스토리로만 넓힌다 — 그게 "이 기능을 고칠 때 실제로 건드리는 것"이다.
  const expanded = new Map()
  for (const e of coEdges) {
    if ((e.lift ?? 0) < expandLift || (e.support ?? 0) < expandSupport) continue
    const a = core.has(e.source), b = core.has(e.target)
    if (a === b) continue // 둘 다 씨앗이거나 둘 다 아님
    const add = a ? e.target : e.source
    const prev = expanded.get(add)
    if (!prev || e.lift > prev.lift) expanded.set(add, { path: add, lift: e.lift, support: e.support, via: a ? e.source : e.target })
  }
  for (const k of core) expanded.delete(k)

  // 확장에 상한을 둔다.
  //
  // "사진 업로드" 처럼 씨앗이 넓게 잡히면 확장이 씨앗의 다섯 배까지 불어나
  // 결국 저장소 절반이 된다. 그러면 "이 기능은 이만큼이다" 라는 말을 못 한다.
  // 씨앗 수에 비례해 자르고, 자른 사실을 숨기지 않는다 — 조용한 절단은
  // "전부 다 봤다"로 읽히기 때문이다.
  const cap = Math.max(12, core.size * 3)
  const ranked = [...expanded.values()].sort((a, b) => b.lift - a.lift)
  const kept = ranked.slice(0, cap)
  const truncated = ranked.length - kept.length

  const paths = new Set([...core, ...kept.map((x) => x.path)])

  return {
    query: q,
    // 어떤 말을 어떤 말로 바꿨는지 반드시 화면에 보여준다.
    // 조용히 바꾸고 결과만 내놓으면 사용자가 틀린 답을 맞는 줄 안다 (D5).
    expansion: tokens.map((t) => ({
      token: t.token,
      terms: t.terms.filter((x) => x !== t.token),
      translated: t.translated,
    })),
    // 이 저장소 커밋에 한 번도 안 나온 말. 사용자가 다른 낱말을 고를 수 있어야 한다.
    deadTokens,
    tokenHits: tokens.map((t, i) => ({ token: t.token, commits: tokenHits[i] })),
    // 문턱을 숫자로 함께 보낸다. 화면이 "왜 잘렸는지" 를 말할 수 있어야 한다.
    cutoff: +cutoff.toFixed(3),
    // 경로 매칭이 너무 넓어 접었는가. 화면이 그 사실을 말해야 한다.
    pathTooBroad: pathTooBroad ? pathHits.length : 0,
    scoredFiles: scored.length,
    matchedCommits: commits.length,
    usedCommits,
    recentSubjects: commits.slice(0, 6).map((c) => ({ hash: c.hash.slice(0, 9), subject: c.subject })),
    fromCommits: fromCommits.slice(0, 40),
    fromPath,
    expanded: kept.slice(0, 40),
    truncated,
    paths: [...paths],
    counts: { core: core.size, expanded: kept.length, total: paths.size },
  }
}
