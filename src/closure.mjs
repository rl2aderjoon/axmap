/**
 * **import 폐포**(closure — 진입점에서 import 를 따라 끝까지 갔을 때 닿는 파일 전부)를
 * 구하는 순수 계산.
 *
 * 하나라도 빠지면 실행이 안 되고, 하나라도 남으면 안 쓰는 파일을 남의 저장소에
 * 복사하게 된다. 그래서 **목록을 손으로 적지 않고 코드에서 구한다.**
 *
 * ── 왜 이 파일이 따로 있는가 ────────────────────────────────────────────────
 *
 * 이 목록을 쓰는 곳이 둘이다.
 *
 *   `tools/vendor.mjs`        벤더링(vendoring — 남의 코드를 내 저장소 안에 복사해
 *                             두고 그 사본으로 돌리는 것) 할 파일을 고른다
 *   `test/closure.test.mjs`   그 목록이 늘거나 줄지 않았는지 본다
 *
 * 🔴 두 벌로 적으면 **어긋난 순간 테스트가 통과하면서 사본이 깨진다.** 테스트가
 *    자기 목록을 보고 초록을 내는데 벤더러는 다른 목록을 복사하기 때문이다.
 *    한 함수를 둘이 가져다 쓴다. `src/version.mjs` 를 `tools/version.mjs` 와
 *    `src/mrtarget.mjs` 가 함께 쓰는 것과 같은 이유다.
 *
 * 🔴 여기에는 파일시스템이 없다. 읽기는 `readFile` 인자로 받는다.
 *    `src/governance.mjs` 가 git 을 인자로 받지 않는 것과 같은 이유 —
 *    판정을 검증하려고 진짜 저장소를 만들 필요가 없어야 한다.
 */

/**
 * CI 가 직접 부르는 파일들. `.gitlab-ci.yml` 의 `script:` 에 적힌 것과 승격 봇이
 * 자식 프로세스로 띄우는 것을 합친 자리다.
 *
 * 🔴 **이 목록만 손으로 적는다.** 나머지는 여기서 import 를 따라가 구한다.
 *    진입점은 코드가 알 수 없다 — 무엇을 CI 가 부르기로 했는지는 사람의 결정이다.
 *
 * `governance/vote.mjs` 는 지금 `.gitlab-ci.yml` 에 없지만 넣는다. 사람이 표를
 * 줄 때 부르는 자리이고, 사본에 없으면 팀 저장소를 clone 한 사람은 투표를 할 수
 * 없다 — 표를 저장소 안에 둔 이유가 통째로 사라진다.
 *
 * ── 🔴 `bin/axmap.mjs` 와 `mcp/server.mjs` 가 여기 있는 이유 ─────────────────
 *
 * 이 둘은 CI 가 아니라 **사람과 에이전트가** 부른다. 그런데도 넣는 이유는 하나다:
 *
 *   **팀 저장소만 clone 한 사람에게도 선점(claim)이 있어야 한다.**
 *
 * 없으면 충돌 방지가 "각자 axMap 을 따로 설치했는가" 에 달리게 된다. 안 한 사람
 * 하나가 그날의 모든 보호를 무효로 만들고, 팀 규칙이 팀 저장소 밖의 무언가에
 * 인질로 잡힌다. 장부(`axmap/claims`)는 팀 저장소에 있는데 그것을 읽고 쓸 도구가
 * 없는 상태가 제일 이상하다 — 데이터는 있고 열쇠가 없는 것이다.
 *
 *   bin/axmap.mjs    claim · release · status · verify(훅) · audit
 *   mcp/server.mjs   AI 도구가 붙는 창구. clone 만으로 `ax_claim` 이 뜬다
 *   tools/bus.mjs    에이전트끼리 쪽지 (`ax_inbox` · `ax_send`)
 *
 * 🔴 `tools/bus.mjs` 를 놓쳤다가 실제로 깨뜨렸다. 이 폐포는 **`import` 만 따라간다.**
 *    그런데 `mcp/server.mjs` 는 bus 를 import 하지 않고 **자식 프로세스로 띄운다**
 *    (`path.join(SELF, 'tools', 'bus.mjs')`). 그래서 사본에 안 들어갔고,
 *    `ax_inbox` 를 부르면 "Cannot find module" 로 죽었다.
 *
 *    교훈: **spawn 되는 파일은 import 그래프에 안 잡힌다.** 진입점 목록을 손으로
 *    적는 이유가 정확히 이것이다 — 무엇이 실행되는지는 코드가 알 수 없다.
 *    새 파일을 spawn 하게 되면 여기에도 더해야 한다.
 *
 * 전역 설치(`~/.axmap/app`)를 대신하는 것이 아니다. 둘은 같이 산다 — 팀 저장소
 * 안에서는 `.mcp.json` 이 이 사본을 가리키고, 다른 저장소에서는 전역이 받는다.
 *
 * 대가는 정직하게 적어 둔다: **`bin/axmap.mjs` 는 이 저장소에서 제일 자주 바뀌는
 * 파일이라, 사본을 다시 만들 일이 그만큼 자주 생긴다.** 그 비용을 내고 사는 것이
 * "설치 안 한 사람 때문에 보호가 사라지는 것" 보다 낫다고 판단했다.
 */
export const CI_ENTRYPOINTS = Object.freeze([
  'governance/gate.mjs',
  'governance/vote.mjs',
  'tools/mr-target.mjs',
  'tools/promote.mjs',
  'tools/version.mjs',
  'bin/axmap.mjs',
  'mcp/server.mjs',
  'tools/bus.mjs',
])

/** 슬래시 하나가 `/` 로 시작하면 나눗셈이 아니라 정규식이 올 수 있는 자리다. */
const REGEX_MAY_FOLLOW = new Set(
  ['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n'],
)

/** 같은 판단을 낱글자가 아니라 낱말로 해야 하는 경우 (`return /re/` 처럼). */
const REGEX_MAY_FOLLOW_WORD = new Set(
  ['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'instanceof', 'new', 'do', 'else', 'yield', 'await'],
)

const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c)

/**
 * 주석을 지운다. 문자열·템플릿·정규식 리터럴 **안**은 건드리지 않는다.
 *
 * ── 왜 지우고 시작하는가 ────────────────────────────────────────────────────
 *
 * 이 저장소의 파일들은 머리말 주석에 사용법을 적어 둔다. 거기에
 * `node axmap/governance/gate.mjs` 같은 줄이 그대로 있고, `import` 라는 낱말도
 * 설명문에 나온다. 주석을 남겨 두고 정규식을 돌리면 **주석에 적힌 예시를 진짜
 * import 로 세어** 있지도 않은 파일을 복사 목록에 넣게 된다.
 *
 * 🔴 반대로 문자열은 지우면 안 된다. 우리가 찾는 것이 바로 문자열이다.
 *    그래서 "주석만" 지운다. 정규식 리터럴을 따로 알아보는 이유도 하나뿐이다 —
 *    `/[a-z]\/\//` 같은 것을 주석 시작으로 잘못 읽으면 그 뒤가 통째로 사라진다.
 */
export function stripComments(source) {
  const src = String(source ?? '')
  let out = ''
  let i = 0
  let prev = '' // 직전의 공백 아닌 코드 글자
  let word = '' // 그 글자로 끝나는 낱말 (없으면 빈 문자열)

  const regexMayFollow = () => REGEX_MAY_FOLLOW.has(prev) || REGEX_MAY_FOLLOW_WORD.has(word)
  const advance = (c) => {
    if (/\s/.test(c)) return // 공백은 낱말을 끊지 않는다. `return /re/` 을 알아보려면 필요하다
    if (isWordChar(c)) word += c
    else word = ''
    prev = c
  }

  while (i < src.length) {
    const c = src[i]
    const d = src[i + 1]

    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }

    if (c === '/' && d === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      out += ' ' // 주석이 붙어 있던 두 토큰이 한 낱말로 붙지 않게 자리를 남긴다
      prev = ''
      word = ''
      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        const ch = src[i]
        out += ch
        i++
        if (ch === c) break
      }
      prev = c
      word = ''
      continue
    }

    if (c === '/' && regexMayFollow()) {
      out += c
      i++
      let inClass = false
      while (i < src.length) {
        const ch = src[i]
        if (ch === '\\') {
          out += ch + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (ch === '\n') break // 줄을 넘는 정규식 리터럴은 없다. 잘못 짚었다는 뜻이니 멈춘다
        out += ch
        i++
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
      }
      prev = '/'
      word = ''
      continue
    }

    out += c
    advance(c)
    i++
  }

  return out
}

/*
 * import 를 알아보는 세 가지 모양.
 *
 * `[^'";()]*?` 로 가운데를 막아 둔 것은 한 문장을 넘어가지 못하게 하기 위해서다.
 * 이걸 `[\s\S]*?` 로 두면 앞 줄의 `import` 와 한참 뒤의 `from` 이 짝지어져 엉뚱한
 * 문자열을 경로로 읽는다.
 *
 * 알려진 한계: `export const from = './x.mjs'` 처럼 `from` 을 변수 이름으로 쓰면
 * 거짓 양성이 난다. 그때는 그 경로가 bare 나 없는 파일로 잡혀 테스트가 빨개진다 —
 * 조용히 지나가지는 않는다.
 */
const RE_FROM = /(?:^|[\s;})])(?:import|export)\s[^'";()]*?\bfrom\s*(['"])([^'"]+)\1/gm
const RE_SIDE_EFFECT = /(?:^|[\s;})])import\s*(['"])([^'"]+)\1/gm
const RE_DYNAMIC = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/gm

/**
 * 소스 한 벌에서 import 대상 문자열을 전부 뽑는다. 주석은 먼저 지운다.
 *
 * `import.meta.url` 은 걸리지 않는다 — 세 정규식 모두 `import` 뒤에 공백이나
 * 여는 괄호를 요구하고, `.` 은 어느 쪽도 아니다.
 */
export function importSpecifiers(source) {
  const code = stripComments(source)
  const found = []
  for (const re of [RE_FROM, RE_SIDE_EFFECT, RE_DYNAMIC]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) found.push(m[2])
  }
  return found
}

/**
 * import 대상을 셋으로 가른다.
 *
 *   `builtin`   `node:fs` 처럼 Node 가 들고 있는 것. 복사할 것이 없다
 *   `relative`  `./x.mjs` · `../src/y.mjs`. 따라가서 같이 복사해야 한다
 *   `bare`      그 밖 전부. npm 패키지이거나 `fs` 처럼 `node:` 를 빠뜨린 것
 *
 * 🔴 `fs` 를 `bare` 로 세는 것은 실수가 아니다. 접두사 없는 내장 이름은 같은
 *    이름의 npm 패키지에 가려질 수 있고, 그러면 어느 쪽이 로드됐는지 코드만
 *    보고는 알 수 없다. 이 저장소는 `node:` 를 붙이기로 했으므로 안 붙은 것은
 *    구분 없이 빨갛게 만든다.
 */
export function classifySpecifier(spec) {
  const s = String(spec ?? '')
  if (s.startsWith('node:')) return 'builtin'
  if (s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../')) return 'relative'
  return 'bare'
}

/** posix 경로 계산. `path` 모듈을 안 쓰는 이유는 Windows 에서 `\` 가 섞이면 안 되어서다. */
function posixDirname(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/**
 * `fromRel` 안의 `spec` 이 가리키는 파일을 루트 기준 상대 경로로 돌려준다.
 * 루트 밖으로 나가면 `null` — 복사할 수 없는 것이므로 부르는 쪽이 알아야 한다.
 */
export function resolveImport(fromRel, spec) {
  const parts = `${posixDirname(String(fromRel))}/${String(spec)}`.split('/')
  const stack = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      if (stack.length === 0) return null // 루트를 뚫고 올라갔다
      stack.pop()
      continue
    }
    stack.push(p)
  }
  return stack.length === 0 ? null : stack.join('/')
}

/**
 * 진입점에서 출발해 닿는 파일 전부를 모은다.
 *
 * @param {object} opts
 * @param {string[]} [opts.entries]  루트 기준 상대 경로. 기본은 `CI_ENTRYPOINTS`
 * @param {(rel: string) => (string|null)} opts.readFile
 *        파일 내용. 없으면 `null` 을 준다 (던지지 않는다 — 없는 파일도 결과의 일부다)
 * @returns {{files: string[], bare: {file: string, spec: string}[],
 *            missing: string[], outside: {file: string, spec: string}[], entries: string[]}}
 *
 * 🔴 못 읽은 파일을 예외로 터뜨리지 않고 `missing` 에 담는 이유: 부르는 쪽이
 *    "무엇이 왜 안 됐는지" 를 한 번에 보고해야 하기 때문이다. 첫 번째에서 죽으면
 *    두 번째 문제는 다음 실행에서야 보인다.
 */
export function importClosure({ entries = CI_ENTRYPOINTS, readFile } = {}) {
  if (typeof readFile !== 'function') throw new TypeError('importClosure: readFile 함수가 필요합니다')

  const entryList = [...entries]
  const files = new Set()
  const bare = []
  const missing = []
  const outside = []
  const seen = new Set()
  const queue = [...entryList]

  while (queue.length > 0) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)

    const source = readFile(rel)
    if (source == null) {
      missing.push(rel)
      continue
    }
    files.add(rel)

    for (const spec of importSpecifiers(source)) {
      const kind = classifySpecifier(spec)
      if (kind === 'builtin') continue
      if (kind === 'bare') {
        bare.push({ file: rel, spec })
        continue
      }
      const next = resolveImport(rel, spec)
      if (next === null) {
        outside.push({ file: rel, spec })
        continue
      }
      queue.push(next)
    }
  }

  return { files: [...files].sort(), bare, missing, outside, entries: entryList }
}

/**
 * 폐포를 구하다 만난 문제를 사람이 읽는 줄로 바꾼다. 문제가 없으면 빈 배열.
 *
 * 벤더러와 테스트가 같은 문장을 내야 한다 — 한쪽에서 본 메시지를 다른 쪽에서
 * 검색했을 때 안 나오면 같은 문제인지 알 수 없다.
 */
export function formatClosureProblems(closure) {
  const lines = []
  for (const rel of closure.missing) {
    lines.push(`없는 파일을 import 합니다: ${rel}`)
  }
  for (const { file, spec } of closure.outside) {
    lines.push(`루트 밖을 import 합니다: ${file} → ${spec} (복사할 수 없습니다)`)
  }
  for (const { file, spec } of closure.bare) {
    lines.push(
      `Node 내장이 아닌 것을 import 합니다: ${file} → '${spec}'\n` +
        `    내장이라면 'node:${spec}' 처럼 접두사를 붙이세요.\n` +
        `    패키지라면 CI 진입점에서 닿는 자리에 둘 수 없습니다 — 사본에는 node_modules 가 없습니다.`,
    )
  }
  return lines
}
