/**
 * 기능 단위 그래프 — 파일이 아니라 **사람의 말**로 코드를 그린다.
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────
 *
 * 지금까지 화면의 노드는 파일이었다. `AuthService.java` · `authStore.ts`.
 * 그 화면은 **읽을 줄 아는 사람에게만** 지도다.
 *
 * AI 가 코드를 쓰는 시대에 사람이 하는 일은 "무엇을 만들지 정하고, 그게
 * 어디까지 영향을 주는지 아는 것" 쪽으로 옮겨간다. 그 일에는 파일 이름이
 * 아니라 기능 이름이 필요하다. 비전공자가 화면을 보고
 * **"웹 수집 쪽을 고치면 자연어 처리도 같이 움직이는구나"** 를 읽을 수 있어야 한다.
 *
 * ── 이름을 어디서 가져오나 ────────────────────────────────────────────────
 *
 * 🔴 지어내지 않는다. **사람이 이미 써 놓은 문장**을 그대로 쓴다.
 *
 * 출처는 셋이고, 위에 있을수록 좋다. 화면은 이 차이를 숨기지 않는다.
 *
 *   docs   README 가 그 모듈을 부르는 말      "Data Mining" · "Machine Learning"
 *   commit 그 안에서 한 일의 커밋 제목        "순찰 지점 저장·조회 API"
 *   path   폴더 이름                          "web" · "vector"
 *
 * LLM 에게 이름을 시키지 않는 이유는 features.mjs 의 판단과 같다 —
 * 모델은 오탐 묶음에도 그럴듯한 이름을 붙여 준다. 여기서는 더 나쁘다:
 * **비전공자는 그 이름이 맞는지 코드로 확인할 방법이 없다.** 틀린 이름을
 * 그대로 믿게 된다. 그래서 출처가 유일한 검증 수단이고, 반드시 함께 낸다.
 *
 * ── 왜 커밋 제목만으로는 부족한가 (실측) ──────────────────────────────────
 *
 * 처음에는 커밋 제목만으로 기능을 만들었다. clips/pattern 에서 21개 묶음이
 * 나왔고 **전부 커밋 제목에서 이름을 얻었다.** 그런데 그 이름들이 이랬다 —
 *
 *   "Use unicode literals, import from builtins..."
 *   "Make print statements Python 3 compatible"
 *
 * 파이썬 2→3 이식 작업이다. 커밋 제목은 "무엇을 **했나**" 이지
 * "무엇**인가**" 가 아니다. 유지보수가 많은 저장소에서는 화면이 통째로
 * 유지보수 기록이 된다.
 *
 * 그래서 **모듈을 주인공으로** 두고, 커밋 제목은 그 안에서 "무슨 일이
 * 있었나" 로 붙인다. 둘 다 사람의 말이지만 답하는 질문이 다르다.
 *
 * ── 한계 (숨기지 않는다) ──────────────────────────────────────────────────
 *
 *   · README 에 기능 목록이 없으면 폴더 이름으로 떨어진다.
 *   · 히스토리가 짧으면 "무슨 일이 있었나" 가 빈다.
 *   · 모듈 경계가 폴더와 다른 저장소에서는 이 그림이 안 맞는다.
 *
 * 순수 함수만 둔다. git 호출과 파일 읽기는 server.mjs 가 한다.
 */

import { draft, nameFromSubject } from './features.mjs'

/** 한 커밋이 이 묶음의 것이라고 볼 만한 겹침 비율. */
const OVERLAP = 0.5

/**
 * 쌍을 Map 키로 만들 때 쓰는 구분자.
 *
 * 🔴 소스에는 **이스케이프 표기**로 적는다. 진짜 NUL 바이트를 파일에 넣으면
 *    도구마다 다르게 취급하고 diff 가 깨진다 (test/features.test.mjs 가 막는다).
 *    경로에는 NUL 이 들어갈 수 없으므로 구분자로는 안전하다.
 */
const SEP = '\u0000'

/** 모듈 하나에 붙일 "무슨 일이 있었나" 개수. */
const WORKS_SHOWN = 5

/**
 * 라이브러리를 **쓰는** 쪽. 모듈로 치지 않는다.
 * (flow.mjs 의 같은 판단 — 예제·테스트는 코드의 소비자다.)
 */
const CONSUMER_RE = /^(tests?|spec|__tests__|testing|examples?|samples?|demos?|tutorials?|docs?|documentation|website|scripts?|tools?|bench(marks?)?|\.github|ci)$/i

// ---------------------------------------------------------------------------
// 모듈 나누기
// ---------------------------------------------------------------------------

/**
 * 파일들을 모듈로 나눈다.
 *
 * 🔴 소스 뿌리를 먼저 찾는다.
 *
 * `pattern/web` · `pattern/text` 처럼 코드가 한 폴더 아래 모여 있으면,
 * 최상위로 나누면 모듈이 `pattern` 하나가 되어 그래프가 점 하나가 된다.
 * 그래서 **소비자(예제·테스트·문서)를 뺀 코드**가 거의 다 한 폴더 아래 있으면
 * 그 폴더를 뿌리로 보고 한 단계 더 들어간다.
 *
 * `src/` 도 같은 이유로 건너뛴다.
 */
export function modulesOf(paths, { dominant = 0.6 } = {}) {
  const code = paths.filter((p) => !CONSUMER_RE.test(p.split('/')[0]))
  if (!code.length) return { mods: new Map(), root: null }

  const topCount = new Map()
  for (const p of code) {
    const t = p.includes('/') ? p.split('/')[0] : ''
    topCount.set(t, (topCount.get(t) ?? 0) + 1)
  }
  const [topDir, n] = [...topCount].sort((a, b) => b[1] - a[1])[0]
  // 뿌리로 인정하려면 폴더여야 하고(빈 문자열은 최상위 파일), 압도적이어야 한다.
  const root = topDir && n / code.length >= dominant ? topDir : null

  const mods = new Map()
  for (const p of code) {
    const seg = p.split('/')
    let key
    if (root) key = seg.length > 2 ? `${root}/${seg[1]}` : root
    else key = seg.length > 1 ? seg[0] : '(최상위)'
    if (!mods.has(key)) mods.set(key, [])
    mods.get(key).push(p)
  }
  // 🔴 뿌리는 함께 돌려준다. 뿌리는 기능이 아니라 **담는 그릇**이다.
  //
  // README 의 설치 안내는 프로젝트 이름을 계속 부른다 —
  // "Put the pattern folder in the same folder as your script."
  // 뿌리 모듈에 문서 이름을 붙이면 그 문장이 기능 이름이 된다. 실제로 됐다.
  return { mods, root }
}

// ---------------------------------------------------------------------------
// README 에서 이름 얻기
// ---------------------------------------------------------------------------

/** README 에서 "사람이 기능을 부르는 말" 이 될 만한 줄. 목록 항목과 제목. */
export function docLines(text) {
  if (!text) return []
  const out = []
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const t = raw.trim()
    const bullet = t.match(/^[*\-+]\s+(.+)$/)
    const heading = t.match(/^#{2,6}\s+(.+?)\s*#*$/)
    /**
     * 🔴 마크다운 링크는 **글자만** 남긴다.
     *
     * syft 에서 걸음⑤의 모듈 이름이 이렇게 나왔다 —
     *   "Works seamlessly with [Grype](https"
     * 그리고 "출처 README.md" 배지까지 달았다. 원인은 아래 matchDocs 의
     * 콜론 분리가 **URL 의 `https:` 를 "이름: 설명" 구분자로 읽은 것**이다.
     *
     * theHarvester 에서는 멀쩡했다. README 문체가 달랐을 뿐이고, 그것이
     * 한 저장소에만 맞춰 놓았다는 증거다. 링크를 먼저 글자로 풀면 이름 짓기와
     * 토큰 추출이 둘 다 정확해진다.
     */
    let line = (bullet?.[1] ?? heading?.[1] ?? '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')   // 이미지: 통째로 버린다
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 링크: 보이는 글자만 남긴다
      .replace(/<[^>]+>/g, ' ')                // 인라인 HTML
      .replace(/https?:\/\/\S+/g, ' ')         // 남은 맨 URL
      .replace(/[*`_]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (line.length < 4 || line.length > 200) continue
    // 배지·링크만 있는 줄은 말이 아니다.
    if (/^\[?!\[/.test(line)) continue
    out.push({ line, kind: bullet ? 'bullet' : 'heading' })
  }
  return out
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'has', 'are', 'its',
  'you', 'can', 'all', 'use', 'using', 'used', 'tools', 'module', 'modules',
  'library', 'python', 'javascript', 'java', 'api', 'apis', 'support', 'based',
  'init', 'src', 'lib', 'core', 'common', 'util', 'utils', 'main', 'test', 'tests',
])

const tokens = (s) =>
  s.toLowerCase().split(/[^a-z0-9가-힣]+/).filter((w) => w.length >= 3 && !STOP.has(w))

/** 모듈이 가진 말 — 폴더 이름과 그 안 파일·하위폴더 이름. */
function moduleWords(dir, paths) {
  const w = new Set()
  for (const seg of dir.split('/')) for (const t of tokens(seg)) w.add(t)
  for (const p of paths) {
    for (const seg of p.split('/').slice(0, -1)) for (const t of tokens(seg)) w.add(t)
    const base = p.split('/').pop().replace(/\.[^.]+$/, '')
    for (const t of tokens(base)) w.add(t)
  }
  return w
}

/**
 * README 의 줄을 모듈에 붙인다.
 *
 * 🔴 애매하면 안 붙인다 (fail-closed).
 *
 * 한 줄이 두 모듈에 비슷하게 맞으면 어느 쪽인지 모르는 것이다. 그때 억지로
 * 붙이면 비전공자에게 **틀린 이름을 확신 있게** 보여주게 된다 — 그 사람은
 * 코드로 확인할 수 없으므로 그대로 믿는다. 이 도구에서 가장 나쁜 실패다.
 *
 * 점수는 "그 줄의 말 중 몇 개가 이 모듈의 이름들에 실제로 나오는가" 다.
 * 1등이 2등보다 확실히 앞설 때만 붙인다.
 */
export function matchDocs(mods, lines, { looseHits = 2, margin = 1, skip = null } = {}) {
  const words = new Map()
  const own = new Map()      // dir -> 그 모듈 자신의 이름 토큰
  for (const [dir, paths] of mods) {
    if (skip && dir === skip) continue   // 뿌리는 기능이 아니다 (modulesOf 주석)
    words.set(dir, moduleWords(dir, paths))
    own.set(dir, new Set(tokens(dir.split('/').pop())))
  }

  const chosen = new Map()   // dir -> {line, hits, label}
  for (const { line } of lines) {
    const lt = [...new Set(tokens(line))]
    if (!lt.length) continue
    const scored = [...words].map(([dir, w]) => ({
      dir,
      hits: lt.filter((t) => w.has(t)).length,
      // 🔴 그 줄이 **모듈 이름 자체**를 부르는가. 이게 결정적이다.
      //
      // 처음에는 겹치는 단어 하나면 붙였다. axMap 에서 `app/lib` 에
      // "Phase 4 · 시각화와 로컬 LLM" 이라는 개발 단계 제목이 붙었다 —
      // `app/lib/llm.mjs` 때문에 "llm" 하나가 겹쳤을 뿐이다.
      // 한 단어 겹침은 우연이다. 그리고 비전공자는 그 이름이 틀린 줄 모른다.
      dirHit: lt.some((t) => own.get(dir).has(t)),
    })).sort((a, b) => (b.dirHit - a.dirHit) || b.hits - a.hits)

    const best = scored[0]
    const second = scored[1]
    // 모듈 이름을 직접 부르거나(강함), 아니면 겹치는 말이 충분히 많아야 한다.
    if (!best || (!best.dirHit && best.hits < looseHits)) continue
    if (second && second.dirHit === best.dirHit && best.hits - second.hits < margin) continue

    // 이미 더 강한 줄이 붙어 있으면 두지 않는다.
    const cur = chosen.get(best.dir)
    if (cur && cur.hits >= best.hits) continue

    /**
     * `Data Mining: web services, crawler` → 이름은 콜론 앞, 설명은 뒤.
     *
     * 🔴 URL 의 콜론을 구분자로 읽지 않는다. docLines 가 링크를 걷어내지만
     * `mailto:` `note:` 같은 것이 남을 수 있으므로 여기서도 막는다 —
     * 뒤가 `//` 로 시작하면 그건 설명이 아니라 주소다.
     */
    // 🔴 전방탐색 안에 공백을 넣는다. 밖에 두면 `\s*` 가 빈 문자열로 물러나
    // 검사를 우회한다 — `note: //x` 가 그대로 갈라졌다.
    const m = line.match(/^([^:：]{2,40})[:：](?!\s*\/\/)\s*(.+)$/)
    chosen.set(best.dir, {
      label: (m?.[1] ?? line).trim(),
      line,
      detail: m?.[2]?.trim() ?? null,
      hits: best.hits,
    })
  }
  return chosen
}

// ---------------------------------------------------------------------------
// 커밋 제목에서 "무슨 일이 있었나"
// ---------------------------------------------------------------------------

/**
 * 이 파일 묶음에서 사람이 한 일을, 사람이 쓴 문장 그대로.
 *
 * 🔴 "이 파일을 건드린 모든 커밋" 이 아니라 **이 묶음이 주인공인 커밋**만 본다.
 *
 * 파일 하나만 스친 대형 커밋("의존성 일괄 업데이트")의 제목을 집으면
 * 이름이 "chore: bump deps" 가 된다.
 */
export function worksIn(paths, commits, { overlap = OVERLAP, limit = WORKS_SHOWN } = {}) {
  const set = new Set(paths)
  const byText = new Map()
  for (const c of commits) {
    const files = [...new Set(c.files)]
    if (!files.length) continue
    const hit = files.filter((f) => set.has(f)).length
    if (!hit || hit / files.length < overlap) continue
    const name = nameFromSubject(c.subject)
    if (!name) continue
    const e = byText.get(name) ?? { subject: name, times: 0, hit: 0 }
    e.times++
    e.hit = Math.max(e.hit, hit)
    byText.set(name, e)
  }
  return [...byText.values()]
    .sort((a, b) => b.times - a.times || b.hit - a.hit || a.subject.length - b.subject.length)
    .slice(0, limit)
}

// ---------------------------------------------------------------------------

/**
 * 기능 그래프.
 *
 * @param {object} input
 *   paths    그래프에 있는 파일 경로
 *   commits  [{subject, files}]
 *   readme   README 원문 (없으면 폴더 이름으로 떨어진다)
 *   edges    파일 단위 정적 엣지 (모듈 사이 import 를 세는 데 쓴다)
 */
export function featureGraph({ paths, commits = [], readme = null, edges = [] } = {}) {
  const { mods, root } = modulesOf(paths)
  const docs = matchDocs(mods, docLines(readme), { skip: root })

  const nodes = []
  for (const [dir, files] of mods) {
    const d = docs.get(dir)
    const works = worksIn(files, commits)
    nodes.push({
      id: dir,
      name: d?.label ?? dir.split('/').pop(),
      // 🔴 이름의 출처. 비전공자에게는 이것이 유일한 검증 수단이다.
      nameSource: d ? 'docs' : 'path',
      // README 가 그 모듈을 설명한 문장 그대로. 요약하지 않는다.
      docLine: d?.line ?? null,
      detail: d?.detail ?? null,
      dir,
      paths: files.sort(),
      files: files.length,
      lines: 0,   // server 가 노드 정보를 알면 채운다
      // 여기서 사람이 무슨 일을 했나 — 커밋 제목 그대로
      works,
      commits: 0,
    })
  }

  const byPath = new Map()
  for (const n of nodes) for (const p of n.paths) byPath.set(p, n.id)

  // ── 엣지 ①  같은 커밋에서 함께 바뀐 모듈 ───────────────────────────────
  const together = new Map()
  const touched = new Map()
  for (const c of commits) {
    const hit = [...new Set(c.files.map((f) => byPath.get(f)).filter(Boolean))]
    for (const h of hit) touched.set(h, (touched.get(h) ?? 0) + 1)
    if (hit.length < 2) continue
    // 🔴 대형 커밋은 버린다. 일괄 포맷팅 한 번이 모든 모듈을 서로 잇는다.
    if (hit.length > 6) continue
    for (let i = 0; i < hit.length; i++) {
      for (let j = i + 1; j < hit.length; j++) {
        const [a, b] = hit[i] < hit[j] ? [hit[i], hit[j]] : [hit[j], hit[i]]
        together.set((a + SEP + b), (together.get((a + SEP + b)) ?? 0) + 1)
      }
    }
  }
  for (const n of nodes) n.commits = touched.get(n.id) ?? 0

  // ── 엣지 ②  모듈 사이 import ───────────────────────────────────────────
  const imports = new Map()
  for (const e of edges) {
    if (e.origin === 'cochange') continue
    const a = byPath.get(e.source)
    const b = byPath.get(e.target)
    if (!a || !b || a === b) continue
    const k = a < b ? (a + SEP + b) : (b + SEP + a)
    imports.set(k, (imports.get(k) ?? 0) + 1)
  }

  const out = []
  for (const k of new Set([...together.keys(), ...imports.keys()])) {
    const [source, target] = k.split(SEP)
    const n = together.get(k) ?? 0
    const imp = imports.get(k) ?? 0
    out.push({
      source, target, n, imports: imp,
      // D12 와 같은 축. 무엇으로 알아냈는지를 엣지마다 붙인다.
      origin: n && imp ? 'both' : imp ? 'static' : 'cochange',
      directed: false,
    })
  }
  out.sort((a, b) => (b.n + b.imports) - (a.n + a.imports))

  // 참고용으로 히스토리 묶음도 함께 낸다 (features.mjs 의 초안).
  // 모듈이 주인공이지만, "이 저장소에서 최근 무슨 일이 있었나" 는 이쪽이 답한다.
  const clusters = commits.length ? draft(commits, new Set(paths)) : { features: [], stats: {} }

  return {
    nodes: nodes.sort((a, b) => b.files - a.files),
    edges: out,
    clusters: clusters.features.slice(0, 20).map((f) => ({
      id: f.id,
      name: worksIn(f.paths, commits)[0]?.subject ?? f.name,
      paths: f.paths,
      evidence: f.evidence,
    })),
    stats: {
      modules: nodes.length,
      namedFromDocs: nodes.filter((n) => n.nameSource === 'docs').length,
      namedFromPath: nodes.filter((n) => n.nameSource === 'path').length,
      withWorks: nodes.filter((n) => n.works.length).length,
      coveredFiles: nodes.reduce((a, n) => a + n.files, 0),
      totalFiles: paths.length,
      docLines: docLines(readme).length,
    },
  }
}
