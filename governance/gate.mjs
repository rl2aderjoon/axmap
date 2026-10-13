#!/usr/bin/env node
/**
 * 합의 게이트 — **git 에서 재료를 모아 순수 판정을 부르는 층.**
 *
 * 이 파일이 답하는 질문은 `src/governance.mjs` 와 같다.
 *
 *   "이 MR(**Merge Request** — 내 브랜치의 변경을 다른 브랜치로 합쳐 달라는 요청)은
 *    정족수(**통과에 필요한 최소 찬성 수**)를 채웠는가?"
 *
 * 다만 **판정은 여기서 하지 않는다.** 여기서 하는 일은 딱 둘이다.
 *
 *   1. 재료를 모은다 — 정책 · 바뀐 파일 · 대상 커밋 · 소스 커밋의 author · 표
 *   2. `judge()` 를 한 번 부르고 그 결과의 `exit` 를 **그대로** 종료 코드로 쓴다
 *
 * 🔴 게이트가 종료 코드를 다시 고르지 않는다. 이 층의 계약이 곧 종료 코드이고,
 *    계약은 테스트할 수 있는 자리(= 순수 함수)에 있어야 한다. 게이트가 메시지를
 *    보고 코드를 고르기 시작하면 **문구를 다듬는 커밋이 판정을 바꾼다.**
 *
 * ── G2 가 여기 있는 이유 ──────────────────────────────────────────────────
 *
 * G1~G5 중 **G2 만 순수 판정 밖에 있다** (governance/GOVERNANCE.md).
 *
 *   G2  정책은 언제나 **타깃 브랜치**(**합쳐 받는 쪽 브랜치**)에서 읽는다
 *
 * 어느 브랜치에서 정책을 읽어오는가는 git 을 만지는 일이라 게이트의 책임이다.
 * 소스 브랜치(**합쳐 달라고 내미는 쪽 브랜치**)에서 읽으면 **정족수를 1 로 낮추는
 * MR 이 자기가 낮춘 규칙으로 통과한다.** 그래서 아래 `readPolicy` 는 타깃 브랜치의
 * 커밋에서만 파일을 꺼내고, 작업 트리(**지금 디스크에 펼쳐져 있는 파일들**)는
 * 쳐다보지 않는다.
 *
 * ── 실패 방향 ────────────────────────────────────────────────────────────
 *
 * fail-open(**애매하면 통과시킨다**) 을 하지 않는다. 재료를 못 모으면 통과가
 * 아니라 **판정 불가(exit 1)** 다. 다만 "아무도 아직 투표 안 함" 은 고장이 아니라
 * 정상적인 상태이므로 **표 0장으로 정상 판정**해서 미달(exit 2)이 나오게 한다.
 * 이 둘을 뭉치면 에이전트가 고장을 "기다리면 되는 일" 로 읽고 영원히 기다린다.
 *
 * ── 부르는 법 ────────────────────────────────────────────────────────────
 *
 *   node axmap/governance/gate.mjs                                 # CI: 환경변수
 *   node axmap/governance/gate.mjs --source <브랜치> --target <브랜치>   # 손으로
 *
 * CI(**Continuous Integration** — 코드를 올릴 때마다 자동으로 검사를 돌리는 것)
 * 에서는 GitLab 이 넣어 주는 `CI_MERGE_REQUEST_SOURCE_BRANCH_NAME` ·
 * `CI_MERGE_REQUEST_TARGET_BRANCH_NAME` 을 읽는다. 플래그가 있으면 플래그가 이긴다.
 * **둘 다 없으면 추측하지 않고 멈춘다** (`tools/version.mjs` 의 `currentBranch()`
 * 가 detached HEAD(**어느 브랜치에도 붙어 있지 않은 상태**) 에서 하는 것과 같다).
 *
 * ── 정책 파일이 어디 있나 ─────────────────────────────────────────────────
 *
 * `--policy <경로>` → 환경변수 `AXMAP_POLICY_PATH` → 기본값
 * (`src/governance.mjs` 의 `DEFAULT_POLICY_PATH`). 플래그가 환경변수를 이긴다.
 * 경로는 **저장소 루트 기준**이다 — 이 파일이 어디서 도는지와 무관하다.
 *
 * 🔴 못 찾으면 다른 자리를 대신 뒤지지 **않는다.** 폴백을 두면 두 자리 중 어느
 *    것이 진짜 정책인지 아무도 모르게 된다. 멈추고 어디를 봤는지 말한다.
 */

import { spawnSync } from 'node:child_process'
import {
  EXIT,
  DEFAULT_POLICY_PATH,
  judge,
  formatVerdict,
} from '../src/governance.mjs'

/** 표가 사는 브랜치. 장부 브랜치(`axmap/claims`)와 같은 방식이다 — 코드와 안 섞는다. */
const VOTES_BRANCH = 'axmap/votes'

// ---------------------------------------------------------------------------
// git 호출 — bin/axmap.mjs 의 관례를 그대로 쓴다
// ---------------------------------------------------------------------------

/**
 * git 이 훅(**커밋 같은 동작 직전·직후에 자동으로 도는 스크립트**)을 실행할 때
 * 심어 놓는 환경변수들. cwd 보다 우선하므로, 다른 저장소·다른 인덱스를 가리키는
 * 채로 남겨두면 게이트가 엉뚱한 곳을 읽는다. bin/axmap.mjs 와 같은 목록이다.
 */
const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
]

function cleanEnv() {
  const e = { ...process.env }
  for (const k of GIT_ENV_KEYS) delete e[k]
  return e
}

let ROOT = null

/**
 * git 한 번. `raw` 는 다듬지 않은 stdout 이다 — `-z`(**출력을 NUL 문자로 구분**)
 * 로 받은 목록은 trim 하면 안 되므로 둘을 따로 돌려준다.
 */
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd ?? ROOT ?? undefined,
    input: opts.input,
    env: cleanEnv(),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
  const out = r.stdout ?? ''
  return { code: r.status ?? 1, out: out.trim(), raw: out, err: (r.stderr ?? '').trim() }
}

/**
 * 판정 불가로 멈춘다.
 *
 * 기본 종료 코드가 1(판정 불가)인 이유: 여기까지 오는 실패는 전부 **환경 문제**다.
 * 투표로는 풀리지 않으므로 미달(2)로 내보내면 사람이 영원히 투표를 기다린다.
 */
function die(msg, code = EXIT.UNDECIDABLE) {
  console.error(`합의 판정 불가 — ${msg}`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

/** bin/axmap.mjs 의 parseArgs 와 같은 규칙. `--k v` · `--k=v` · `--k`(=true) */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { positional.push(a); continue }
    const eq = a.indexOf('=')
    if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i]
    else flags[a.slice(2)] = true
  }
  return { positional, flags }
}

/** 플래그 값이 **문자열일 때만** 쓴다. `--source` 만 주면 값은 `true` 다. */
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

const HELP = `합의 게이트 — 이 MR 이 정족수를 채웠는지 판정한다

  node axmap/governance/gate.mjs [--source <브랜치>] [--target <브랜치>] [--json]

  --source        합쳐 달라고 내미는 쪽 브랜치. 없으면 CI_MERGE_REQUEST_SOURCE_BRANCH_NAME
  --target        합쳐 받는 쪽 브랜치.       없으면 CI_MERGE_REQUEST_TARGET_BRANCH_NAME
  --policy        정책 파일의 자리 (저장소 루트 기준). 없으면 AXMAP_POLICY_PATH
                  → ${DEFAULT_POLICY_PATH}. 못 찾으면 다른 자리를 뒤지지 않고 멈춘다
  --json          판정 결과를 JSON 으로도 낸다 (사람이 읽는 판정문은 stderr 로 간다)
  --votes-ref     표를 읽어올 ref 를 직접 지정한다 (기본: ${VOTES_BRANCH})
  --remote        원격 이름. 없으면 git config axmap.remote → 유일한 원격 → origin
  --no-fetch      원격에서 표·브랜치를 가져오지 않는다 (로컬에 있는 것만 본다)

종료 코드
  0  정족수 충족          머지해도 된다
  2  정족수 미달          정상적인 "아직 아니다". 사람에게 투표를 요청한다
  1  판정 불가            환경을 고친다. 투표로는 안 풀린다
  4  정책 자체가 깨짐     정책을 고친다 (그 MR 은 개정 문턱을 지난다)
`

// ---------------------------------------------------------------------------
// 재료 1 — 어느 브랜치에서 어느 브랜치로인가
// ---------------------------------------------------------------------------

function repoRoot() {
  const r = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (r.code !== 0) die('git 저장소 안에서 실행해야 합니다.')
  return r.out
}

/**
 * 원격(**코드를 올려두는 서버 쪽 저장소**)의 이름.
 *
 * bin/axmap.mjs 의 `resolveRemote` 와 **같은 순서**로 고른다. 거기서는 못 고르면
 * 멈추지만 여기서는 `null` 을 돌려주고 로컬만 본다 — 게이트는 아무것도 쓰지 않고,
 * 표를 못 가져와서 생기는 오차는 언제나 **덜 세는 쪽**(= 통과가 아닌 쪽)이라
 * 안전한 방향이기 때문이다.
 */
function resolveRemote(flags) {
  const all = git(['remote']).out.split('\n').map((s) => s.trim()).filter(Boolean)
  const given = str(flags.remote) ?? str(process.env.AXMAP_REMOTE)
  if (given) {
    if (!all.includes(given)) {
      die(`지정한 원격이 없습니다: ${given}${all.length ? ` (있는 것: ${all.join(', ')})` : ''}`)
    }
    return given
  }
  const cfg = git(['config', '--get', 'axmap.remote']).out
  if (cfg && all.includes(cfg)) return cfg
  if (all.length === 1) return all[0]
  if (all.includes('origin')) return 'origin'
  return null
}

/**
 * 브랜치 이름 하나를 **40자 커밋 해시**로 바꾼다.
 *
 * 이름 대신 해시를 들고 다니는 이유: 재료를 모으는 동안 ref 가 움직여도 판정이
 * 한 커밋 위에서 일관되게 돈다. 표는 sha 에 묶이므로(G3) 여기서 흔들리면 안 된다.
 *
 * CI 는 소스 브랜치만 받아온 상태일 수 있어서 타깃이 로컬에 없는 일이 흔하다.
 * 그래서 로컬 → 원격 추적 ref → 실제 fetch 순으로 찾는다. **끝내 못 찾으면
 * 추측하지 않고 멈춘다** — 엉뚱한 커밋을 타깃으로 삼으면 G2 가 무너진다.
 */
function resolveCommit(name, remote, what, allowFetch) {
  for (const t of [name, remote ? `refs/remotes/${remote}/${name}` : null]) {
    if (!t) continue
    const r = git(['rev-parse', '--verify', '--quiet', `${t}^{commit}`])
    if (r.code === 0 && r.out) return r.out
  }
  if (allowFetch && remote) {
    const f = git(['fetch', '--quiet', remote, name])
    if (f.code === 0) {
      const r = git(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])
      if (r.code === 0 && r.out) return r.out
    }
  }
  die(
    `${what} 브랜치를 찾을 수 없습니다: ${name}\n`
    + `  로컬에도 ${remote ? `${remote}/${name} 에도 ` : ''}없습니다.\n`
    + `  CI 라면 판정 전에 그 브랜치를 받아와야 합니다:  git fetch ${remote ?? 'origin'} ${name}`,
  )
  return null // 도달하지 않는다 (die 가 프로세스를 끝낸다).
}

// ---------------------------------------------------------------------------
// 재료 2 — 정책 (🔴 반드시 타깃 브랜치에서. G2)
// ---------------------------------------------------------------------------

/**
 * 정책 파일의 자리를 정한다: `--policy` 플래그 → 환경변수 `AXMAP_POLICY_PATH`
 * → `DEFAULT_POLICY_PATH`. 플래그가 환경변수를 이긴다 (이 저장소의 다른 CLI 와
 * 같은 관례 — `--remote` 가 `AXMAP_REMOTE` 를 이기는 것과 같다).
 *
 * 경로는 **저장소 루트 기준**이다. `git show <커밋>:<경로>` 에 그대로 들어가므로
 * 앞의 `./` 나 `\` 는 git 이 못 알아본다. 여기서 다듬어 준다.
 */
function resolvePolicyPath(flags) {
  const given = str(flags.policy) ?? str(process.env.AXMAP_POLICY_PATH)
  const raw = given ?? DEFAULT_POLICY_PATH
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function readPolicy(targetRev, targetName, policyPath) {
  // 🔴 `git show <커밋>:<경로>` 다. 디스크의 파일을 읽지 않는다 — 지금 체크아웃된
  //    것은 대개 소스 브랜치이고, 소스의 정책으로 판정하면 G2 가 통째로 무너진다.
  const r = git(['show', `${targetRev}:${policyPath}`])
  if (r.code !== 0) {
    // 🔴 다른 자리를 대신 찾아보지 않는다. 폴백을 두면 두 자리 중 어느 것이
    //    진짜 정책인지 아무도 모르게 되고, 그것이 이 저장소가 "장부가 둘" 로 한 번
    //    아프게 배운 모양이다. 대신 **어디를 봤는지**와 **어떻게 바꾸는지**를 말한다.
    die(
      `타깃 브랜치(${targetName})에서 정책 파일을 읽을 수 없습니다: ${policyPath}\n`
      + `  ${r.err.split('\n')[0]}\n\n`
      + '정책은 **반드시 타깃 브랜치에서** 읽습니다 (G2). 소스 브랜치의 정책을 대신\n'
      + '쓰지 않는 이유: 정족수를 1 로 낮추는 MR 이 자기가 낮춘 규칙으로 통과합니다.\n\n'
      + `본 자리는 ${policyPath} 하나뿐입니다. 다른 자리를 대신 뒤지지 않습니다 —\n`
      + '두 자리를 다 보면 어느 것이 진짜 정책인지 아무도 모르게 되기 때문입니다.\n\n'
      + `해결 1: ${policyPath} 를 타깃 브랜치에 먼저 머지하세요.\n`
      + '해결 2: 자리가 다르면 알려주세요 —\n'
      + '        node <이 파일> --policy <저장소 루트 기준 경로>\n'
      + '        또는 환경변수 AXMAP_POLICY_PATH=<경로> (플래그가 이깁니다)\n'
      + `        기본값: ${DEFAULT_POLICY_PATH}`,
    )
  }
  try {
    return JSON.parse(r.out)
  } catch (e) {
    die(`타깃 브랜치(${targetName})의 정책 JSON 을 읽을 수 없습니다: ${policyPath}\n  ${e.message}`)
  }
  return null
}

// ---------------------------------------------------------------------------
// 재료 3 — 무엇이 바뀌었나 / 누가 썼나
// ---------------------------------------------------------------------------

/**
 * 갈림점(**두 브랜치가 마지막으로 같았던 커밋**)부터 소스까지의 변경 목록.
 *
 * 🔴 `diff <타깃> <소스>` 가 아니라 `diff <갈림점> <소스>` 다. 앞의 것을 쓰면
 *    **타깃에만 있는 남의 변경까지 내 MR 의 변경으로 세어져** 문턱이 엉뚱하게
 *    올라간다. MR 이 실제로 바꾸는 것은 갈림점 이후의 것뿐이다.
 *
 * 🔴 `-z` 와 `core.quotepath=false` 를 함께 쓴다. git 은 기본으로 ASCII 밖의
 *    글자를 8진 이스케이프로 바꾸고 경로를 따옴표로 감싼다 —
 *
 *      docs/bus/방향-전환.md  →  "docs/bus/\353\260\251\355\226\245-…"
 *
 *    이 저장소는 주석·문서·커밋 메시지가 전부 한국어라 파일 이름도 한국어가 된다.
 *    따옴표가 붙으면 경로 규칙이 그 파일을 못 알아보고, 규칙이 안 걸리면 기본
 *    문턱으로 떨어진다 — **막아야 할 것이 조용히 싸지는** 방향이다.
 *    (bin/axmap.mjs 의 `cmdVerify` 가 같은 이유로 같은 옵션을 쓴다.)
 */
function changedPaths(targetRev, sourceRev) {
  const mb = git(['merge-base', targetRev, sourceRev])
  if (mb.code !== 0 || !mb.out) {
    die(
      '타깃과 소스의 갈림점(merge-base)을 찾지 못했습니다.\n'
      + '  두 브랜치가 공통 조상을 갖지 않습니다 (얕은 clone 이거나 서로 무관한 이력).\n'
      + '  CI 라면 clone 깊이를 늘리세요 (GIT_DEPTH=0).',
    )
  }
  const d = git(['-c', 'core.quotepath=false', 'diff', '--name-only', '-z', mb.out, sourceRev])
  if (d.code !== 0) die(`변경 목록을 뜨지 못했습니다.\n  ${d.err.split('\n')[0]}`)
  return { base: mb.out, paths: d.raw.split('\0').filter((s) => s !== '') }
}

/**
 * 소스에만 있는 커밋들의 author email. 자기 표 배제(G1)의 재료다.
 *
 * 못 모으면 `countVotes` 가 판정 불가로 던진다 — 자기 표를 못 거르면 셀 자격이
 * 없기 때문이다. 그래서 여기서 빈 목록을 그럴듯한 값으로 채우지 않는다.
 */
function sourceAuthors(targetRev, sourceRev) {
  const r = git(['log', '--format=%aE', `${targetRev}..${sourceRev}`])
  if (r.code !== 0) die(`소스 브랜치의 커밋 author 를 읽지 못했습니다.\n  ${r.err.split('\n')[0]}`)
  return [...new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean))]
}

/**
 * 소스 브랜치 **맨 위 커밋의 author email.** 정책이 `self_vote: "tip"` 일 때 배제할
 * 한 사람이다.
 *
 * 🔴 `targetRev..sourceRev` 범위가 아니라 `sourceRev` 자신을 본다. 그 커밋이 곧
 *    표가 묶이는 sha(G3)이고 이번에 머지될 커밋이다. 범위의 "가장 최근" 을 쓰면
 *    범위가 비었을 때(소스가 타깃보다 앞서지 않을 때) 답이 없어지는데, 배제할
 *    사람은 그때도 명확하다.
 *
 * 🔴 정책을 안 보고 **언제나** 읽는다. 여기서 `self_vote` 를 해석하면 배제 규칙이
 *    게이트와 판정 층 두 곳에 생기고, 두 곳이 어긋난 날 아무도 못 찾는다.
 *    게이트는 재료만 모으고 규칙은 `src/governance.mjs` 한 곳에 둔다.
 */
function tipAuthor(sourceRev) {
  const r = git(['log', '-1', '--format=%aE', sourceRev])
  if (r.code !== 0 || !r.out.trim()) {
    // 빈 문자열을 그럴듯하게 넘기지 않는다. `"tip"` 이면 판정 층이 판정 불가로
    // 던지고, 그 밖의 모드에서는 어차피 안 쓰인다 (fail-closed).
    return null
  }
  return r.out.trim()
}

/**
 * 승계(**투표권자가 모자랄 때 최근 기여자에게 임시 투표권을 주는 것**)용 재료.
 *
 * `deriveVoters` 가 기대하는 모양은 **커밋 하나가 항목 하나**인 `{email, name, at}`
 * 배열이다 (src/governance.mjs 의 주석). 사람 단위로 미리 묶지 않는다 — 커밋 수를
 * 세고 순서를 정하는 것은 저쪽의 일이고, 여기서 묶으면 규칙이 두 군데로 갈라진다.
 *
 * `--since` 는 **커밋 날짜** 기준이고 `deriveVoters` 는 **author 날짜**로 다시
 * 거른다. rebase(**커밋을 다른 기반 위로 옮겨 붙이는 것**) 하면 둘이 어긋나므로
 * 창을 며칠 넉넉히 잡고 진짜 판정은 저쪽에 맡긴다. 넉넉히 잡는 쪽이 안전한 이유:
 * 여기서 더 주워 와도 창 밖이면 저쪽이 버리지만, 여기서 빠뜨리면 저쪽은 그 사람이
 * **죽은 것으로** 본다.
 */
function contributorsFor(policy, targetRev, sourceRev) {
  const days = Number.isInteger(policy?.succession?.window_days) ? policy.succession.window_days : 90
  const r = git(['log', `--since=${days + 7}.days.ago`, '--format=%aE%x00%aN%x00%aI', targetRev, sourceRev])
  if (r.code !== 0) die(`최근 기여 이력을 읽지 못했습니다.\n  ${r.err.split('\n')[0]}`)
  const out = []
  for (const line of r.out.split('\n')) {
    if (!line.trim()) continue
    const [email, name, at] = line.split('\0')
    if (!email || !at) continue
    out.push({ email, name: name || null, at })
  }
  return out
}

// ---------------------------------------------------------------------------
// 재료 4 — 표
// ---------------------------------------------------------------------------

/**
 * 표를 읽어올 ref 를 정한다. 없으면 `null` — **그건 고장이 아니다.**
 * "아무도 아직 투표 안 함" 은 표 0장으로 정상 판정해야 하고, 그러면 미달(2)이 난다.
 */
function resolveVotesRef(remote, flags) {
  const given = str(flags['votes-ref'])
  if (given) {
    const r = git(['rev-parse', '--verify', '--quiet', `${given}^{commit}`])
    if (r.code !== 0 || !r.out) die(`--votes-ref 가 가리키는 것을 찾을 수 없습니다: ${given}`)
    return { rev: r.out, from: given }
  }
  // 원격이 진실이다. 장부의 `syncLedger` 가 fetch 뒤 reset --hard 로 원격을 그대로
  // 덮어쓰는 것과 같은 태도 — 표도 병합 대상이 아니다.
  if (remote && flags['no-fetch'] !== true) {
    if (git(['fetch', '--quiet', remote, VOTES_BRANCH]).code === 0) {
      const r = git(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])
      if (r.code === 0 && r.out) return { rev: r.out, from: `${remote}/${VOTES_BRANCH}` }
    }
  }
  const local = `refs/heads/${VOTES_BRANCH}`
  const tracked = remote ? `refs/remotes/${remote}/${VOTES_BRANCH}` : null
  for (const cand of [local, tracked]) {
    if (!cand) continue
    const r = git(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`])
    if (r.code === 0 && r.out) return { rev: r.out, from: cand }
  }
  return null
}

/**
 * `votes/<소스브랜치>/*.json` 을 전부 읽는다.
 *
 * 🔴 `committerEmail` 은 **파일에 적힌 값을 믿지 않고 git 에서 채운다.** 그 파일을
 *    추가한 커밋의 committer(**커밋을 실제로 기록한 git 신원**)다. 표를 쓰는 사람이
 *    적으면 대조가 아니라 자기 신고가 되고, 그러면 남의 이름으로 표를 만드는 데
 *    아무 비용이 안 든다. 못 채우면 `null` 로 두어 `committer-unknown` 으로
 *    안 세지게 한다 (fail-closed — **판단이 갈리면 안전한 쪽으로 닫는다**).
 *
 * 🔴 깨진 JSON 은 **건너뛰지 않는다.** 건너뛰면 깨진 표가 "없는 표" 가 되고,
 *    없는 표는 아무 경고도 만들지 않는다. bin/axmap.mjs 의 `readClaims` 와 같은 규칙.
 */
function readVotes(votes, branch) {
  if (!votes) return []
  const prefix = `votes/${branch}/`
  const ls = git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', '-z', votes.rev, '--', prefix])
  if (ls.code !== 0) die(`표 목록을 읽지 못했습니다 (${votes.from}).\n  ${ls.err.split('\n')[0]}`)

  const names = ls.raw
    .split('\0')
    .filter((s) => s !== '')
    // 브랜치 이름의 `/` 는 그대로 디렉터리 구분자다. 그래서 `feat/x` 를 훑으면
    // `feat/x/y` 의 표까지 딸려온다. **바로 아래 한 겹만** 본다 — 딸려온 표는
    // `wrong-branch` 로 걸리기는 하지만, 남의 브랜치 표가 이 판정문에 섞여
    // 보이는 것 자체가 오독을 만든다.
    .filter((n) => n.startsWith(prefix) && n.endsWith('.json') && !n.slice(prefix.length).includes('/'))
    .sort()

  const out = []
  for (const name of names) {
    const blob = git(['show', `${votes.rev}:${name}`])
    if (blob.code !== 0) die(`표 파일을 읽지 못했습니다: ${name}\n  ${blob.err.split('\n')[0]}`)
    let rec
    try {
      rec = JSON.parse(blob.out)
    } catch (e) {
      die(
        `표 파일의 JSON 이 깨졌습니다: ${name}\n  ${e.message}\n\n`
        + '건너뛰지 않습니다 — 깨진 표를 없는 표로 세면 아무 경고 없이 조용히 사라집니다.',
      )
    }
    // `--root` 는 부모 없는 첫 커밋에서 추가된 표까지 잡기 위한 것이다.
    // 표 브랜치는 고아 브랜치(**아무 이력에도 붙지 않은 브랜치**)라 첫 표가
    // 실제로 root 커밋에 들어간다.
    const c = git(['log', '--root', '--diff-filter=A', '--format=%cE', '-1', votes.rev, '--', name])
    const committerEmail = c.code === 0 && c.out ? c.out.split('\n')[0].trim() : null
    const base = rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : { malformed: rec }
    out.push({
      ...base,
      // 파일에 적혀 있었더라도 **덮어쓴다.** 자기 신고를 받지 않는다.
      committerEmail,
      file: name,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

const { flags } = parseArgs(process.argv.slice(2))
if (flags.help || flags.h) {
  console.log(HELP)
  process.exit(0)
}

ROOT = repoRoot()

const sourceName = str(flags.source) ?? str(process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME)
const targetName = str(flags.target) ?? str(process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME)

if (!sourceName || !targetName) {
  // 🔴 추측하지 않는다. 타깃을 잘못 집으면 **엉뚱한 브랜치의 정책**으로 판정하게
  //    되고(G2), 그건 아무 증상 없이 조용히 틀리는 종류의 실패다.
  die(
    '어느 브랜치에서 어느 브랜치로 합치는지 알 수 없습니다.\n'
    + `  --source: ${sourceName ?? '(없음)'}   --target: ${targetName ?? '(없음)'}\n\n`
    + '  손으로 :  node axmap/governance/gate.mjs --source <브랜치> --target <브랜치>\n'
    + '  CI 에서 :  CI_MERGE_REQUEST_SOURCE_BRANCH_NAME / CI_MERGE_REQUEST_TARGET_BRANCH_NAME\n'
    + '            (MR 파이프라인에서만 들어오는 값입니다)\n\n'
    + '추측하지 않는 이유: 타깃을 잘못 집으면 엉뚱한 브랜치의 정책으로 판정합니다 (G2).',
  )
}

const remote = resolveRemote(flags)
const allowFetch = flags['no-fetch'] !== true
const targetRev = resolveCommit(targetName, remote, '타깃', allowFetch)
const sourceRev = resolveCommit(sourceName, remote, '소스', allowFetch)

const policyPath = resolvePolicyPath(flags)
const policy = readPolicy(targetRev, targetName, policyPath)
const { base, paths: changed } = changedPaths(targetRev, sourceRev)
const authorEmails = sourceAuthors(targetRev, sourceRev)
const tipAuthorEmail = tipAuthor(sourceRev)
const contributors = contributorsFor(policy, targetRev, sourceRev)
const votesRef = resolveVotesRef(remote, flags)
const votes = readVotes(votesRef, sourceName)

// 재료는 stderr 로 낸다. 판정문(stdout)과 섞이지 않으면서 CI 로그에는 남는다 —
// 판정이 이상할 때 사람이 제일 먼저 보는 것이 "무엇을 보고 판정했나" 다.
console.error([
  `합의 게이트  ${sourceName} → ${targetName}`,
  `  소스 커밋 : ${sourceRev}`,
  `  갈림점    : ${base}`,
  `  정책      : ${targetName}:${policyPath}   (🔴 타깃에서 읽습니다 — G2)`,
  `  바뀐 파일 : ${changed.length}개`,
  // 자기 표 배제(G1)가 왜 그렇게 셌는지는 판정문에 안 나온다. 그런데 "던질 수
  // 있는 사람이 몇 명이었나" 가 미달의 제일 흔한 원인이라 재료에 남겨 둔다.
  `  자기 표   : self_vote=${policy?.self_vote ?? '(안 적힘 → authors)'}   author ${authorEmails.length}명 · tip ${tipAuthorEmail ?? '(못 읽음)'}`,
  `  표        : ${votesRef ? `${votes.length}장  (${votesRef.from})` : `0장  (${VOTES_BRANCH} 브랜치가 아직 없습니다)`}`,
].join('\n'))

/**
 * 🔴 여기를 try/catch 로 감싸지 않는다.
 *
 * `judge` 는 `GovernanceError` 를 이미 결과(`exit`)로 바꿔서 돌려준다. 그 밖의
 * 예외는 **우리 버그**이므로 스택 트레이스와 함께 그대로 터져야 한다. 삼키면
 * 버그가 "판정 불가" 로 위장하고, 위장한 버그는 영원히 안 고쳐진다.
 */
const verdict = judge({
  policy,
  changed,
  votes,
  authorEmails,
  tipAuthorEmail,
  sha: sourceRev,
  contributors,
  now: Date.now(),
  branch: sourceName,
  policyPath,
})

const text = formatVerdict(verdict)
if (flags.json) {
  // `axmap audit --json` 과 같은 관례: stdout 은 기계가 파싱할 수 있게 JSON 만 둔다.
  // 사람이 읽는 판정문은 stderr 로 보내 CI 로그에서는 여전히 보이게 한다.
  console.error(text)
  console.log(JSON.stringify(verdict, null, 2))
} else {
  console.log(text)
}

// 🔴 코드를 다시 고르지 않는다. 판정이 정한 것을 그대로 낸다.
process.exit(verdict.exit)
