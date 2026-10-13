/**
 * 이름에서 뜻 있는 낱말만 남긴다 — 토큰화 · 불용어 유도 · 3단 IDF.
 *
 * 순수 함수만 있다. git 도 fs 도 시계도 없다 (`stats.mjs` 와 같은 자리).
 * 재는 일은 `measure.mjs`, 쓰는 일은 화면과 군집 이름 붙이기가 한다.
 *
 * ── 🔴 왜 불용어를 손으로 적지 않는가 ────────────────────────────────────
 *
 * 손으로 적은 불용어 목록은 **모든 저장소에서 조금씩 틀린다.**
 * `service` 는 마이크로서비스 저장소에서는 잡음이지만 모놀리스에서는 신호다.
 * `model` 은 ML 저장소에서 잡음이고 웹 백엔드에서는 신호다.
 * 어느 쪽인지는 그 저장소를 봐야만 안다 — 그리고 그것이 곧 문서빈도(DF)다.
 *
 * 그래서 이렇게 가른다.
 *
 *   언어 예약어      손으로 적는다. `if` · `func` · `class` 는 어느 저장소에서도
 *                    뜻이 없고, 코퍼스를 써서 알아낼 필요가 없다. 씨앗일 뿐이다
 *   그 밖의 전부     **DF 에서 유도한다.** `service` · `util` · `handler` 도
 *                    예외가 아니다. 흔하면 잡음이고 드물면 신호다
 *
 * ── 🔴 왜 3단인가 ────────────────────────────────────────────────────────
 *
 * 저장소 하나의 DF 만 쓰면 작은 저장소에서 무너진다. 파일 20개짜리에서
 * "40% 넘게 나오면 불용어" 는 8개 파일에만 있어도 걸린다는 뜻이고,
 * 그건 대개 그 저장소의 **핵심 개념**이다. 핵심을 지우는 셈이다.
 *
 *   ① 저장소   이 저장소 고유의 잡음 (제품 이름, 사내 접두어)
 *   ② 언어 칸  같은 언어 저장소들에 공통으로 흔한 것 (프레임워크 관용어)
 *   ③ 전역     코퍼스 전체. 위 둘이 표본 부족일 때 기댈 곳
 *
 * 표본이 모자라면 **답을 내지 않는다.** `ssot.mjs` 가 분위수에 대해 이미 같은
 * 규칙을 쓴다 — 저장소 3개로 만든 기준을 기준이라고 부르지 않는다.
 * 여기서도 같다. 모자라면 그 단을 건너뛰고 어디까지 적용됐는지 함께 돌려준다.
 */

/**
 * 언어 예약어 — 씨앗.
 *
 * 🔴 여기에는 **명백히 뜻이 없는 것만** 넣는다. 애매하면 넣지 말고 DF 가
 * 판단하게 둔다. 이 목록이 길어지기 시작하면 위의 설계가 무너지고 있다는 신호다.
 */
export const KEYWORDS = {
  js: ['var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new',
    'this', 'typeof', 'null', 'undefined', 'true', 'false', 'async', 'await', 'import', 'export',
    'default', 'from', 'try', 'catch', 'throw', 'switch', 'case', 'break', 'continue'],
  ts: ['interface', 'type', 'enum', 'implements', 'extends', 'public', 'private', 'protected',
    'readonly', 'namespace', 'declare', 'abstract'],
  py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as',
    'try', 'except', 'finally', 'raise', 'with', 'lambda', 'pass', 'none', 'true', 'false',
    'self', 'cls', 'async', 'await', 'yield', 'global', 'nonlocal'],
  java: ['public', 'private', 'protected', 'static', 'final', 'void', 'class', 'interface',
    'extends', 'implements', 'new', 'this', 'super', 'return', 'if', 'else', 'for', 'while',
    'try', 'catch', 'finally', 'throw', 'throws', 'package', 'import', 'abstract', 'synchronized'],
  go: ['func', 'package', 'import', 'type', 'struct', 'interface', 'var', 'const', 'return',
    'if', 'else', 'for', 'range', 'defer', 'go', 'chan', 'select', 'switch', 'case', 'nil',
    'map', 'make', 'new'],
  rs: ['fn', 'let', 'mut', 'pub', 'use', 'mod', 'crate', 'self', 'super', 'struct', 'enum',
    'impl', 'trait', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'where', 'dyn',
    'async', 'await', 'unsafe'],
  rb: ['def', 'end', 'class', 'module', 'require', 'return', 'if', 'elsif', 'else', 'unless',
    'do', 'begin', 'rescue', 'ensure', 'yield', 'self', 'nil', 'true', 'false', 'attr'],
  php: ['function', 'class', 'public', 'private', 'protected', 'static', 'return', 'if', 'else',
    'elseif', 'foreach', 'while', 'namespace', 'use', 'new', 'this', 'null', 'true', 'false'],
  cs: ['public', 'private', 'protected', 'internal', 'static', 'void', 'class', 'struct',
    'interface', 'namespace', 'using', 'new', 'this', 'base', 'return', 'if', 'else', 'for',
    'foreach', 'while', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'var'],
  c: ['int', 'char', 'void', 'float', 'double', 'long', 'short', 'unsigned', 'signed', 'struct',
    'union', 'enum', 'typedef', 'static', 'extern', 'const', 'return', 'if', 'else', 'for',
    'while', 'switch', 'case', 'break', 'continue', 'sizeof', 'include', 'define'],
  cpp: ['template', 'typename', 'namespace', 'using', 'class', 'public', 'private', 'protected',
    'virtual', 'override', 'operator', 'nullptr', 'auto', 'std', 'inline', 'friend', 'explicit'],
  kt: ['fun', 'val', 'var', 'class', 'object', 'interface', 'package', 'import', 'return', 'if',
    'else', 'when', 'for', 'while', 'is', 'as', 'null', 'true', 'false', 'suspend', 'override'],
  swift: ['func', 'let', 'var', 'class', 'struct', 'enum', 'protocol', 'extension', 'import',
    'return', 'if', 'else', 'guard', 'for', 'while', 'switch', 'case', 'self', 'nil', 'init'],
}

/** C++ 은 C 를 물려받고, TS 는 JS 를 물려받는다. 같은 말을 두 번 적지 않는다. */
const INHERITS = { cpp: ['c'], ts: ['js'] }

/** 그 언어의 예약어 집합. 모르는 언어면 빈 집합 — 없는 것을 지어내지 않는다. */
export function keywordsOf(lang) {
  const out = new Set()
  const add = (l) => {
    for (const k of KEYWORDS[l] ?? []) out.add(k)
    for (const p of INHERITS[l] ?? []) add(p)
  }
  add(String(lang ?? '').toLowerCase())
  return out
}

// ── 토큰화 ──────────────────────────────────────────────────────────────────

/**
 * 경로와 식별자를 낱말로 쪼갠다.
 *
 * `src/userAuth/HTTPServer_v2.test.ts`
 *   → user · auth · http · server · test
 *
 * 규칙과 그 이유:
 *   - camelCase · PascalCase 경계에서 자른다. `HTTPServer` 는 `http` + `server` 다
 *     (연속 대문자 뒤에 대문자+소문자가 오면 거기가 경계다)
 *   - 확장자는 버린다. 언어는 이미 알고 있고, `ts` 가 모든 파일에 붙으면
 *     그 자체로 최대 DF 가 되어 다른 낱말의 IDF 를 왜곡한다
 *   - 숫자만 있는 조각은 버린다. `v2` 의 `2` 는 뜻이 없다
 *   - 한 글자는 버린다. `x` · `i` 는 이름이 아니다
 *
 * 🔴 소문자로 낮추되 **원래 형태를 되돌릴 수 있다고 가정하지 않는다.**
 * 화면에 보여줄 때는 원본 경로를 쓴다. 여기서 나온 것은 셈을 위한 열쇠일 뿐이다.
 */
export function tokens(text) {
  if (typeof text !== 'string' || !text) return []
  // 확장자 제거 — 마지막 점 뒤가 짧은 영숫자일 때만 (`v1.2.3` 같은 것을 안 깎는다)
  const noExt = text.replace(/\.[a-zA-Z0-9]{1,5}$/, '')
  const out = []
  for (const chunk of noExt.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue
    for (const w of splitCamel(chunk)) {
      /**
       * 끝에 붙은 숫자를 떼고 판단한다.
       *
       * `v1` · `v2` 는 낱말이 아니다 — 떼면 `v` 한 글자만 남아 버려진다.
       * 그런데 글자↔숫자 경계에서 무조건 자르면 `utf8` · `sha256` · `oauth2`
       * 처럼 **숫자가 이름의 일부인 것**까지 부서진다. 그래서 자르지 않고
       * **떼어 본 뒤 남는 글자 수로** 판단한다.
       *   v1     → v      (1글자) → 버린다
       *   utf8   → utf    (3글자) → 남긴다
       *   i18n   → 끝이 숫자가 아니라 그대로 남는다
       */
      const t = w.toLowerCase().replace(/\d+$/, '')
      if (t.length < 2) continue
      out.push(t)
    }
  }
  return out
}

/** `HTTPServer` → [HTTP, Server] · `userAuth` → [user, Auth] */
function splitCamel(s) {
  /**
   * 낱말을 **직접 집어낸다.** 구분자를 끼워 넣고 자르지 않는다.
   *
   * 세 갈래를 순서대로 본다.
   *   [A-Z]+(?![a-z])[0-9]*   연속 대문자 약어. `HTTPServer` 에서 `HTTP` 만 떼려면
   *                           "뒤에 소문자가 오지 않을 때까지" 라는 조건이 필요하다
   *   [A-Z][a-z0-9]*          보통의 PascalCase 낱말
   *   [a-z0-9]+               소문자 낱말
   *
   * 🔴 숫자를 낱말에서 떼지 않는다. `i18n` 을 `i`+`18`+`n` 으로 부수면 통째로
   * 사라진다 — 셋 다 버려지는 조각이 된다. 끝의 숫자 처리는 `tokens()` 가 맡는다.
   *
   * 🔴 예전에는 경계에 공백을 끼우고 `split` 했다. 그 공백이 파일에 NUL 바이트로
   * 들어가 `소스에 NUL 바이트가 없다` 검사에 걸렸다. 동작은 같았기 때문에
   * 테스트로는 안 잡혔다 — 구분자를 아예 안 쓰는 쪽이 그 함정을 없앤다.
   */
  return s.match(/[A-Z]+(?![a-z])[0-9]*|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? []
}

/** 한 문서(파일)의 낱말 집합. 같은 낱말이 여러 번 나와도 DF 는 한 번만 센다. */
export const termsOf = (text) => new Set(tokens(text))

// ── 문서빈도 ────────────────────────────────────────────────────────────────

/**
 * 문서빈도. `docs` 는 문서마다의 낱말 집합(또는 배열)이다.
 * 반환은 `{ df: Map<term, 문서수>, n: 문서수 }`.
 */
export function documentFrequency(docs) {
  const df = new Map()
  let n = 0
  for (const doc of docs ?? []) {
    n++
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return { df, n }
}

/** 두 DF 를 합친다. 언어 칸과 전역을 코퍼스에서 누적할 때 쓴다. */
export function mergeDf(a, b) {
  const df = new Map(a.df)
  for (const [t, c] of b.df) df.set(t, (df.get(t) ?? 0) + c)
  return { df, n: a.n + b.n }
}

// ── 불용어 유도 ─────────────────────────────────────────────────────────────

/** 이 단(段)을 쓸 수 있는 최소 문서 수. 이보다 적으면 답을 내지 않는다. */
export const MIN_DOCS = 40

/**
 * 문서빈도에서 불용어를 뽑는다.
 *
 * 기준은 하나뿐이다 — **문서의 `at` 비율 이상에 나타나면 잡음이다.**
 * 0.4 는 눈으로 고른 값이고 조절 가능하다. 이 값을 코퍼스에서 다시 유도하려는
 * 유혹이 있는데, 그러면 "무엇이 잡음인지" 를 정하는 기준 자체가 데이터에 딸려
 * 흔들린다. 사람이 고르고 그 값을 함께 돌려주는 쪽이 정직하다.
 *
 * 🔴 표본이 모자라면 **빈 목록을 주고 `applied: false` 라고 말한다.**
 * 빈 목록을 "불용어가 없다" 로 읽으면 안 되고, 그래서 두 값을 나눠 돌려준다.
 * (`ssot.mjs` 의 "표본이 적으면 답을 내지 않는다" 와 같은 규칙)
 */
export function deriveStopwords({ df, n }, { at = 0.4, minDocs = MIN_DOCS } = {}) {
  if (!(n >= minDocs)) return { words: new Set(), applied: false, why: `문서 ${n}개 — ${minDocs}개 미만`, at, n }
  const words = new Set()
  for (const [t, c] of df) if (c / n >= at) words.add(t)
  return { words, applied: true, why: null, at, n }
}

// ── IDF ─────────────────────────────────────────────────────────────────────

/**
 * 평활 IDF — `ln((n + 1) / (df + 1)) + 1`.
 *
 * 🔴 `+1` 이 두 군데 다 있어야 한다. 없으면 모든 문서에 나오는 낱말이 `ln(1)=0`
 * 이 되어 **가중치가 정확히 0** 이 되고, 그 문서의 낱말이 전부 그런 경우
 * 벡터가 통째로 0 이 된다. 0 벡터는 무엇과도 비슷하지 않아서 군집이 조용히
 * 깨진다 — 에러 없이.
 *
 * 못 본 낱말은 `df = 0` 으로 쳐서 최대값을 준다. 처음 보는 이름이 가장 특이한
 * 이름이라는 뜻이고, 그것이 IDF 의 원래 의미다.
 */
export function idfFrom({ df, n }) {
  const idf = new Map()
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1)
  return { idf, n, unseen: Math.log(n + 1) + 1 }
}

export const idfOf = (model, term) => model.idf.get(term) ?? model.unseen

// ── 3단으로 합치기 ──────────────────────────────────────────────────────────

/**
 * 저장소 → 언어 칸 → 전역 순으로 기대며 어휘를 만든다.
 *
 * 세 단이 **덮어쓰는 것이 아니라 더해진다.** 저장소 잡음과 언어 관용어는 서로
 * 다른 것이고 둘 다 지워야 한다. IDF 는 반대로 하나만 골라 쓴다 — 가장 좁으면서
 * 표본이 충분한 것이 그 저장소를 가장 잘 설명하기 때문이다.
 *
 * 어디까지 적용됐는지를 `basis` 로 함께 돌려준다.
 * 🔴 화면은 이것을 **반드시 표시한다.** "코퍼스 미적용" 인 결과를 코퍼스 기반
 * 결과처럼 보여주면 D5 가 금지한 "확신 있게 틀린 답" 이 된다.
 */
export function vocabulary({ lang, repo, langCell, global: glob, at = 0.4, minDocs = MIN_DOCS } = {}) {
  const kw = keywordsOf(lang)

  const tiers = [
    ['repo', repo],
    ['lang', langCell],
    ['global', glob],
  ]

  const stop = new Set(kw)
  const basis = { keywords: kw.size, repo: false, lang: false, global: false, why: [] }

  for (const [name, src] of tiers) {
    if (!src) continue
    const d = deriveStopwords(src, { at, minDocs })
    basis[name] = d.applied
    if (!d.applied) { basis.why.push(`${name}: ${d.why}`); continue }
    for (const w of d.words) stop.add(w)
  }

  // IDF 는 표본이 충분한 것 중 가장 좁은 단을 쓴다.
  let idfModel = null
  let idfFrom_ = null
  for (const [name, src] of tiers) {
    if (src && src.n >= minDocs) { idfModel = idfFrom(src); idfFrom_ = name; break }
  }

  return { stop, idf: idfModel, idfBasis: idfFrom_, basis, at }
}

/**
 * 이름 하나를 뜻 있는 낱말들로.
 *
 * 🔴 **빈 배열을 돌려주지 않는다.**
 *
 * `service/service.js` 같은 이름은 불용어를 걷어내면 아무것도 안 남는다.
 * 그대로 두면 그 파일은 어떤 검색에도 안 걸리고 어떤 군집에도 안 붙는다 —
 * 조용히 사라지는 것이라 아무도 눈치채지 못한다. 그래서 전부 걸러졌으면
 * **IDF 가 가장 높은 것 하나는 남긴다.** 남겼다는 사실을 `salvaged` 로 알린다.
 */
export function meaningful(text, vocab, { keep = 8 } = {}) {
  const all = [...new Set(tokens(text))]
  const kept = all.filter((t) => !vocab.stop.has(t))
  const score = (t) => (vocab.idf ? idfOf(vocab.idf, t) : 1)

  if (kept.length) {
    return { terms: kept.sort((a, b) => score(b) - score(a)).slice(0, keep), salvaged: false }
  }
  if (!all.length) return { terms: [], salvaged: false }
  return { terms: [all.sort((a, b) => score(b) - score(a))[0]], salvaged: true }
}

// ── 블록에 이름 붙이기 ──────────────────────────────────────────────────────

/**
 * 군집이 정해진 **뒤에** 그 군집의 이름을 짓는다.
 *
 * ── 🔴 TF-IDF 는 군집을 만드는 데 쓰지 않는다. 이름 붙이는 데만 쓴다 ─────
 *
 * 이름으로 군집을 만들면 **디렉터리 구조를 다시 발견할 뿐이다.** 이름이 비슷한
 * 파일은 대개 같은 폴더에 있고, 그건 이미 화면에 보이는 정보다. 우리가 알고
 * 싶은 것은 그 반대다 — 폴더가 다른데 실제로 얽혀 있는 것(D12 의 `cochange`,
 * "숨은 결합"). 이름을 군집 신호에 섞으면 정확히 그 발견을 지워버린다.
 *
 * 그래서 역할을 갈라 둔다. 두 실패의 무게가 다르기 때문이기도 하다.
 *
 *   군집을 만드는 것   구조 신호만 — import 엣지 + 공변경 (D5 · D12)
 *                      틀리면 **지도가 틀린다.** 사람이 알아채기 어렵다
 *   이름을 붙이는 것   TF-IDF
 *                      틀리면 이름이 어색하다. 보면 바로 안다
 *
 * 군집 알고리즘 자체는 Louvain · Leiden · Infomap · SBM 이 후보다 (D17).
 * 어느 것을 쓰든 이 함수는 그대로 붙는다 — 입력이 "파일 → 군집 번호" 뿐이라
 * 군집을 어떻게 만들었는지 몰라도 된다. **그것이 이 경계를 나눈 이득이다.**
 *
 * ── 어떻게 ───────────────────────────────────────────────────────────────
 *
 * 군집 하나를 문서 하나로 본다. 그 안의 낱말 빈도를 세고, **다른 군집들에도
 * 흔한 낱말은 깎는다.** 저장소 전체의 IDF 가 아니라 **군집 사이의** IDF 를
 * 쓰는 것이 요점이다 — 우리가 묻는 것은 "이 저장소에서 드문 말" 이 아니라
 * "다른 블록에는 없고 이 블록에만 있는 말" 이기 때문이다.
 *
 * @param {Map<string, string|number>|Array<[string, string|number]>} assign 파일 → 군집
 * @param {object} vocab `vocabulary()` 결과 — 불용어를 걷는 데 쓴다
 */
export function labelBlocks(assign, vocab, { perBlock = 3 } = {}) {
  const pairs = assign instanceof Map ? [...assign] : (assign ?? [])

  // ① 군집마다 낱말 빈도
  const tf = new Map()   // block -> Map(term -> 파일 수)
  const size = new Map() // block -> 파일 수
  for (const [file, block] of pairs) {
    if (!tf.has(block)) { tf.set(block, new Map()); size.set(block, 0) }
    size.set(block, size.get(block) + 1)
    const m = tf.get(block)
    for (const t of new Set(tokens(file))) {
      if (vocab?.stop?.has(t)) continue
      m.set(t, (m.get(t) ?? 0) + 1)
    }
  }

  // ② 군집을 문서로 본 DF — "몇 개의 블록에 이 낱말이 나오는가"
  const blocks = [...tf.keys()]
  const bdf = new Map()
  for (const m of tf.values()) for (const t of m.keys()) bdf.set(t, (bdf.get(t) ?? 0) + 1)
  const N = blocks.length

  const out = new Map()
  for (const b of blocks) {
    const m = tf.get(b)
    const n = size.get(b)
    const scored = [...m].map(([t, c]) => {
      /**
       * 이 블록 안에서의 비율 × 블록 사이 IDF.
       *
       * 비율을 쓰는 이유: 큰 블록의 흔한 낱말이 작은 블록의 특징적인 낱말을
       * 개수만으로 이기지 않게 한다. 큰 블록이 항상 이기면 이름이 전부
       * 비슷해지고, 그러면 이름이 아무 일도 안 한다.
       */
      const share = c / n
      /**
       * 🔴 여기서는 **평활하지 않는다.** 위 `idfFrom` 과 일부러 다르다.
       *
       * `idfFrom` 은 `+1` 로 바닥을 1 로 올린다. 벡터가 통째로 0 이 되면 군집이
       * 조용히 깨지기 때문이다. 그런데 **이름 붙이기는 벡터를 만들지 않는다.**
       * 순위만 매긴다. 그리고 여기서는 모든 블록에 있는 낱말이 **정확히 0 이
       * 되어야 한다** — 그런 낱말은 블록을 구분하는 정보가 0 이기 때문이다.
       *
       * 처음에 `idfFrom` 과 같은 식을 썼다가 잡았다. 블록 두 개가 전부
       * `common/` 아래 있을 때 두 블록의 이름이 나란히 `common` 이 됐다.
       * 이름이 같으면 이름이 아무 일도 안 한다.
       *
       * 블록이 하나뿐이면 비교 대상이 없다. 그때는 IDF 를 빼고 비율만 본다 —
       * 전부 0 으로 만들어 순서를 무작위로 두는 것보다 낫다.
       */
      const idf = N > 1 ? Math.log(N / bdf.get(t)) : 1
      return { term: t, score: share * idf, files: c, share, blocks: bdf.get(t) }
    })
    scored.sort((x, y) => y.score - x.score)

    out.set(b, {
      block: b,
      files: n,
      terms: scored.slice(0, perBlock),
      /**
       * 🔴 근거를 함께 돌려준다.
       *
       * 화면이 "왜 이 이름인가" 에 답할 수 있어야 한다 — 이 프로젝트에서
       * 설명 못 하는 결과는 결함이다(D17). `share` 는 "이 블록 파일의 몇 %",
       * `blocks` 는 "전체 블록 중 몇 개에 나오나" 다. 둘이면 사람이 판단할 수 있다.
       */
      label: scored.slice(0, perBlock).map((s) => s.term).join('·') || '(이름 없음)',
    })
  }
  return out
}
