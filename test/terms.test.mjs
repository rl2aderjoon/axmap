import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KEYWORDS,
  MIN_DOCS,
  deriveStopwords,
  documentFrequency,
  idfFrom,
  idfOf,
  keywordsOf,
  labelBlocks,
  meaningful,
  mergeDf,
  termsOf,
  tokens,
  vocabulary,
} from '../corpus/terms.mjs'

// ── 토큰화 ──────────────────────────────────────────────────────────────────

test('camelCase 와 PascalCase 경계에서 자른다', () => {
  assert.deepEqual(tokens('userAuth'), ['user', 'auth'])
  assert.deepEqual(tokens('UserAuthService'), ['user', 'auth', 'service'])
})

test('연속 대문자는 한 낱말로 두되 뒤따르는 낱말과는 가른다', () => {
  // HTTPServer 를 h·t·t·p·server 로 쪼개면 아무 뜻도 안 남는다
  assert.deepEqual(tokens('HTTPServer'), ['http', 'server'])
  assert.deepEqual(tokens('parseJSONBody'), ['parse', 'json', 'body'])
})

test('경로 구분자와 밑줄에서 자르고 확장자는 버린다', () => {
  assert.deepEqual(tokens('src/user_auth/http-server.ts'), ['src', 'user', 'auth', 'http', 'server'])
})

test('확장자를 버리고 버전 꼬리표도 남기지 않는다', () => {
  assert.ok(!tokens('a/b.ts').includes('ts'))
  assert.deepEqual(tokens('release/v1.2.3'), ['release'])
})

test('한 글자와 숫자만 있는 조각은 버린다', () => {
  // `x` 는 이름이 아니고 `2` 는 뜻이 없다
  assert.deepEqual(tokens('x/i/ab/12/v2'), ['ab'])
})

test('숫자가 이름의 일부인 것은 부수지 않는다', () => {
  /**
   * 🔴 글자↔숫자 경계에서 무조건 자르면 `utf8` 이 `utf` + `8` 로 부서지고
   * `i18n` 은 통째로 사라진다. 끝의 숫자를 **떼어 본 뒤 남는 글자 수로**
   * 판단하는 이유가 이것이다.
   */
  assert.deepEqual(tokens('encoding/utf8.js'), ['encoding', 'utf'])
  assert.ok(tokens('lib/i18n/index.js').includes('i18n'))
  assert.ok(tokens('auth/oauth2.js').includes('oauth'))
})

test('termsOf 는 중복을 없앤다 — DF 는 파일당 한 번만 센다', () => {
  assert.deepEqual([...termsOf('user/user/userService')], ['user', 'service'])
})

// ── 예약어 ──────────────────────────────────────────────────────────────────

test('cpp 는 c 를, ts 는 js 를 물려받는다', () => {
  assert.ok(keywordsOf('cpp').has('template')) // 자기 것
  assert.ok(keywordsOf('cpp').has('struct'))   // c 에서 물려받은 것
  assert.ok(keywordsOf('ts').has('interface'))
  assert.ok(keywordsOf('ts').has('const'))
})

test('모르는 언어면 빈 집합 — 없는 것을 지어내지 않는다', () => {
  assert.equal(keywordsOf('brainfuck').size, 0)
  assert.equal(keywordsOf(null).size, 0)
  assert.equal(keywordsOf(undefined).size, 0)
})

test('예약어 목록은 명백히 뜻 없는 것만 담는다', () => {
  /**
   * 🔴 이 검사는 설계 근거다. 손으로 적는 목록이 길어지기 시작하면
   * "불용어는 DF 에서 유도한다" 는 설계가 무너지고 있다는 신호다.
   * `service` · `util` · `handler` 는 흔하지만 저장소에 따라 신호일 수 있어
   * 여기 들어오면 안 된다 — DF 가 판단해야 한다.
   */
  const forbidden = ['service', 'util', 'utils', 'handler', 'manager', 'helper', 'common', 'core']
  for (const [lang, words] of Object.entries(KEYWORDS)) {
    for (const f of forbidden) {
      assert.ok(!words.includes(f), `${lang} 예약어에 '${f}' 가 들어 있다 — DF 가 판단해야 한다`)
    }
  }
})

// ── 문서빈도 · IDF ──────────────────────────────────────────────────────────

test('documentFrequency 는 문서 수와 낱말별 문서 수를 센다', () => {
  const { df, n } = documentFrequency([['a', 'b'], ['a'], ['a', 'c']])
  assert.equal(n, 3)
  assert.equal(df.get('a'), 3)
  assert.equal(df.get('b'), 1)
})

test('mergeDf 는 두 코퍼스를 더한다', () => {
  const a = documentFrequency([['x'], ['x', 'y']])
  const b = documentFrequency([['x', 'z']])
  const m = mergeDf(a, b)
  assert.equal(m.n, 3)
  assert.equal(m.df.get('x'), 3)
  assert.equal(m.df.get('z'), 1)
})

test('IDF 는 모든 문서에 나오는 낱말에도 0 을 주지 않는다', () => {
  /**
   * 🔴 이것이 평활(+1)을 넣은 이유 전체다. 0 이 나오면 그 낱말만 가진 파일의
   * 벡터가 통째로 0 이 되고, 0 벡터는 무엇과도 비슷하지 않아 군집이 조용히
   * 깨진다 — 에러 없이. 이 검사를 지우면 그 사고가 돌아온다.
   */
  const m = idfFrom(documentFrequency([['a'], ['a'], ['a']]))
  assert.ok(idfOf(m, 'a') > 0, '모든 문서에 나오는 낱말의 IDF 가 0 이면 안 된다')
})

test('못 본 낱말은 가장 특이한 것으로 친다', () => {
  const m = idfFrom(documentFrequency([['a'], ['a', 'b']]))
  assert.ok(idfOf(m, '처음보는말') > idfOf(m, 'a'))
})

// ── 불용어 유도 ─────────────────────────────────────────────────────────────

/**
 * 문서 n개. `zz` 는 앞 hi개에, `rare` 는 뒤 lo개에 나온다.
 * 나머지는 문서마다 고유해서 DF 가 1 이다 — 잡음이 섞이지 않게 한다.
 */
const docsWith = (n, hi, lo = 0) => Array.from({ length: n }, (_, i) => {
  const d = [`uniq${i}`]
  if (i < hi) d.push('zz')
  if (i >= n - lo) d.push('rare')
  return d
})

test('문서의 at 비율 이상에 나오면 불용어다', () => {
  const d = deriveStopwords(documentFrequency(docsWith(100, 50, 10)), { at: 0.4 })
  assert.ok(d.applied)
  assert.ok(d.words.has('zz'), '문서의 50% 에 나온다 — 잡음이다')
  assert.ok(!d.words.has('rare'), '문서의 10% 에만 나온다 — 신호다')
})

test('표본이 모자라면 답을 내지 않는다 — 빈 목록과 "안 냈다"는 다르다', () => {
  /**
   * 🔴 설계 근거. `ssot.mjs` 가 분위수에 대해 이미 같은 규칙을 쓴다 —
   * 저장소 3개로 만든 기준을 기준이라고 부르지 않는다.
   * 빈 목록을 "불용어가 없다" 로 읽으면 확신 있게 틀린 답이 된다(D5).
   */
  const d = deriveStopwords(documentFrequency(docsWith(10, 9)), { at: 0.4 })
  assert.equal(d.applied, false)
  assert.equal(d.words.size, 0)
  assert.match(d.why, /문서 10개/)
})

test('MIN_DOCS 는 조절 가능하다', () => {
  const d = deriveStopwords(documentFrequency(docsWith(10, 9)), { at: 0.4, minDocs: 5 })
  assert.equal(d.applied, true)
  assert.ok(d.words.has('zz'))
})

// ── 3단 ─────────────────────────────────────────────────────────────────────

test('세 단은 덮어쓰지 않고 더해진다', () => {
  const repo = documentFrequency(docsWith(MIN_DOCS, MIN_DOCS))       // 'zz' 가 100%
  const langCell = documentFrequency(
    Array.from({ length: MIN_DOCS }, (_, i) => ['framework', `u${i}`]),    // 'framework' 가 100%
  )
  const v = vocabulary({ lang: 'py', repo, langCell })
  assert.ok(v.stop.has('zz'), '저장소 잡음')
  assert.ok(v.stop.has('framework'), '언어 관용어')
  assert.ok(v.stop.has('def'), '언어 예약어')
  assert.equal(v.basis.repo, true)
  assert.equal(v.basis.lang, true)
})

test('표본 부족한 단은 건너뛰고 그 사실을 basis 에 남긴다', () => {
  const repo = documentFrequency(docsWith(5, 5))
  const v = vocabulary({ lang: 'go', repo })
  assert.equal(v.basis.repo, false)
  assert.ok(v.basis.why.some((w) => w.startsWith('repo:')))
  assert.ok(v.stop.has('func'), '예약어는 코퍼스와 무관하게 항상 적용된다')
})

test('IDF 는 표본이 충분한 것 중 가장 좁은 단을 쓴다', () => {
  const repo = documentFrequency(docsWith(5, 5))                    // 부족
  const langCell = documentFrequency(docsWith(MIN_DOCS, 1))         // 충분
  const v = vocabulary({ lang: 'go', repo, langCell })
  assert.equal(v.idfBasis, 'lang')
})

// ── 절대 비지 않는다 ────────────────────────────────────────────────────────

test('불용어를 다 걷어내도 낱말을 하나는 남긴다', () => {
  /**
   * 🔴 설계 근거. `service/service.js` 처럼 이름이 전부 불용어인 파일은
   * 걸러내고 나면 아무 데도 안 걸리고 어떤 군집에도 안 붙는다 —
   * **조용히 사라지는 것이라 아무도 눈치채지 못한다.**
   * 그래서 하나는 남기고, 남겼다는 사실을 `salvaged` 로 알린다.
   */
  const v = { stop: new Set(['service', 'src']), idf: null }
  const r = meaningful('src/service/service.js', v)
  assert.equal(r.terms.length, 1)
  assert.equal(r.salvaged, true)
})

test('남길 것이 있으면 건지지 않는다', () => {
  const v = { stop: new Set(['src']), idf: null }
  const r = meaningful('src/payment.js', v)
  assert.deepEqual(r.terms, ['payment'])
  assert.equal(r.salvaged, false)
})

test('이름에 낱말이 아예 없으면 빈 배열이고, 그것은 건진 것이 아니다', () => {
  const r = meaningful('1/2/3', { stop: new Set(), idf: null })
  assert.deepEqual(r.terms, [])
  assert.equal(r.salvaged, false)
})

// ── 블록 이름 붙이기 ────────────────────────────────────────────────────────

test('다른 블록에 없는 낱말이 이름이 된다', () => {
  const assign = new Map([
    ['src/payment/charge.js', 'A'],
    ['src/payment/refund.js', 'A'],
    ['src/auth/login.js', 'B'],
    ['src/auth/token.js', 'B'],
  ])
  const out = labelBlocks(assign, { stop: new Set(['src']) })
  assert.ok(out.get('A').label.includes('payment'))
  assert.ok(out.get('B').label.includes('auth'))
})

test('모든 블록에 흔한 낱말은 이름에서 밀려난다', () => {
  const assign = new Map([
    ['common/payment.js', 'A'],
    ['common/charge.js', 'A'],
    ['common/auth.js', 'B'],
    ['common/token.js', 'B'],
  ])
  const out = labelBlocks(assign, { stop: new Set() })
  // 'common' 은 두 블록 모두에 100% 나오므로 블록 사이 IDF 가 가장 낮다
  assert.notEqual(out.get('A').terms[0].term, 'common')
})

test('개수가 아니라 비율로 잰다 — 작은 블록이 묻히지 않는다', () => {
  /**
   * 개수를 그대로 쓰면 큰 블록의 흔한 낱말이 작은 블록의 특징적인 낱말을
   * 항상 이기고, 그러면 이름이 전부 비슷해져서 아무 일도 안 한다.
   */
  const assign = new Map([
    ...Array.from({ length: 10 }, (_, i) => [`x/core/a${i}.js`, 'BIG']),
    ...Array.from({ length: 10 }, (_, i) => [`x/edge/b${i}.js`, 'BIG']),
    ['y/quantum/one.js', 'SMALL'],
    ['y/quantum/two.js', 'SMALL'],
  ])
  const out = labelBlocks(assign, { stop: new Set() })
  assert.equal(out.get('SMALL').terms[0].term, 'quantum')

  // quantum 은 파일 2개에만 나오는데, 파일 10개에 나오는 core 를 이긴다
  const q = out.get('SMALL').terms[0]
  const core = out.get('BIG').terms.find((t) => t.term === 'core')
  assert.equal(q.files, 2)
  assert.equal(core.files, 10)
  assert.ok(q.score > core.score, '개수 2 가 개수 10 을 비율로 이겨야 한다')
})

test('모든 블록에 있는 낱말은 점수가 정확히 0 이다', () => {
  /**
   * 🔴 설계 근거이자 실제로 밟은 버그다.
   *
   * 파일 IDF 와 같은 평활(+1) 식을 여기에도 썼더니, 두 블록이 전부 `common/`
   * 아래 있을 때 **두 블록의 이름이 나란히 `common` 이 됐다.** 이름이 같으면
   * 이름이 아무 일도 안 한다. 이름 붙이기는 벡터를 만들지 않으므로 0 을
   * 피할 이유가 없고, 오히려 0 이 되어야 맞다.
   */
  const assign = new Map([
    ['common/payment.js', 'A'],
    ['common/auth.js', 'B'],
  ])
  const out = labelBlocks(assign, { stop: new Set() })
  const common = out.get('A').terms.find((t) => t.term === 'common')
  assert.equal(common.score, 0)
  assert.notEqual(out.get('A').label, out.get('B').label, '두 블록의 이름이 같으면 안 된다')
})

test('블록이 하나뿐이면 비율만 본다', () => {
  // 비교 대상이 없어 IDF 가 전부 0 이 되면 순서가 무작위가 된다.
  const assign = new Map([['a/payment.js', 'ONLY'], ['a/payment2.js', 'ONLY'], ['a/misc.js', 'ONLY']])
  const out = labelBlocks(assign, { stop: new Set() })
  assert.equal(out.get('ONLY').terms[0].term, 'payment')
})

test('이름의 근거를 함께 돌려준다 — 설명 못 하는 결과는 결함이다', () => {
  const assign = new Map([['a/payment.js', 'A'], ['a/charge.js', 'A'], ['b/auth.js', 'B']])
  const top = labelBlocks(assign, { stop: new Set() }).get('A').terms[0]
  assert.ok(typeof top.share === 'number', 'share — 이 블록 파일의 몇 %')
  assert.ok(typeof top.blocks === 'number', 'blocks — 전체 블록 중 몇 개에 나오나')
  assert.ok(typeof top.files === 'number')
})

test('빈 입력에도 죽지 않는다', () => {
  assert.equal(labelBlocks(new Map(), { stop: new Set() }).size, 0)
  assert.equal(labelBlocks(null, { stop: new Set() }).size, 0)
})
