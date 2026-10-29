#!/usr/bin/env node
/**
 * 표를 던진다 — **저장소 안의 파일 하나로.**
 *
 *   node axmap/governance/vote.mjs --branch <소스브랜치> [--sha <커밋>]
 *                                  [--vote approve|reject] [--note "..."] [--force]
 *                                  [--agent <이름>] [--agent-summary "..."]
 *
 * ── 표에는 이유가 있어야 한다 ─────────────────────────────────────────────
 *
 * 정책(`governance/policy.json`)에 `vote_note` 가 있으면 `--note` 없이는 표를
 * 쓰지 않는다. **여기서 막는 것은 친절함이고 진짜 문은 세는 쪽에 있다** —
 * `git pull` 을 안 한 사람의 옛 `vote.mjs` 는 이 규칙을 모르기 때문이다.
 * 두 곳이 같은 함수 하나(`voteNoteProblem`)를 부른다.
 *
 * 🔴 **칸마다 주인이 다르다.**
 *
 *   `note`          사람이 적는다 (`--note`)
 *   `agent.summary` AI 가 적는다 (`--agent-summary`)
 *   `agent.id`      부르는 쪽이 적는다 (`--agent`, 없으면 `"none"`)
 *   `agent.shown`   🔴 **아무도 못 적는다. 이 프로그램이 직접 잰다** —
 *                   변경량·경로·그 시점의 판정.
 *                   `committerEmail` 을 못 적게 한 것과 같은 이유다 (아래).
 *
 * GitLab 의 Approve 버튼을 쓰지 않는 이유는 [GOVERNANCE.md](GOVERNANCE.md) 와
 * docs/DECISIONS.md 의 D18 에 있다 — 판정을 GitLab API(**다른 프로그램이 GitLab 에
 * 물어보는 창구**)에 걸면, 이 저장소를 다른 곳으로 clone(**저장소를 통째로
 * 내려받는 것**)한 사람에게는 이 층이 **존재하지 않는다.** 파일이면 clone 이 곧
 * 이관이다.
 *
 * ── 자리와 모양 ──────────────────────────────────────────────────────────
 *
 *   브랜치: axmap/votes                       코드와 섞지 않는다
 *   경로  : votes/<소스브랜치>/<voter>-<sha앞8자>.json
 *
 * 브랜치 이름의 `/` 는 그대로 디렉터리 구분자로 둔다
 * (`votes/feat/S15P21E201-144-login/…`). 치환하면 서로 다른 두 브랜치가 같은
 * 디렉터리를 가리킬 수 있고, 이 저장소는 락에서 **치환이 곧 소유권 충돌**이라는
 * 이유로 그것을 금지해 왔다 (SPEC §3).
 *
 * **한 사람이 한 커밋에 정확히 파일 하나.** 중복이 파일시스템 수준에서 불가능하다.
 *
 * ── 여기서 하지 않는 것 ───────────────────────────────────────────────────
 *
 * 🔴 `committerEmail` 을 파일에 적지 않는다. 그 칸은 게이트가 git 에서 채워
 *    표에 적힌 신원과 **대조**하는 자리다. 표를 쓰는 사람이 적으면 대조가 아니라
 *    자기 신고가 되고, 그러면 남의 이름으로 표를 만드는 데 아무 비용이 안 든다.
 *
 * 🔴 판정을 하지 않는다. 자기 표인지·투표권자인지 **경고는 하지만**, 세는 것은
 *    언제나 게이트다. 여기서 미리 거르면 규칙이 두 군데로 갈라지고, 그때부터
 *    한 쪽만 고쳐지는 날이 온다.
 *
 *    🔴 그래서 **자기 표를 막을지 말지도 여기서 판단하지 않는다.** 게이트를
 *    `--json` 으로 한 번 돌려 그 판정의 `tally.g1Waived` 를 그대로 읽는다
 *    (`g1WaiverFor`). 1.2.0 에서 세는 쪽이 얻은 G1 해제를 이 파일이 몰라
 *    **세어질 표를 "안 세어집니다" 라며 막던** 버그가 바로 그 갈라짐이었다.
 *
 * ── 장부와 같은 방식 ─────────────────────────────────────────────────────
 *
 * 표 브랜치를 다루는 방법은 `bin/axmap.mjs` 의 장부(`axmap/claims`)와 같다:
 * 고아 브랜치(**아무 이력에도 붙지 않은 브랜치**)를 worktree(**같은 저장소의 다른
 * 브랜치를 별도 폴더에 펼쳐 둔 작업 공간**)로 붙여 두고, fetch → reset --hard →
 * 쓰기 → 커밋 → push 순으로 간다. push 가 거부되면 그 사이에 누가 먼저 쓴 것이므로
 * 최신을 받아 다시 한다 (CAS — **Compare-And-Swap**, "내가 읽은 뒤로 바뀐 게
 * 없을 때만 쓴다". git push 가 원래 이렇게 동작한다).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentNameError } from '../src/protocol.mjs'
import {
  EXIT, DEFAULT_POLICY_PATH, voteNoteRule, voteNoteProblem, selfVoteMode, DEFAULT_SELF_VOTE,
} from '../src/governance.mjs'

const VOTES_BRANCH = 'axmap/votes'
const VOTES_REL = path.join('.axmap', 'votes')

/** 이 파일이 놓인 자리. 옆의 gate.mjs 를 부를 때 쓴다. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 게이트를 미리 한 번 돌려 보는 데 주는 시간. 넘기면 "잴 수 없음" 으로 적는다. */
const GATE_TIMEOUT_MS = 60_000

/** push 가 거부될 때(= 누가 먼저 도착) 다시 해보는 횟수. bin/axmap.mjs 와 같은 값. */
const MAX_CAS_RETRIES = 5
/** 50 → 1600ms. bin/axmap.mjs 의 계단을 그대로 쓴다. */
const BACKOFF_MS = [50, 100, 200, 400, 800, 1600]

// ---------------------------------------------------------------------------
// git — bin/axmap.mjs 의 관례 그대로
// ---------------------------------------------------------------------------

/**
 * git 이 훅을 실행할 때 심어 놓는 환경변수들. cwd 보다 우선하므로, 남겨 두면
 * 표 worktree 를 다루는 명령이 **커밋 중인 저장소**를 가리켜 깨진다.
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
 * 로 받은 목록은 trim 하면 안 되므로 둘을 따로 돌려준다 (gate.mjs 와 같은 모양).
 */
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd ?? ROOT ?? undefined,
    input: opts.input,
    env: { ...cleanEnv(), ...(opts.env ?? {}) },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  })
  const out = r.stdout ?? ''
  return { code: r.status ?? 1, out: out.trim(), raw: out, err: (r.stderr ?? '').trim() }
}

/**
 * 남의 저장소에 물어볼 때 쓰는 환경. **자격증명을 물어보지 못하게 막는다** —
 * 안 막으면 표를 던지려던 명령이 로그인 프롬프트에서 멈춰 선다. 못 닿으면
 * 못 닿은 대로 적으면 되는 자리다 (axMap 이 죽어도 팀은 안 멈춘다).
 */
const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }

function gitOrDie(args, opts = {}) {
  const r = git(args, opts)
  if (r.code !== 0) die(`git ${args.join(' ')} 실패\n${r.err || r.out}`)
  return r
}

function die(msg, code = EXIT.UNDECIDABLE) {
  console.error(msg)
  process.exit(code)
}

/**
 * 의존성 없는 동기 sleep. `Atomics.wait` 은 아무도 깨우지 않는 SharedArrayBuffer
 * 에서 timeout 만큼 정확히 멈춘다. spawnSync 로 짜인 이 파일에 async 를 들이면
 * 호출부 전체가 물든다 (bin/axmap.mjs 와 같은 이유).
 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 백오프에 난수를 안 쓰고 **pid** 를 쓴다. 흩어놓는 목적은 pid 로도 달성되고,
 * 난수와 달리 같은 입력에서 같은 타이밍이 재현되므로 테스트가 확인할 수 있다.
 */
function backoffFor(attempt) {
  const b = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
  return b + Math.floor((b * (process.pid % 64)) / 64)
}

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

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

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

const HELP = `표를 던진다 — 저장소 안의 파일 하나로

  node axmap/governance/vote.mjs --branch <소스브랜치> [옵션]

  --branch    표를 줄 브랜치 (필수)
  --sha       그 브랜치의 어느 커밋에 주는가. 생략하면 지금 헤드
  --vote      approve | reject. 생략하면 approve
  --note      🔴 왜 찬성/반대하는가. 사람이 적는다. 정책이 vote_note 를
              켜 두었으면 이것 없이는 표가 안 써지고, 세는 쪽도 안 센다
  --agent     이 표를 도운 AI 의 이름. 안 주면 "none"
  --agent-summary  그 AI 가 요약한 한 줄. 사람의 --note 를 대신하지 않는다
  --target    자기 표(G1) 경고를 위해 비교할 브랜치. 생략하면 main.
              변경량(agent.shown)을 재는 기준이기도 하다
  --force     자기 표라는 경고를 무릅쓰고 그래도 쓴다.
              🔴 던질 수 있는 사람이 정족수보다 적어 G1 이 해제되는 판정에서는
              필요 없다 — 그때는 자기 표도 세어지므로 그냥 써 준다
              🔴 이유(--note) 요구는 --force 로 못 넘긴다
  --remote    원격 이름. 없으면 git config axmap.remote → 유일한 원격 → origin
  --policy    정책 파일의 자리 (저장소 루트 기준). 없으면 AXMAP_POLICY_PATH
              → ${DEFAULT_POLICY_PATH}. 명단 경고와 이유 요구에 쓴다
              (판정은 언제나 게이트가 한다)

  표는 ${VOTES_BRANCH} 브랜치의 votes/<브랜치>/<이름>-<sha8>.json 에 쌓인다.
  reject 는 정족수 계산에 들어가지 않는다 — 이 층은 "찬성이 몇인가" 만 센다.
  다만 판정문에는 반드시 보인다.

  표에는 던질 때 실제로 보였던 것(agent.shown)이 함께 적힌다 — 변경량·경로·
  그 시점의 판정. 🔴 이 칸은 아무도 못 적는다.
  이 프로그램이 직접 재서 채운다.
`

// ---------------------------------------------------------------------------
// 표 worktree — 장부와 같은 방식
// ---------------------------------------------------------------------------

function repoRoot() {
  const r = git(['rev-parse', '--show-toplevel'], { cwd: process.cwd() })
  if (r.code !== 0) die('git 저장소 안에서 실행해야 합니다.')
  return r.out
}

const votesDir = () => path.join(ROOT, VOTES_REL)

/** bin/axmap.mjs 의 `resolveRemote` 와 같은 순서. 못 고르면 null 이다. */
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
 * 표 worktree 를 준비한다. `bin/axmap.mjs` 의 `cmdInit` 과 같은 순서다.
 *
 * 원격에 이미 표 브랜치가 있으면 그것을 이어 쓰고, 없으면 빈 트리 → 부모 없는
 * 커밋 → 브랜치로 고아 브랜치를 만든다. 작업 트리를 건드리지 않는 방법이다.
 */
function ensureVotesWorktree(remote) {
  const dir = votesDir()
  // 폴더를 손으로 지웠어도 git 쪽에는 등록이 남아 `worktree add` 가
  // "already registered" 로 실패한다. 먼저 정리한다.
  git(['worktree', 'prune'])

  if (fs.existsSync(path.join(dir, '.git'))) return dir
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    die(`${VOTES_REL} 가 이미 있지만 정상적인 worktree 가 아닙니다.\n지운 뒤 다시 시도하세요:  rm -rf ${VOTES_REL}`)
  }

  let base = null
  if (remote && git(['fetch', '--quiet', remote, VOTES_BRANCH]).code === 0) {
    base = gitOrDie(['rev-parse', 'FETCH_HEAD']).out
  } else if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${VOTES_BRANCH}`]).code === 0) {
    base = git(['rev-parse', `refs/heads/${VOTES_BRANCH}`]).out
  } else {
    const tree = gitOrDie(['mktree'], { input: '' }).out
    base = gitOrDie(['commit-tree', tree, '-m', 'axmap: votes init']).out
    console.error(`표 브랜치를 새로 만듭니다: ${VOTES_BRANCH}`)
  }

  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${VOTES_BRANCH}`]).code !== 0) {
    gitOrDie(['branch', VOTES_BRANCH, base])
  }
  gitOrDie(['worktree', 'add', '--quiet', dir, VOTES_BRANCH])
  return dir
}

/**
 * 원격 표를 그대로 가져와 로컬을 덮어쓴다.
 *
 * `reset --hard` 인 이유는 장부와 같다 — 표는 병합 대상이 아니라 **원격이 진실**
 * 이다. 이전 시도에서 push 가 거부되어 남은 로컬 커밋도 여기서 함께 버려진다.
 */
function syncVotes(remote) {
  if (!remote) return
  const dir = votesDir()
  // fetch 는 반드시 표 worktree 안에서. FETCH_HEAD 는 worktree 별로 따로
  // 보관되므로, 본 저장소에서 fetch 하면 여기서는 그것을 볼 수 없다.
  if (git(['fetch', '--quiet', remote, VOTES_BRANCH], { cwd: dir }).code !== 0) {
    // 브랜치가 아직 없을 뿐일 수 있다. 원격 자체에 닿는지를 따로 묻는다.
    const probe = git(['ls-remote', '--exit-code', remote, 'HEAD'], { cwd: dir })
    if (probe.code === 0 || probe.code === 2) return
    die(
      '원격에 닿을 수 없어 표를 던지지 않았습니다.\n'
      + '  로컬에만 남긴 표는 CI 가 보지 못합니다 — 던졌다고 믿는 동안 아무도 안 셉니다.',
    )
  }
  const r = git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], { cwd: dir })
  if (r.code !== 0) die(`표 브랜치 동기화 실패\n${r.err || r.out}`)
}

/** 표 worktree 의 현재 HEAD. push 가 실패하면 여기로 되돌린다. */
function votesHead() {
  const r = git(['rev-parse', 'HEAD'], { cwd: votesDir() })
  return r.code === 0 ? r.out : null
}

// ---------------------------------------------------------------------------
// 경고 — 조용히 무효표를 쌓지 않는다
// ---------------------------------------------------------------------------

/**
 * 이 브랜치 커밋의 author 중에 내가 있는가 (G1 — 자기 표는 안 세진다).
 *
 * 게이트는 `<타깃>..<소스>` 로 정확히 계산하지만, 여기서는 타깃을 모른다.
 * 그래서 `--target`(기본 `main`)과의 갈림점부터 센다. 그 브랜치가 없으면
 * 최근 200 커밋으로 떨어지고, **어느 범위를 봤는지 경고에 함께 적는다** —
 * 근거를 안 적으면 사람이 경고를 믿을지 말지 판단할 수 없다.
 */
/**
 * 이번 판정의 `self_vote` 모드. **세는 쪽과 같은 함수로 읽는다.**
 *
 * 🔴 이 함수가 없어서 버그가 났다 (1.2.3 에서 고침). 세는 쪽
 *    (`src/governance.mjs` 의 `excludedAuthors`)은 `selfVoteMode(policy)` 를 읽어
 *    `"tip"` 이면 **맨 위 커밋 author 한 명만** 빼는데, 쓰는 쪽인 이 파일은 정책을
 *    아예 안 보고 **언제나 모든 author** 를 막았다. 그래서 **세어질 표를 던지기도
 *    전에 exit 으로 막았다.**
 *
 *    실측 (팀 저장소 S15P21E201, `common/dev → main`, 2026-09-12): 정책이
 *    `"tip"` 이라 던질 수 있는 사람이 5명인데, 이 함수가 없어서 2명으로 보였다.
 *    정족수가 2표라 **그 2명이 둘 다 던져야만** 통과하는 상태였다.
 *
 *    더 아픈 것은 `policy.json` 이 **정확히 그 교착을 피하려고** `"tip"` 으로
 *    바꿔 두었다는 점이다 (2026-09-09). 정책은 고쳤는데 도구가 그 정책을 안 읽어서,
 *    고친 줄 알고 지나갈 뻔했다. 바로 아래 `g1WaiverFor` 의 주석이 경고한
 *    *"같은 규칙을 두 곳에 적으면 그 어긋남이 그대로 다시 난다"* 가 한 번 더 난 것이다.
 *
 * 🔴 **fail-closed.** 못 읽거나 값이 이상하면 가장 엄한 `authors` 로 떨어진다.
 *    모를 때 풀어 주면 G1 은 성질이 아니라 스위치가 된다.
 */
function selfVoteModeSafe(policy) {
  try {
    return selfVoteMode(policy)
  } catch {
    return DEFAULT_SELF_VOTE
  }
}

function selfVoteRange(branch, targetName) {
  const t = git(['rev-parse', '--verify', '--quiet', `${targetName}^{commit}`])
  if (t.code === 0 && t.out) {
    const mb = git(['merge-base', t.out, branch])
    if (mb.code === 0 && mb.out) return { args: [`${mb.out}..${branch}`], label: `${targetName}..${branch}` }
  }
  return { args: ['-n', '200', branch], label: `${branch} 의 최근 200 커밋` }
}

/**
 * **이 판정에서 G1 이 해제되는가 — 세는 쪽에 물어본다.**
 *
 * 🔴 왜 여기서 계산하지 않는가 — **이 함수가 없어서 버그가 났다.** 1.2.0 에서
 *    세는 쪽(`src/governance.mjs` 의 `countVotes`)은 *"자기 표를 빼고 나면 던질
 *    수 있는 사람이 정족수보다 적을 때"* 그 판정 하나에 한해 G1 을 푸는 예외를
 *    얻었는데, **쓰는 쪽인 이 파일은 그 사실을 몰랐다.** 그래서 세어질 표를
 *    "안 세어집니다" 라며 막았고, 팀은 반나절을 교착이라고 믿었다
 *    (실측: 팀 저장소 S15P21E201 의 `front/dev → front/main`, 2026-09-07).
 *
 *    같은 규칙을 두 곳에 적으면 그 어긋남이 그대로 다시 난다. 그래서 여기서는
 *    조건을 세지 않고 **판정이 내놓은 표식**(`tally.g1Waived` · `eligibleCount`
 *    · `threshold`)을 그대로 읽는다. `vote_note` 를 두 곳에서 같은 함수 하나로
 *    보는 것과 같은 태도다.
 *
 * 🔴 **fail-closed.** 게이트를 못 돌렸거나 판정이 `count` 단계까지 못 갔으면
 *    `null` 을 돌려 **해제하지 않는다.** 모를 때 풀어 주면 G1 은 성질이 아니라
 *    켜고 끄는 스위치가 된다 (GOVERNANCE.md 의 "G1 의 예외 하나").
 *
 * @returns {{eligibleCount:number, threshold:number}|null} 해제될 때만 숫자들
 */
function g1WaiverFor(branch, targetName, policyFlag) {
  const v = runGate(branch, targetName, policyFlag)
  if (!v || v.stage !== 'count' || !v.tally) return null
  const { g1Waived, eligibleCount, threshold } = v.tally
  if (g1Waived !== true) return null
  // 표식이 반쪽만 온 판정은 못 읽은 것으로 친다 — 숫자를 지어내서 안내하지 않는다.
  if (!Number.isInteger(eligibleCount) || !Number.isInteger(threshold)) return null
  return { eligibleCount, threshold }
}

/**
 * **판정에 물어본다 — "이 사람이 G1 으로 빠지나?"**
 *
 * 🔴 이것이 1.2.4 의 요점이다. 1.2.3 까지는 쓰는 쪽이 같은 규칙을 **자기가
 *    계산**했고, 그 어긋남이 **두 번** 났다 — 2026-09-07 의 G1 해제(세는 쪽만
 *    알았다), 2026-09-12 의 `self_vote` 모드(쓰는 쪽이 정책을 안 읽었다).
 *    같은 규칙을 두 곳에 적으면 몇 번을 고쳐도 또 난다. **판정자는 하나여야 한다.**
 *
 * 🔴 **`null` 은 "모른다" 다 — 통과도 거부도 아니다.** 게이트를 못 돌린 경우
 *    (저장소가 아직 그럴 상태가 아니거나, 정책이 없거나, 타임아웃)에는 부르는
 *    쪽이 직접 보는 길로 떨어진다. 여기서 `false` 를 돌려 조용히 통과시키면,
 *    게이트가 잠깐 안 도는 것만으로 G1 이 꺼진다.
 *
 * 🔴 **해제와 섞지 않는다.** 이 함수가 답하는 것은 *"자기 표인가"* 하나다.
 *    *"자기 표인데 그래도 세는가"* 는 `g1WaiverFor` 가 따로 답한다. 둘을 합치면
 *    부르는 쪽이 **"자기 표가 아니다" 와 "자기 표인데 해제됐다" 를 구별 못 하고**,
 *    그러면 해제로 통과한 사람에게 왜 그냥 써 줬는지 말해 줄 수 없다.
 *
 * @returns {{self:boolean, mode:string|null}|null} 못 물어봤으면 `null`
 */
function selfVoteByGate(branch, targetName, email, policyFlag) {
  const v = runGate(branch, targetName, policyFlag)
  if (!v || v.stage !== 'count' || !v.tally) return null
  const list = v.tally.selfVoteEmails
  // 옛 게이트(1.2.3 이하)는 이 칸을 안 낸다. 없는 것을 "자기 표가 아니다" 로
  // 읽으면 판이 섞인 팀에서 G1 이 조용히 꺼진다 — 모른다고 답한다.
  if (!Array.isArray(list)) return null
  return {
    self: list.includes(String(email ?? '').trim().toLowerCase()),
    mode: typeof v.tally.selfVoteMode === 'string' ? v.tally.selfVoteMode : null,
  }
}

function warnIfSelfVote(branch, targetName, email, force, policyFlag, policy) {
  // ── 1. 먼저 판정에 물어본다 ──────────────────────────────────────────────
  const asked = selfVoteByGate(branch, targetName, email, policyFlag)
  if (asked && !asked.self) return     // 판정이 "자기 표가 아니다" 고 했다. 끝.
  if (asked && asked.self) {
    return reportSelfVote(branch, targetName, email, force, policyFlag, {
      label: `${targetName} 기준 판정`,
      mode: asked.mode,
    })
  }

  // ── 2. 못 물어봤으면 직접 본다 ───────────────────────────────────────────
  // 🔴 **세는 쪽과 같은 함수로** 정책을 읽는다. 여기서 조건을 다시 적으면 어긋난다.
  const mode = selfVoteModeSafe(policy)

  // `off` 는 G1 자체를 끈 것이다. 막을 것도 경고할 것도 없다.
  if (mode === 'off') return

  // `tip` 은 **맨 위 커밋 하나만** 본다. 오래 쌓이는 <파트>/dev 에서 옛 커밋 때문에
  // 막히지 않게 하려고 정책이 고른 값이고, 세는 쪽이 정확히 그렇게 센다.
  const range = mode === 'tip'
    ? { args: ['-n', '1', branch], label: `${branch} 의 맨 위 커밋` }
    : selfVoteRange(branch, targetName)

  const r = git(['log', '--format=%aE', ...range.args])
  if (r.code !== 0) {
    console.error(`경고: 소스 브랜치의 author 를 읽지 못해 자기 표인지 확인하지 못했습니다.\n  ${r.err.split('\n')[0]}`)
    return
  }
  const authors = new Set(r.out.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean))
  if (!authors.has(email.toLowerCase())) return

  reportSelfVote(branch, targetName, email, force, policyFlag, { label: range.label, mode })
}

/**
 * **자기 표인 것이 확인된 뒤**, 그것을 사람에게 어떻게 말하고 막을지.
 *
 * 🔴 두 길(판정에 물어본 길·직접 본 길)이 **같은 코드로 끝나야 한다.** 여기를
 *    두 벌로 두면 "판정이 답한 날" 과 "게이트를 못 돌린 날" 의 안내가 갈린다 —
 *    그 갈라짐이 이 파일에서 이미 두 번 사고를 냈다.
 *
 * @param {{label:string, mode:string}|null} seen 직접 본 길만 채운다. 판정에
 *        물어본 길에서는 `null` — 그때는 무엇을 봤는지 이 파일이 모르고,
 *        **모르는 것을 지어내 적지 않는다.**
 */
function reportSelfVote(branch, targetName, email, force, policyFlag, seen) {
  // 자기 표는 맞다. 그런데 **이 판정에서는 세어지는가?** 세는 쪽에 물어본다.
  const waiver = g1WaiverFor(branch, targetName, policyFlag)
  if (waiver) {
    console.error(
      '이 표는 자기 표지만 **이 판정에서는 세어집니다** (G1 의 예외 — 해제).\n'
      + `  ${targetName} 기준 유효 투표권자 ${waiver.eligibleCount}명 < 정족수 ${waiver.threshold} —\n`
      + '  자기 표를 빼고 나면 던질 수 있는 사람이 정족수보다 적어, 이 판정 하나에 한해 G1 이 풀립니다.\n'
      + '  --force 없이 그대로 씁니다. 판정문에는 "해제 덕분에 센 표" 로 이름까지 남습니다.\n',
    )
    return
  }

  console.error(
    `이 표는 자기 표라 세지지 않습니다 (G1 — 자기가 쓴 코드에 자기가 찬성할 수 없습니다).\n`
    + (seen
      ? `  ${email} 이(가) ${seen.label} 의 author 목록에 있습니다.\n`
        + `  배제 범위는 정책의 self_vote = "${seen.mode}" 가 정합니다.\n\n`
      : `  ${email} 을(를) ${targetName} 기준 판정이 자기 표로 셉니다.\n\n`)
    + '  그래도 남기려면 --force 를 붙이세요. 파일은 남고 판정문에는 "안 센 표" 로 보입니다.\n'
    + '  조용히 무효표를 쌓지 않는 이유: 던졌다고 믿는 사람이 아무도 안 세는 표를 기다립니다.',
  )
  if (!force) process.exit(EXIT.SHORT)
  console.error('  --force 가 있어 그래도 씁니다.\n')
}

/**
 * 정책 파일의 자리. `governance/gate.mjs` 의 `resolvePolicyPath` 와 **같은 순서**다:
 * `--policy` 플래그 → 환경변수 `AXMAP_POLICY_PATH` → `DEFAULT_POLICY_PATH`.
 * 순서가 갈리면 게이트가 보는 정책과 여기서 보는 명단이 서로 다른 파일이 된다.
 *
 * 🔴 여기서도 옛 자리로 되돌아가는 폴백은 없다. 못 읽으면 경고를 접을 뿐이다 —
 *    이 CLI 는 판정하지 않으므로 못 읽는 것이 통과로 이어지지 않는다.
 */
function resolvePolicyPath(flags) {
  const given = str(flags.policy) ?? str(process.env.AXMAP_POLICY_PATH)
  const raw = given ?? DEFAULT_POLICY_PATH
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * 명단에 없는 사람이면 알려준다. **막지는 않는다** — 승계(**투표권자가 모자랄 때
 * 최근 기여자에게 임시 투표권을 주는 것**)로 세질 수 있고, 그 판단은 게이트의
 * 몫이기 때문이다. 여기서 막으면 규칙이 두 군데로 갈라진다.
 */
function policyOf(targetName, policyPath) {
  const r = git(['show', `${targetName}:${policyPath}`])
  if (r.code !== 0) return null // 타깃을 모르거나 정책이 아직 없다.
  try {
    const policy = JSON.parse(r.out)
    return policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : null
  } catch { return null }
}

/** 정책에서 명단만. 못 읽었으면 `null`, 읽었는데 명단이 없으면 빈 배열이다. */
function rosterOf(policy) {
  if (policy === null) return null
  return Array.isArray(policy.voters) ? policy.voters : []
}

/** 명단에서 내 email 에 해당하는 줄. email 이 유일 키다 (GOVERNANCE.md). */
function rosterEntry(roster, email) {
  if (!Array.isArray(roster)) return null
  const want = email.trim().toLowerCase()
  return roster.find((v) => String(v?.email ?? '').trim().toLowerCase() === want) ?? null
}

function warnIfNotAVoter(roster, targetName, email) {
  if (roster === null) return // 경고는 부가 기능이다. 못 읽으면 조용히 넘어간다.
  if (rosterEntry(roster, email)) return
  console.error(
    `경고: ${email} 은(는) ${targetName} 의 정책 명단에 없습니다.\n`
    + '  승계가 발동한 경우에만 세집니다. 평소에는 "투표권자가 아님" 으로 안 세집니다.',
  )
}

// ---------------------------------------------------------------------------
// 던질 때 실제로 보였던 것 — `agent.shown`
//
// 🔴 **이 칸은 아무도 못 적는다. 이 프로그램이 직접 잰다.**
//    사람이나 AI 가 "3 파일 12 줄 봤다" 라고 적을 수 있으면 그건 측정이 아니라
//    자기 신고다 — 표에 `committerEmail` 을 못 적게 한 것과 **같은 이유**다
//    (파일 머리말). 자기 신고는 틀렸을 때 아무 흔적도 안 남긴다.
//
//    그래서 플래그가 없다. `--agent` 를 안 줘도 이 칸은 채워진다.
// ---------------------------------------------------------------------------

/**
 * `<타깃>...<소스>` 의 변경량. 세 점(`...`)은 **갈림점부터의 차이**다 —
 * 타깃에 새 커밋이 들어와도 이 표가 보고 있던 양이 흔들리지 않는다.
 *
 * `-z` 로 받는 이유: 이 저장소는 주석·문서가 전부 한국어라 파일 이름도 한국어가
 * 된다. `-z` 가 없으면 git 이 그런 이름에 따옴표를 씌워 돌려주고, 표에는 실제로
 * 없는 경로가 적힌다 (gate.mjs 의 `changedPaths` 가 같은 이유로 같은 옵션을 쓴다).
 *
 * 못 재면 **그럴듯한 0 으로 때우지 않고 `null`** 로 둔다. 0 은 "안 바뀌었다" 는
 * 뜻이고, 그건 못 잰 것과 완전히 다른 말이다.
 */
function measureDiff(targetName, branch) {
  const unknown = { files: null, insertions: null, deletions: null, paths: null }
  const r = git(['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', `${targetName}...${branch}`])
  if (r.code !== 0) return unknown

  const toks = r.raw.split('\0')
  let files = 0
  let insertions = 0
  let deletions = 0
  const paths = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t === '') continue
    // `<더한 줄>\t<지운 줄>\t<경로>` — 바이너리 파일은 숫자 자리가 `-` 다.
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t)
    if (!m) continue
    const [, ins, del, tail] = m
    let p = tail
    if (tail === '') {
      // 이름이 바뀐(rename) 파일. `-z` 에서는 옛 이름과 새 이름이 **다음 두
      // 토큰**으로 따로 온다. 표에는 새 이름을 적는다.
      p = toks[i + 2] ?? toks[i + 1] ?? ''
      i += 2
    }
    files += 1
    // 바이너리(`-`)는 줄 수가 없다. 0 으로 더한다 — 파일 수에는 그대로 센다.
    insertions += ins === '-' ? 0 : Number(ins)
    deletions += del === '-' ? 0 : Number(del)
    if (p !== '') paths.push(p)
  }
  return { files, insertions, deletions, paths }
}

/**
 * **세는 쪽에게 직접 물어본다.** 게이트를 `--json` 으로 한 번 돌리고 그 판정을
 * 그대로 기억한다. 못 돌렸으면 `null`.
 *
 * 🔴 **이 프로그램은 판정을 흉내내지 않는다.** "자기 표가 세어지는가" 를 여기서
 *    다시 계산하면 규칙이 두 벌이 되고, 한쪽만 고치는 날 **세는 쪽은 세는데
 *    쓰는 쪽은 막는** 어긋남이 난다. 그게 실제로 났다 (`g1WaiverFor` 주석).
 *
 * 🔴 한 번만 돌린다. 이 결과를 쓰는 자리가 둘이기 때문이다 — 자기 표를 막을지
 *    말지(`g1WaiverFor`)와 표에 적히는 `agent.shown.gate`. 두 번 돌리면 게이트가
 *    두 번 fetch 하고, 그 사이에 남이 표를 던지면 **같은 실행 안에서 두 판정이
 *    갈린다.**
 */
let gateOnce // undefined = 아직 안 돌림 · null = 못 돌림
function runGate(branch, targetName, policyFlag) {
  if (gateOnce !== undefined) return gateOnce
  const r = spawnSync(process.execPath, [
    path.join(HERE, 'gate.mjs'),
    '--source', branch,
    '--target', targetName,
    '--json',
    ...(policyFlag ? ['--policy', policyFlag] : []),
  ], {
    cwd: ROOT,
    env: { ...cleanEnv(), ...NO_PROMPT_ENV },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: GATE_TIMEOUT_MS,
  })
  gateOnce = null
  if (r.error || r.status === null) return gateOnce
  let verdict = null
  try { verdict = JSON.parse(r.stdout ?? '') } catch { return gateOnce }
  if (!verdict || typeof verdict !== 'object') return gateOnce
  gateOnce = verdict
  return gateOnce
}

/**
 * **던지기 직전의 판정** 한 줄. 위에서 받아 둔 판정을 요약할 뿐이다.
 *
 * 🔴 이 표 자신은 아직 없다. 즉 `"미달 1/2"` 는 *"내가 던지기 전에 1표였다"* 는
 *    뜻이다. 나중에 이 표가 몇 번째였는지를 이력만으로 알 수 있게 하는 값이다.
 *
 * 판정문을 다시 해석하지 않고 `--json` 의 `exit`·숫자만 쓴다. 문구를 다듬는
 * 커밋이 이 칸의 뜻을 바꾸면 안 되기 때문이다 (gate.mjs 의 관례 그대로).
 * 못 돌리면 `"잴 수 없음"` — 표는 그래도 던져진다.
 */
function measureGate(branch, targetName, policyFlag) {
  const verdict = runGate(branch, targetName, policyFlag)
  if (!verdict) return '잴 수 없음'
  if (verdict.stage === 'policy') return '정책 깨짐'
  if (verdict.stage === 'undecidable') return '판정 불가'
  if (!Number.isInteger(verdict.approvals) || !Number.isInteger(verdict.threshold)) return '잴 수 없음'
  return `${verdict.ok ? '충족' : '미달'} ${verdict.approvals}/${verdict.threshold}`
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

const branch = str(flags.branch)
if (!branch) {
  die(`어느 브랜치에 표를 주는지 말해야 합니다.\n\n${HELP}`)
}

const targetName = str(flags.target) ?? 'main'

// 대상 커밋. 생략하면 그 브랜치의 지금 헤드다. 40자 전체를 적는다 — 표는 커밋에
// 묶이므로(G3) 축약형을 적어 두면 나중에 어느 커밋이었는지가 흐려진다.
const shaFlag = str(flags.sha)
const shaRef = shaFlag ?? branch
const shaRes = git(['rev-parse', '--verify', '--quiet', `${shaRef}^{commit}`])
if (shaRes.code !== 0 || !shaRes.out) {
  die(
    `커밋을 찾을 수 없습니다: ${shaRef}\n`
    + (shaFlag ? '  --sha 값을 확인하세요.' : `  브랜치 ${branch} 가 로컬에 있는지 확인하세요 (git fetch 가 필요할 수 있습니다).`),
  )
}
const sha = shaRes.out

const voteValue = str(flags.vote) ?? 'approve'
if (voteValue !== 'approve' && voteValue !== 'reject') {
  die(`--vote 는 approve 나 reject 여야 합니다: ${voteValue}`)
}
const note = str(flags.note)

// 시각은 여기서 **한 번** 정한다. 두 군데서 쓰이기 때문이다 — 아래의 이유 요구
// (시행일 비교)와 표 파일 자신. CAS 재시도마다 바뀌면 같은 표가 매번 다른 내용이
// 되어, 무엇 때문에 다시 쓰는지가 이력에서 안 보인다.
const at = new Date().toISOString()

// AI 가 채우는 칸. 🔴 값 없이 `--agent` 만 쓰면 조용히 "none" 으로 떨어뜨리지
// 않는다 — 이름을 주려다 실패한 것과 안 준 것은 다른 일이다.
if (flags.agent === true) die('--agent 에는 이름을 붙여야 합니다. 예: --agent claude-opus-5')
if (flags['agent-summary'] === true) die('--agent-summary 에는 요약을 붙여야 합니다.')
const agentId = str(flags.agent) ?? 'none'
const agentSummary = str(flags['agent-summary'])

// 신원. 🔴 안전한 기본값을 두지 않는다 — 이름이 겹치면 두 사람의 표가 같은 파일을
// 가리키고, 나중에 던진 쪽이 앞의 표를 덮어쓴다.
let voter = git(['config', 'user.name']).out
const email = git(['config', 'user.email']).out
if (!email) {
  die(
    'git 에 email 이 설정돼 있지 않습니다. 표의 유일 키는 email 입니다.\n'
    + '  git config user.email <내-email>\n'
    + '기본값으로 채우지 않는 이유: 사람을 가리키는 것은 이름이 아니라 email 이고,\n'
    + '틀린 email 로 던진 표는 게이트가 "투표권자가 아님" 으로 버립니다.',
  )
}
if (!voter) {
  die('git 에 이름이 설정돼 있지 않습니다.\n  git config user.name <내-이름>')
}
/**
 * 🔴 `voter` 는 **명단이 정한다.** `git config user.name` 이 아니다.
 *
 * 실측(2026-08-26): 이 PC 의 `user.name` 은 `janghyojoon` 인데 정책 명단의 `id` 는
 * `rleaderjoon`(GitLab 계정 이름)이었다. email 은 같았다. 게이트는 명단에 적힌
 * 사람의 표는 **id 까지 맞아야** 세므로, 표는 정상적으로 쓰이고 판정에서만
 * `표의 이름과 email 이 명단과 어긋남` 으로 조용히 빠졌다.
 *
 * 던진 사람은 자기가 던졌다고 믿고, 게이트는 안 셌다. **락에서 최악은 조용한
 * 통과지만 투표에서 최악은 조용한 누락이다** — 아무도 왜 안 세지는지 못 푼다.
 *
 * email 이 유일 키이므로(GOVERNANCE.md) email 로 명단을 찾아 그 줄의 `id` 를 쓴다.
 * 명단에 없으면(승계로 들어올 사람) `user.name` 을 그대로 둔다 — 승계로 들어온
 * 사람은 저장소가 이름을 정해 준 적이 없어 게이트도 id 를 대조하지 않는다.
 */
const policyPath = resolvePolicyPath(flags)
const policy = policyOf(targetName, policyPath)
const roster = rosterOf(policy)
const mine = rosterEntry(roster, email)
if (mine && String(mine.id ?? '').trim() && mine.id !== voter) {
  console.error(`이름을 명단에 맞춥니다: ${voter} → ${mine.id}  (${targetName} 의 정책 기준)`)
  voter = String(mine.id).trim()
}

// 이름은 그대로 파일명이 된다. 위험한 문자를 치환해서 통과시키면 서로 다른 두
// 이름이 같은 파일을 가리킨다 — 장부가 에이전트 이름에 쓰는 검사를 그대로 쓴다.
const nameErr = agentNameError(voter)
if (nameErr) die(`${nameErr}\n  git config user.name 을 고치세요.`)

warnIfNotAVoter(roster, targetName, email)
warnIfSelfVote(branch, targetName, email, flags.force === true, str(flags.policy), policy)

// ── 이유 없는 표는 여기서 거부한다 ─────────────────────────────────────────
//
// 🔴 **이건 문이 아니라 친절함이다.** 진짜 문은 세는 쪽(`src/governance.mjs` 의
//    `countVotes`)에 있고 CI 에서 돈다. 여기서만 막으면 `git pull` 을 안 한
//    사람의 옛 `vote.mjs` 가 이 규칙을 모른 채 이유 없는 표를 그냥 쓴다.
//
//    두 곳 다 두는 이유는 다르다: 여기서 막으면 **던지기 전에** 알 수 있고,
//    세는 쪽에서만 막으면 던진 뒤 CI 가 빨개져야 안다. 같은 규칙을 두 번 적는
//    것이 아니라 **같은 함수 하나**(`voteNoteProblem`)를 두 곳에서 부른다 —
//    갈리면 던질 때는 통과하고 셀 때는 무효인 표가 생긴다.
//
// 🔴 정책을 못 읽었으면(`policy === null`) 아무것도 요구하지 않는다. 여기서
//    fail-closed 로 막아 봐야 판정이 바뀌지 않고, 정책이 아직 없는 저장소에서
//    표를 못 던지게 만들 뿐이다. 판정은 언제나 게이트가 한다.
let noteRule = null
try {
  noteRule = voteNoteRule(policy)
} catch (e) {
  die(
    `${targetName} 의 정책(${policyPath})에 적힌 \`vote_note\` 를 읽을 수 없습니다.\n  ${e.message}\n`
    + '  정책을 고치세요 — 이 상태로는 게이트도 셀 수 없습니다.',
    e.exit ?? EXIT.UNDECIDABLE,
  )
}

const noteBad = voteNoteProblem({ note, at, rule: noteRule })
if (noteBad) {
  const min = noteRule.minChars
  die(
    (noteBad.reason === 'note-missing'
      ? `이 저장소는 표에 이유를 요구합니다. --note 없이는 던질 수 없습니다.\n`
      : `이유가 너무 짧습니다 (${noteBad.detail}).\n`)
    + `  ${targetName} 의 정책: vote_note.min_chars = ${min}`
    + `${noteRule.since ? `, since = ${noteRule.since}` : ''}\n\n`
    + `  다시 이렇게 부르세요:\n`
    + `    --branch ${branch} --vote ${voteValue} `
    + `--note "무엇을 확인했고 왜 ${voteValue === 'reject' ? '반대' : '찬성'}하는가"\n\n`
    + '  🔴 --force 로는 못 넘깁니다. --force 는 자기 표(G1) 경고 전용입니다.\n'
    + '  이유 없이 쓴 표는 세는 쪽에서도 안 세집니다 — 던졌다고 믿는 동안 아무도 안 셉니다.\n'
    + (voteValue === 'reject'
      ? '  반대야말로 이유가 필요합니다. 이유 없는 반대는 무엇을 고쳐야 하는지를 안 남깁니다.'
      : '  "확인함" 네 글자는 이유가 아니라 서명입니다.'),
    EXIT.SHORT,
  )
}

const remote = resolveRemote(flags)
if (!remote) {
  console.error(
    '경고: 원격이 없어 표가 이 저장소 안에만 남습니다.\n'
    + '      CI 는 원격의 표를 보므로, 이대로면 아무도 이 표를 세지 못합니다.',
  )
}

ensureVotesWorktree(remote)

const relPath = `votes/${branch}/${voter}-${sha.slice(0, 8)}.json`

// 던질 때 실제로 보였던 것. 재는 것은 언제나 이 프로그램이다 — 플래그가 없다.
// 🔴 `--agent` 를 안 줘도 잰다. 사람이 혼자 던진 표에도 "그때 무엇이 보였나" 는
//    남아야 한다. 이 칸이 있어야 나중에 "왜 이걸 통과시켰나" 를 되물을 수 있다.
const shown = {
  ...measureDiff(targetName, branch),
  gate: measureGate(branch, targetName, str(flags.policy)),
  // 🔴 예전에는 `axmap` 칸(저장소 안 사본의 출처 커밋·뒤처진 정도)도 적었다.
  //    사본을 걷어낸 뒤(D31)로는 잴 것이 없다. 옛 표에 남은 그 칸은 판정에 안 쓰인다.
}

// 시각(`at`)은 위에서 한 번 정했다. CAS 재시도마다 바뀌면 같은 표가 매번 다른
// 내용이 되어, 무엇 때문에 다시 쓰는지가 이력에서 안 보인다.
const record = {
  voter,
  email,
  branch,
  sha,
  vote: voteValue,
  at,
  ...(note ? { note } : {}),
  agent: {
    id: agentId, // --agent 를 안 주면 "none" — 사람이 혼자 던졌다는 뜻이다
    shown, // 🔴 프로그램이 잰 것. 사람도 AI 도 못 적는다
    ...(agentSummary ? { summary: agentSummary } : {}),
  },
  // 🔴 committerEmail 은 여기 없다. 게이트가 git 에서 채운다 (파일 머리말 참고).
}

for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
  syncVotes(remote)
  const dir = votesDir()
  const before = votesHead()

  const full = path.join(dir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, `${JSON.stringify(record, null, 2)}\n`)

  const add = git(['add', '-A'], { cwd: dir })
  if (add.code !== 0) die(`git add 실패\n${add.err || add.out}`)
  if (git(['diff', '--cached', '--quiet'], { cwd: dir }).code === 0) {
    console.log(`이미 같은 표가 있습니다: ${relPath}`)
    process.exit(0)
  }
  // --no-verify: 연결된 worktree 는 훅 디렉터리를 공유하므로, 사용자가 설치한
  // pre-commit 훅이 표 커밋에도 발동한다. 표는 사용자 코드가 아니다.
  const c = git(['commit', '--quiet', '--no-verify', '-m', `vote(${voter}): ${voteValue} ${branch}@${sha.slice(0, 8)}`], { cwd: dir })
  if (c.code !== 0) die(`git commit 실패\n${c.err || c.out}`)

  if (!remote) {
    console.log(`표를 남겼습니다 (로컬 전용): ${relPath}`)
    process.exit(0)
  }

  const p = git(['push', '--quiet', remote, `HEAD:${VOTES_BRANCH}`], { cwd: dir })
  if (p.code === 0) {
    console.log(`표를 던졌습니다: ${relPath}`)
    console.log(`  ${voter} <${email}>  ${voteValue}  ${branch}@${sha.slice(0, 8)}`)
    // 잰 것을 화면에도 보여준다. 표에만 적고 안 보여주면 던진 사람은 자기 표에
    // 무엇이 적혔는지 모르고, 모르는 칸은 아무도 안 읽는다.
    console.log(
      `  본 것: ${shown.files === null ? '못 쟀음' : `${shown.files}파일 +${shown.insertions}/-${shown.deletions}`}`
      + `  ·  던지기 직전 판정: ${shown.gate}`,
    )
    if (voteValue === 'reject') {
      console.log('  reject 는 정족수 계산에 들어가지 않습니다 — 판정문에 보이기만 합니다.')
    }
    process.exit(0)
  }

  // push 가 거부됐다. 그 사이에 누가 먼저 표를 올린 것이다(CAS 실패).
  // 로컬 커밋을 되돌린다 — 남겨두면 다음 syncVotes 의 reset --hard 가 조용히
  // 지우고, 사람은 표가 어디로 갔는지 모른다.
  if (before) git(['reset', '--hard', '--quiet', before], { cwd: dir })
  console.error(`push 거부됨 (누가 먼저 표를 올림). 재시도 ${attempt}/${MAX_CAS_RETRIES}`)
  if (attempt < MAX_CAS_RETRIES) {
    const ms = backoffFor(attempt - 1)
    console.error(`  ${ms}ms 기다렸다 다시 시도합니다.`)
    sleepMs(ms)
  }
}

die(
  `표 브랜치 경합이 심해 ${MAX_CAS_RETRIES}회 재시도 후 포기했습니다.\n`
  + '  (로컬은 되돌렸습니다 — 표는 남지 않았습니다. 잠시 후 다시 시도하세요.)',
)
