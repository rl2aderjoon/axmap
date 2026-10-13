#!/usr/bin/env node
/**
 * axMap CLI - 부수효과(git, fs, 시계)를 담당하는 층.
 * 판정 로직은 전부 src/protocol.mjs 의 순수 함수에 있다.
 *
 * 두 개의 관문이 있다.
 *   관문 1 (직렬화) : git push 의 ref CAS. 공짜로 따라오며 끌 수 없다.
 *                     실패는 거절이 아니라 "최신 상태 받아서 다시 하라"는 뜻.
 *   관문 2 (판정)   : checkOverlap(). 우리가 직접 묻는다.
 *                     "요청한 경로가 남이 잡은 경로와 겹치는가?"
 */

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyClaim,
  applyRelease,
  applyRenew,
  coversPath,
  formatBlocks,
  formatOtherSessions,
  shortSession,
  humanDuration,
  normalizePath,
  activeClaims,
  claimExpiresAt,
  isSameSubject,
  myActivePaths,
  agentNameError,
  claimPathError,
} from '../src/protocol.mjs'
import { auditLedger, formatAudit, planAudit, snapshotTime } from '../src/invariants.mjs'
import {
  PACKAGE_NAME,
  fetchLatest,
  isVendored,
  checkDisabled,
  readCache,
  writeCache,
  noticeLine,
  registryUrl,
} from '../src/update.mjs'
import { stateDir } from '../src/repotarget.mjs'
import { homeRegistrations } from '../src/mcpstate.mjs'
import { compareBranchFor, formatOverlap } from '../src/overlap.mjs'

/** 이 CLI 가 들어 있는 axMap 폴더. 갱신 확인과 setup 이 자기 위치를 알아야 한다. */
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 지금 도는 axMap 의 버전. 못 읽으면 `null` — 벤더링된 사본에는 package.json 이 없다. */
function selfVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SELF_ROOT, 'package.json'), 'utf8'))?.version ?? null
  } catch {
    return null
  }
}

/**
 * 누가 잡았는지의 종류. 판정에는 쓰이지 않고 화면에서 색을 나누는 데만 쓴다.
 *   human      사람이 직접
 *   agent      대화형 AI (사람이 보고 있음)
 *   background 백그라운드 에이전트 (사람이 안 보고 있음)
 *   team       다른 팀원
 */
const ACTORS = ['human', 'agent', 'background', 'team']

/**
 * `--actor` 값을 확정한다. 없으면 환경변수, 그것도 없으면 null.
 * 값이 있는데 목록에 없으면 **거부**한다 — 오타를 조용히 삼키면
 * 화면에서 색이 안 맞는데 이유를 찾을 수 없게 된다.
 */
function resolveActor(flag) {
  const raw = typeof flag === 'string' ? flag : process.env.AXMAP_ACTOR
  if (raw === undefined || raw === null || raw === '') return null
  if (!ACTORS.includes(raw)) {
    console.error(`알 수 없는 actor: ${raw}`)
    console.error(`쓸 수 있는 값: ${ACTORS.join(', ')}`)
    process.exit(1)
  }
  return raw
}

const LEDGER_BRANCH = 'axmap/claims'
const LEDGER_REL = path.join('.axmap', 'ledger')

/**
 * 쪽지함. **장부와 같은 방식이지만 실패했을 때의 뜻이 정반대다.**
 *
 * 🔴 왜 코드 브랜치가 아니라 고아 브랜치인가.
 *
 *    쪽지는 원래 `docs/bus/` 에 있었다. 그건 작업 트리라서 상대에게 가려면
 *    커밋 -> MR -> 머지 -> 상대가 pull 을 거쳤다. `main` 이 보호돼 있으면
 *    **쪽지 한 통이 MR 한 사이클**이다. 그리고 보내려면 `docs/bus` 를 claim 해야
 *    해서, 한 사람이 잡고 있는 동안 나머지는 쪽지를 못 보냈다 — 메시징 통로가
 *    한 번에 한 명만 쓸 수 있는 자물쇠였다.
 *
 *    장부(`axmap/claims`)는 이미 그 문제를 안 겪는다. 고아 브랜치라 코드와
 *    이력을 공유하지 않고, push/fetch 로 **즉시** 오간다. 쪽지도 같은 자리로
 *    옮긴다. 표(`axmap/votes`)까지 셋이 나란히 서는 셈이다.
 *
 * 🔴 그러나 **push 실패를 장부처럼 다루면 안 된다.**
 *
 *    claim 은 push 가 실패하면 죽여야 한다. 로컬에만 남은 락은 나만 보이고
 *    남은 같은 파일을 잡으므로, 실패를 삼키는 것이 곧 fail-open 이다.
 *    쪽지는 반대다 — 안 간 쪽지는 **아직 안 간 것**일 뿐 아무 위험이 없다.
 *    여기서 죽이면 원격이 잠깐 흔들릴 때마다 사람의 작업이 멈춘다.
 *    그래서 이 아래 함수들은 경고만 하고 계속 간다.
 */
const BUS_BRANCH = 'axmap/bus'
const BUS_REL = path.join('.axmap', 'bus')

/**
 * 사람별 상태가 사는 곳 — 어디까지 읽었는지, 이 사람이 쓰는 이름이 무엇무엇인지.
 *
 * 🔴 왜 쪽지함과 다른 브랜치인가. 쪽지 **본문**은 모두가 공유하는 한 벌이고,
 *    **어디까지 읽었는지**는 사람마다 다르다. 한 브랜치에 섞으면 쪽지를 읽기만
 *    해도 공유 브랜치에 커밋이 쌓인다 — 읽는 행위가 남에게 보이는 흔적을 남기는
 *    것은 쪽지함이 할 일이 아니다.
 *
 * 🔴 그리고 왜 각자 PC 의 파일이 아닌가. 지금까지 읽음 표시는 작업 폴더 안의
 *    파일 하나였다. 그래서 **PC 를 바꾸면 전부 다시 안 읽음**이 됐다. 쪽지는
 *    공유되는데 읽었다는 사실만 그 PC 에 갇혀 있었다.
 *
 * 파일은 사람마다 하나(`users/<이메일>.json`)다. 서로 다른 파일이라 여럿이
 * 동시에 써도 부딪히지 않는다 — 쪽지가 파일 하나씩인 것과 같은 이유다.
 */
const USERS_BRANCH = 'axmap/users'
const USERS_REL = path.join('.axmap', 'users')

/**
 * 감사 체크포인트가 사는 곳 — *"장부를 뿌리부터 여기까지 재생했고 깨끗했다"* 는 기록.
 *
 * 🔴 **장부 브랜치에 넣지 않는다.** 장부(`axmap/claims`)는 선점의 진실이고,
 *    거기에 감사 결과가 섞이면 claim 한 번에 커밋이 둘 생기거나(경합이 두 배)
 *    감사가 자기가 검사하는 이력을 자기가 늘리게 된다. 검사 대상과 검사 결과는
 *    같은 자리에 두지 않는다.
 *
 * 🔴 **worktree 를 만들지 않는다.** 쪽지함·사람별 상태와 다른 점이다.
 *    이것을 쓰는 자리는 팀 CI 의 감사 잡이고, CI 는 신선한 clone 이라 `.axmap/`
 *    아래에 아무것도 없다. 읽는 것도 쓰는 것도 git 배관(hash-object · mktree ·
 *    commit-tree)으로 하면 폴더가 필요 없고, 그러면 **각자 PC 와 CI 가 같은
 *    한 길**을 쓴다. 길이 둘이면 반드시 한쪽만 고쳐진다.
 *
 * 파일은 하나(`checkpoints.json`)다. 쪽지처럼 사람마다 갈릴 것이 없고, 쓰는 일이
 * 드물어(감사가 통과할 때만) 경합이 거의 없다 — 부딪히면 다시 받아서 얹는다.
 */
const CHECKPOINT_BRANCH = 'axmap/checkpoints'
const CHECKPOINT_FILE = 'checkpoints.json'

/**
 * `release` 가 아무것도 반납하지 못했을 때. SPEC 8절.
 * 0 이 아니어야 하는 이유는 그 주변 주석에 적혀 있다.
 */
const EXIT_NOTHING_RELEASED = 5

const MAX_CAS_RETRIES = 5

// ---------------------------------------------------------------------------
// 기본 유틸
// ---------------------------------------------------------------------------

/**
 * git 이 훅을 실행할 때 심어놓는 환경변수들.
 * 이것들은 cwd 보다 우선하므로, 훅 안에서 다른 저장소(=장부 worktree)를 다루려면
 * 반드시 걷어내야 한다. 남겨두면 장부 명령이 커밋 중인 저장소를 가리켜 깨진다.
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

/**
 * 눈에 안 보이는 두 글자와 탭. git 의 `%x00` 구분자와 줄바꿈을 소스에 그대로
 * 적지 않는 이유는 편집기·패치마다 사라지거나 바뀌기 때문이다.
 */
const NUL = String.fromCharCode(0)
const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)

function cleanEnv(keep = []) {
  const e = { ...process.env }
  for (const k of GIT_ENV_KEYS) if (!keep.includes(k)) delete e[k]
  return e
}

function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    env: cleanEnv(opts.keepEnv ?? []),
    encoding: 'utf8',
    windowsHide: true,
  })
  return {
    code: r.status ?? 1,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim(),
  }
}

function gitOrDie(args, opts = {}) {
  const r = git(args, opts)
  if (r.code !== 0) die(`git ${args.join(' ')} 실패\n${r.err || r.out}`)
  return r
}

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// 장부 git 호출의 lock 재시도
//
// 🔴 여기가 없던 동안 `commitAndPush` 는 index.lock 하나에 **즉시 죽었다.**
//
//    같은 worktree 에서 다른 프로세스가 커밋 중이면 `git add -A` 가
//    "Unable to create '.../index.lock': File exists" 로 실패하고, gitOrDie 가
//    그대로 exit 1 을 냈다. MAX_CAS_RETRIES 루프는 **push 거부 전용**이라 이것을
//    전혀 덮지 않는다 — 관문 1 은 원격 ref 의 경합이고 이쪽은 로컬 파일의 경합이다.
//    앱에서 세션을 여럿 굴리면(= 이 프로젝트가 하려는 바로 그것) 매번 밟는다.
//
//    lock 실패는 거절이 아니라 "잠깐 뒤에 다시 해봐라" 다. 그래서 재시도한다.
// ---------------------------------------------------------------------------

/**
 * git 이 "지금 누가 쓰는 중" 이라고 말하는 방식들.
 * 파일 이름(index.lock)과 문장(File exists)을 함께 보는 이유는 git 버전·로케일에
 * 따라 둘 중 하나만 나오는 경우가 있기 때문이다. 넓게 잡아도 안전한 쪽인 것은,
 * 여기서 잘못 걸려봐야 **몇 번 더 기다렸다 같은 실패를 다시 내는 것**뿐이라서다.
 */
const LOCK_HINTS = ['index.lock', 'cannot lock ref', 'Unable to create', 'File exists']

/** 50 → 1600ms. 마지막까지 가면 총 3.15초 + 지터를 기다린다. */
const LOCK_BACKOFF_MS = [50, 100, 200, 400, 800, 1600]

/**
 * 마지막 lock 실패의 원문. 선언을 여기에 두는 이유는 TDZ 다 — 이 저장소는
 * `let` 이 첫 사용처보다 아래에 있어 부트스트랩이 통째로 죽은 적이 있다(CLAUDE.md).
 */
let lastLockError = ''

function isLockError(r) {
  const text = `${r.err ?? ''}\n${r.out ?? ''}`
  return LOCK_HINTS.some((h) => text.includes(h))
}

/**
 * 의존성 없는 동기 sleep. `Atomics.wait` 은 아무도 깨우지 않는 SharedArrayBuffer
 * 에서 timeout 만큼 정확히 멈춘다. spawnSync 로 짜인 이 파일에 async 를 들여오면
 * 호출부 전체가 물들므로 여기서 막는다.
 */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 몇 ms 를 기다릴까.
 *
 * 🔴 지터를 `Math.random()` 이 아니라 **pid** 로 만든다.
 *
 * 여러 프로세스를 흩어놓는 목적은 pid 로도 똑같이 달성된다 — 동시에 몰린 프로세스는
 * 서로 다른 pid 를 가지므로 서로 다른 만큼 기다린다. 반면 난수를 쓰면 같은 입력에서
 * 같은 타이밍이 재현되지 않아, 이 재시도가 실제로 도는지 테스트가 확인할 수 없다.
 * 이 저장소가 시계를 인자로 받는 것과 같은 이유다.
 */
function backoffFor(attempt) {
  const base = LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)]
  return base + Math.floor((base * (process.pid % 64)) / 64)
}

/**
 * lock 류 실패면 백오프하며 다시 건다.
 *
 * lock 이 아닌 실패는 **재시도하지 않고 그대로 돌려준다.** 원인이 다른 것을
 * 기다렸다 다시 해봐야 같은 답이 나오고, 그동안 사람은 원인을 모른 채 기다린다.
 *
 * @returns git() 의 결과 + 끝내 lock 이 안 풀렸으면 `lockExhausted: true`
 */
function gitLockRetry(args, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = git(args, opts)
    if (r.code === 0 || !isLockError(r)) return r
    if (attempt >= LOCK_BACKOFF_MS.length) return { ...r, lockExhausted: true }
    // 조용히 기다리지 않는다. 몇 초 멈춘 이유를 사람이 알아야 한다.
    console.error(
      `장부가 잠겨 있습니다 (다른 에이전트가 쓰는 중). ` +
        `${backoffFor(attempt)}ms 뒤 재시도 ${attempt + 1}/${LOCK_BACKOFF_MS.length}`,
    )
    sleepMs(backoffFor(attempt))
  }
}

/**
 * CAS(관문 1) 재시도 사이의 대기.
 *
 * lock 재시도와 **같은 계단·같은 지터**를 쓴다. 둘은 층이 다르지만(로컬 파일 락 vs
 * 원격 ref 경합) 대응은 같다 — 흩어져서 다시 해보는 것. 계단을 둘로 나누면
 * 어느 쪽이 얼마나 기다렸는지 사람이 계산해야 한다.
 *
 * 마지막 회차 뒤에는 기다리지 않는다. 어차피 포기할 것을 기다리게 하면
 * 사람이 이유 없이 1.6초를 더 본다.
 *
 * @param {number} attempt 1부터 세는 회차 (호출부의 for 루프 변수 그대로)
 */
function casBackoff(attempt) {
  if (attempt >= MAX_CAS_RETRIES) return
  const ms = backoffFor(attempt - 1)
  console.error(`  ${ms}ms 기다렸다 다시 시도합니다.`)
  sleepMs(ms)
}

/** lock 으로 끝내 실패했을 때 사람에게 보일 이유. 원인을 뭉개지 않는다. */
function lockReason(r) {
  return (r.err || r.out || '').trim().split('\n')[0]
}

function lockedMessage(what) {
  return (
    `다른 에이전트가 장부를 쓰는 중이라 ${LOCK_BACKOFF_MS.length + 1}회 재시도 후 포기했습니다 (${what}).\n` +
    `  ${lastLockError}\n\n` +
    '같은 worktree 에서 여러 프로세스가 동시에 장부를 커밋하면 git 인덱스 락에서 경합합니다.\n' +
    '위 메시지의 락 파일이 죽은 프로세스의 잔해라면 직접 지운 뒤 다시 시도하세요.\n' +
    '(경로를 여기에 적어두지 않는 이유: worktree 이름이 바뀌면 그 줄이 먼저 낡는다.\n' +
    ' 진짜 경로는 git 이 낸 위 한 줄에 들어 있다.)'
  )
}

/** 시계. AXMAP_NOW 로 덮어쓸 수 있다 - 데모에서 TTL 만료를 30분 기다리지 않기 위해. */
function now() {
  const override = process.env.AXMAP_NOW
  if (override) {
    const t = Date.parse(override)
    if (Number.isNaN(t)) die(`AXMAP_NOW 를 해석할 수 없습니다: ${override}`)
    return t
  }
  return Date.now()
}

function parseTtl(v) {
  if (v == null) return 30 * 60_000
  const m = String(v).match(/^(\d+)\s*([smh])?$/)
  if (!m) die(`--ttl 형식이 올바르지 않습니다: ${v} (예: 30m, 2h, 90s)`)
  const n = Number(m[1])
  return n * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? 'm']
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      flags[a.slice(2)] = argv[++i]
    } else {
      flags[a.slice(2)] = true
    }
  }
  return { positional, flags }
}

/**
 * 값을 받지 않는 깃발을 안전하게 읽는다.
 *
 * 🔴 `parseArgs` 는 `--x 뒤낱말` 을 값으로 삼킨다. 그래서
 *    `axmap claim --takeover src/foo` 는 `takeover='src/foo'` 가 되고
 *    **경로 하나가 positional 에서 통째로 사라진다.** 잡은 줄 알았는데 안 잡힌
 *    상태로 커밋하러 가는 것이라, 조용히 참으로 읽지 않고 거부한다.
 */
function boolFlag(v, name) {
  if (v === undefined) return false
  if (v === true) return true
  const s = String(v).toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  die(
    `--${name} 는 값을 받지 않는데 뒤에 온 "${v}" 를 값으로 삼켰습니다.\n` +
      `  그대로 두면 "${v}" 가 인자 목록에서 사라집니다.\n` +
      `  --${name} 를 맨 뒤에 두거나 --${name}=true 로 쓰세요.`,
  )
}

// ---------------------------------------------------------------------------
// 레포 / 장부 위치
// ---------------------------------------------------------------------------

/**
 * 안 읽은 쪽지를 알린다 (docs/bus).
 *
 * 🔴 쪽지를 **따로 기억해야 하는 것으로 두지 않는다.**
 *
 * 쪽지함을 MCP 도구로 내놓아도 "언제 열어볼지" 는 아무도 안 정해준다.
 * 도구가 있다고 쓰는 게 아니다 — 실제로 상대 세션이 내 쪽지를 읽은 것은
 * 커밋 메시지와 브리핑으로 "이걸 봐라" 라고 했기 때문이었다.
 *
 * 그래서 **반드시 부르는 도구에 얹는다.** claim 은 규칙상 코드를 건드리기 전에
 * 무조건 부른다. 거기서 알려주면 아무도 잊을 수 없다.
 * (화면이 숫자 옆에 문장을 붙여 오독을 막은 것과 같은 원리다.)
 *
 * 읽음 표시는 에이전트별 파일에 남긴다. 장부에 넣지 않는 이유는 —
 * 읽었는지는 **나만의 상태**라 남과 합의할 필요가 없고, 장부에 쓰면
 * 쪽지를 읽을 때마다 push 경합이 생긴다.
 */
/**
 * 쪽지함을 원격과 맞춘다. **조용히 실패한다.**
 *
 * 장부의 `syncLedger` 는 같은 자리에서 `die` 한다 — 못 맞춘 장부로 claim 하면
 * 나만 아는 락이 되기 때문이다. 쪽지에는 그 위험이 없다. 원격이 잠깐 안 되면
 * 이번엔 새 쪽지를 못 보는 것뿐이고, 다음 호출에 따라온다.
 */
function syncBus(root) {
  const dir = busDir(root)
  if (!fs.existsSync(path.join(dir, '.git'))) return
  const r = resolveRemote(root)
  const remote = r.source === 'ambiguous' ? null : r.name
  if (!remote) return
  // fetch 는 반드시 그 worktree 안에서. FETCH_HEAD 가 worktree 마다 따로다.
  if (git(['fetch', '--quiet', remote, BUS_BRANCH], { cwd: dir }).code !== 0) return
  gitLockRetry(['reset', '--hard', '--quiet', 'FETCH_HEAD'], { cwd: dir })
}

/** 쪽지를 찾는 곳. 새것은 고아 브랜치, 옛것은 `docs/bus`(읽기 전용). */
function busSearchDirs(root) {
  return [busMessagesDir(root), legacyBusDir(root)]
}

function unreadNotes(root, me) {
  if (!me) return []
  syncBus(root)
  // 두 곳을 합쳐서 본다. id 가 시각으로 시작하므로 섞여도 순서가 맞고,
  // "읽음" 표시(`id <= seen`)도 그대로 성립한다.
  const found = []
  for (const box of busSearchDirs(root)) {
    let ns = []
    try { ns = fs.readdirSync(box).filter((f) => f.endsWith('.md')) } catch { continue }
    for (const f of ns) found.push({ box, f })
  }
  if (!found.length) return []
  let seen = ''
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.axmap-bus-seen.json'), 'utf8'))
    seen = raw[me] ?? ''
  } catch { /* 처음이면 아무것도 안 읽은 것 */ }

  const out = []
  for (const { box, f } of found.sort((a, b) => (a.f < b.f ? -1 : 1))) {
    const id = f.slice(0, -3)
    if (id <= seen) continue
    let head = ''
    try { head = fs.readFileSync(path.join(box, f), 'utf8').slice(0, 400) } catch { continue }
    const g = (k) => {
      const m = head.match(new RegExp('^' + k + ':\\s*(.*)$', 'm'))
      return m ? m[1].trim() : ''
    }
    const from = g('from')
    const to = g('to')
    // 내가 보낸 것은 뺀다 — 자기 쪽지에 자기가 놀라면 안 된다.
    if (from === me) continue
    if (to !== me && to !== 'all') continue
    out.push({ id, from, subject: g('subject') })
  }
  return out
}

/**
 * 읽음 표시를 찍는다. 규격은 `docs/SPEC.md` §2「읽음 표시」.
 *
 * 🔴 **읽기만 하고 쓰지 않던 자리였다.** `unreadNotes` 가 `.axmap-bus-seen.json`
 *    을 보는데 아무도 안 써서 `seen` 이 늘 빈 문자열이었고, 그래서 `id <= seen`
 *    이 아무것도 못 걸렀다 — **모든 쪽지가 영원히 안 읽음**이었다. 알림이 매번
 *    전부를 찍으니 사람은 그것을 배경으로 여기고 안 읽는다. 반쪽짜리 알림은
 *    없는 알림보다 나쁘다. 2026-08-27 에 훅을 붙이려다 드러났다.
 *
 * 🔴 **보여준 것까지만 찍는다.** `printUnread` 는 3건만 출력하므로 3건까지만
 *    읽음이 된다. 세지만 하고 안 보여준 쪽지를 읽음으로 치면 그 쪽지는
 *    영영 안 뜬다.
 *
 * ⚠️ 조용히 실패한다. 못 찍으면 다음에 한 번 더 뜰 뿐이고, 여기서 죽으면
 *    claim 이 죽는다. `tools/bus.mjs` 의 `markSeen` 과 같은 규칙이다.
 */
function markBusSeen(root, me, id) {
  if (!me || !id) return
  const file = path.join(root, '.axmap-bus-seen.json')
  try {
    let all = {}
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 처음이다 */ }
    if ((all[me] ?? '') >= id) return          // 뒤로 가지 않는다
    all[me] = id
    fs.writeFileSync(file, JSON.stringify(all, null, 2) + '\n')
  } catch { /* 조용히 */ }
}

/**
 * 쪽지를 읽는 명령. **경로를 문자열로 적지 않고 계산한다.**
 *
 * 🔴 `node tools/bus.mjs …` 라고 적혀 있었다. 이 저장소에서는 맞고 **사본에서는
 *    틀린다** — 팀 저장소에 벤더링되면 그 파일은 `ci/axmap/tools/bus.mjs` 다.
 *    안내대로 치면 `MODULE_NOT_FOUND` 가 난다. 알림이 "쪽지가 있다" 고 말한 직후에
 *    읽는 방법을 틀리게 알려주는 것이라, 받은 사람은 도구가 고장 났다고 결론짓는다.
 */
function busReadHint(me) {
  const abs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'bus.mjs')
  const rel = path.relative(process.cwd(), abs).replace(/\\/g, '/')
  // 🔴 상대경로가 늘 짧은 것은 아니다. 도구가 대상 저장소 **밖**에 있으면
  //    (전역 설치, 다른 드라이브) `../../../../../..` 가 줄줄이 붙어 사람이 읽을
  //    수 없는 문자열이 된다. 실제로 그렇게 나왔다. 둘 중 짧은 쪽을 쓴다 —
  //    안내는 맞기만 해서는 부족하고 **칠 수 있어야** 한다.
  const use = rel.startsWith('..' + path.posix.sep + '..') || rel.length >= abs.length
    ? abs.replace(/\\/g, '/')
    : (rel.startsWith('.') ? rel : './' + rel)
  return `node ${use} list --to ${me}`
}

/**
 * 겹칠지도 모르는 작업을 찾아서 claim 끝에 붙인다. 없으면 아무것도 안 찍는다.
 *
 * 판정과 문장은 `src/overlap.mjs` 에 있다. 여기는 git 을 부르는 부분만 있다.
 *
 * ── 🔴 명령을 경로마다 띄우지 않는다 ────────────────────────────────────────
 *
 * 처음 만들 때는 원격 브랜치를 하나씩 돌며 `git` 을 100번 띄웠다. **4,475ms** 가
 * 나왔고 "느리니까 최근 2주만 보자" 는 **틀린 결론**까지 냈다. `--all --not` 으로
 * **한 번에** 물으면 같은 답이 **89ms** 다 — 50배. 느린 것은 검사가 아니라
 * 프로세스를 띄우는 일이었다. (기간으로 자르는 것은 쓸모도 없었다 — 원격 브랜치
 * 100개 중 91개가 최근 2주 안에 움직였다.)
 *
 * ── 못 재면 어떻게 하나 ────────────────────────────────────────────────────
 *
 * 🔴 **조용히 넘어간다.** 이 저장소는 관문에서는 "못 재면 막는다" 를 지키지만
 *    (`mrtarget.mjs` 가 이름을 못 받으면 거부하는 것처럼), 이것은 **관문이 아니라
 *    조언**이다. 견줄 브랜치가 없는 저장소도 있고, 그건 고장이 아니라 정상이다.
 *    조언이 못 떴다고 선점을 막으면 도구가 쓸모없어진다.
 */
function printOverlap(root, paths) {
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).out

    // 🔴 사다리(`<파트>/dev`)가 없는 저장소는 견줄 곳을 **직접 적어 둔다.**
    //    `git config axmap.comparebranch team-sync`. 없으면 빈 문자열이 되고,
    //    그러면 판정 쪽이 지금까지처럼 파트 칸만 본다. 왜 새 브랜치를 만드는
    //    대신 설정값으로 했는지는 `src/overlap.mjs` 의 주석에 있다.
    const cfg = git(['config', '--get', 'axmap.comparebranch'], { cwd: root })
    const rel = compareBranchFor(branch, cfg.code === 0 ? cfg.out : null)
    if (!rel) return

    // 원격 것을 먼저 본다. 남이 올린 것을 보려는 검사라 로컬 사본은 늘 낡아 있다.
    let cmp = `origin/${rel}`
    if (git(['rev-parse', '--verify', '--quiet', cmp], { cwd: root }).code !== 0) {
      cmp = rel
      if (git(['rev-parse', '--verify', '--quiet', cmp], { cwd: root }).code !== 0) return
    }

    const FMT = '%h%x09%an%x09%s'
    const sep = ['--'].concat(paths)

    // [2] 낡은 바탕 — 저쪽엔 이미 있는데 내 바탕엔 없는 것. 경로로 자른다.
    // `--no-merges` — 머지 커밋은 "누가 무엇을 했나" 를 안 알려 준다. 실제로
    // 재 보니 [2] 에 머지 한 줄이 끼어 세 칸 중 하나를 잡아먹고 있었다.
    const staleR = git(
      ['log', '-3', '--no-merges', `--format=${FMT}`, `HEAD..${cmp}`].concat(sep),
      { cwd: root },
    )
    const stale = staleR.code !== 0 ? [] : splitLog(staleR.out, 3)

    // [1] 보이지 않는 창 — 어느 브랜치엔 있는데 저쪽에도 내 쪽에도 아직 없는 것.
    //     장부 브랜치는 코드 트리를 안 건드리지만, 훑는 대상에서 아예 빼 둔다.
    const unmergedR = git(
      [
        'log', '-5', '--no-merges', '--source', `--format=%h%x09%S%x09%an%x09%s`,
        '--exclude=refs/heads/axmap/*', '--exclude=refs/remotes/*/axmap/*',
        '--all', '--not', cmp, 'HEAD',
      ].concat(sep),
      { cwd: root },
    )
    const unmerged =
      unmergedR.code !== 0
        ? []
        : unmergedR.out
            .split('\n')
            .filter(Boolean)
            .slice(0, 5)
            .map((l) => {
              const [hash, ref, who, ...rest] = l.split('\t')
              return { hash, ref: String(ref).replace(/^refs\/(remotes|heads)\//, ''), who, subject: rest.join('\t') }
            })

    const msg = formatOverlap({ compareBranch: cmp, stale, unmerged })
    if (msg) console.log(msg)
  } catch {
    // 조언이 claim 을 죽이면 안 된다 — printUnread 와 같은 이유다.
  }
}

/** `%h\t%an\t%s` 줄들을 레코드로. */
function splitLog(out, limit) {
  return String(out)
    .split('\n')
    .filter(Boolean)
    .slice(0, limit)
    .map((l) => {
      const [hash, who, ...rest] = l.split('\t')
      return { hash, who, subject: rest.join('\t') }
    })
}

/** claim·status 끝에 붙이는 알림. 없으면 아무것도 안 찍는다. */
function printUnread(root, me) {
  let notes = []
  try { notes = unreadNotes(root, me) } catch { return }   // 알림 때문에 claim 이 죽으면 안 된다
  if (!notes.length) return
  const shown = notes.slice(0, 3)
  console.log('\n  안 읽은 쪽지 ' + notes.length + '건')
  for (const n of shown) console.log('     ' + n.from + ' — ' + n.subject)
  if (notes.length > 3) console.log('     … 그 밖에 ' + (notes.length - 3) + '건')
  console.log('     읽기: ' + busReadHint(me) + '   (AI 도구를 쓰면 ax_inbox)')
  // 보여준 뒤에 찍는다. 위에서 죽으면 안 찍혀야 다음에 다시 뜬다.
  markBusSeen(root, me, shown.reduce((hi, n) => (n.id > hi ? n.id : hi), ''))
}

function repoRoot() {
  const r = git(['rev-parse', '--show-toplevel'])
  if (r.code !== 0) die('git 저장소 안에서 실행해야 합니다.')
  return r.out
}

/**
 * `.axmap/` 가 실제로 있는 곳 — **메인 체크아웃**.
 *
 * 🔴 링크된 worktree 에서 커밋이 통째로 막히던 자리다 (2026-08-28 실측).
 *
 *    `git worktree add` 로 만든 worktree(= 같은 저장소의 다른 브랜치를 옆 폴더로
 *    펼쳐 둔 것)에서 `git commit` 을 하면 `pre-commit` 훅이 돈다. 훅 디렉터리는
 *    저장소에 하나뿐이라(공통 디렉터리 아래) worktree 마다 따로 설치할 것도 없이
 *    그대로 실행된다. 그런데 `repoRoot()` 는 **그 worktree** 를 가리키고
 *    `.axmap/ledger` 는 **메인 체크아웃에만** 있으므로 `requireLedger` 가
 *    "장부가 없습니다" 로 종료 코드 1 을 냈다 — 선점과 아무 상관 없는 커밋까지.
 *
 *    사람이 쓴 우회는 그 worktree 안에 장부 worktree 를 하나 더 만드는 것이었다.
 *    돌아가긴 하지만 장부 worktree 가 worktree 수만큼 늘고, 그중 하나가 뒤처지면
 *    **같은 저장소에 장부가 여럿**이 된다. 락 시스템에서 진실이 둘이면 락이 아니다.
 *
 * ── 왜 `--git-common-dir` 인가 ────────────────────────────────────────────
 *
 * git 은 worktree 마다 다른 것(HEAD·인덱스·FETCH_HEAD)과 저장소에 하나뿐인 것
 * (오브젝트·refs·훅)을 나눠 둔다. 후자가 있는 곳이 **공통 디렉터리**다.
 *
 *   메인 체크아웃에서   git rev-parse --git-common-dir  →  .git         (상대)
 *   링크된 worktree 에서 git rev-parse --git-common-dir  →  <메인>/.git  (절대)
 *
 * 그 부모가 메인 체크아웃이다. 이 파일은 이미 훅 설치(`cmdHookInstall`)에서
 * 같은 명령을 쓰고 있었다 — 훅은 공통이라는 사실을 알면서 장부는 몰랐던 것이다.
 *
 * 🔴 **"못 찾음" 과 "없음" 을 뭉개지 않는다.** 여기서 하는 일은 *어디를 볼지*를
 *    바로잡는 것뿐이다. 바로잡은 자리에 장부가 없으면 `requireLedger` 는 지금처럼
 *    거부한다. 뭉개면 `init` 을 안 돌린 저장소에서 장부 없이 커밋이 통과한다.
 *
 * 판정이 안 서면 `root` 를 그대로 돌려준다(= 지금까지의 동작). 공통 디렉터리가
 * `.git` 이라는 이름이 아닌 배치 — bare 저장소의 worktree 나 `--git-dir` 을 손으로
 * 준 경우 — 에서 부모를 짚으면 저장소 **바깥**을 가리키게 되기 때문이다.
 */
const axmapHomeCache = new Map()

function axmapHome(root) {
  if (axmapHomeCache.has(root)) return axmapHomeCache.get(root)
  const home = computeAxmapHome(root)
  axmapHomeCache.set(root, home)
  return home
}

function computeAxmapHome(root) {
  /**
   * 🔴 빠른 길이 있어야 한다. 이 함수는 거의 모든 명령이 부르는데, git 을 한 번 더
   *    띄우는 것은 윈도우에서 수십 ms 다. `test/ledgerlock.test.mjs` 처럼 400ms
   *    창 안에서 재시도가 도는지를 보는 검사가 있어, 여기서 늘린 시간이 그대로
   *    **엉뚱한 곳의 실패**로 나타난다.
   *
   *    판별은 파일 하나로 끝난다. 메인 체크아웃의 `.git` 은 **디렉터리**이고
   *    링크된 worktree 의 `.git` 은 `gitdir: …` 한 줄이 든 **파일**이다.
   *    디렉터리면 여기가 곧 메인 체크아웃이므로 git 에게 물을 것이 없다 —
   *    지금까지의 동작과 한 글자도 다르지 않다.
   */
  try {
    if (fs.statSync(path.join(root, '.git')).isDirectory()) return root
  } catch {
    /* .git 이 없거나 못 읽으면 아래에서 git 에게 물어본다 */
  }
  const r = git(['rev-parse', '--git-common-dir'], { cwd: root })
  if (r.code !== 0 || !r.out) return root
  const common = path.resolve(root, r.out)
  const parent = path.dirname(common)
  if (path.basename(common) !== '.git' || !fs.existsSync(parent)) return root
  return parent
}

function ledgerDir(root) {
  return path.join(axmapHome(root), LEDGER_REL)
}

function claimsDir(root) {
  return path.join(ledgerDir(root), 'claims')
}

/**
 * 쪽지함은 **일부러 `root` 그대로 둔다.**
 *
 * 장부와 같은 `.axmap/` 아래라 같은 문제가 있지만(링크된 worktree 에는 없다),
 * 고치려면 `tools/bus.mjs` 의 `SEEN_FILE`·쪽지함 경로까지 같이 옮겨야 한다.
 * 한쪽만 옮기면 **읽는 곳과 쓰는 곳이 갈려** 읽음 표시가 어긋난다 —
 * 쪽지가 안 보이는 것보다 나쁘다. 장부와 달리 여기서는 못 찾아도 죽지 않고
 * "새 쪽지 없음" 으로 조용히 지나가므로, 링크된 worktree 에서 쪽지가 안 보이는
 * 것은 남는 구멍으로 적어 둔다.
 */
function busDir(root) {
  return path.join(root, BUS_REL)
}

/** 쪽지 파일이 실제로 쌓이는 곳. 브랜치 루트에 흩뿌리지 않고 한 폴더 아래 모은다. */
function busMessagesDir(root) {
  return path.join(busDir(root), 'messages')
}

function usersDir(root) {
  return path.join(root, USERS_REL)
}

/** 사람마다의 파일이 쌓이는 곳. `.gitattributes` 와 섞이지 않게 한 폴더 아래 모은다. */
function usersFilesDir(root) {
  return path.join(usersDir(root), 'users')
}

/**
 * 옛 쪽지함. **읽기만 한다.**
 *
 * 새로 보내는 것은 전부 고아 브랜치로 가지만, 이미 `docs/bus/` 에 쌓여 있는
 * 쪽지를 안 보이게 만들면 그건 데이터를 잃는 것이다. 옮기지도 않는다 —
 * 옮기면 같은 내용이 두 브랜치에 남고, 어느 쪽이 진짜인지 아무도 모른다.
 * 쓰는 곳은 하나, 읽는 곳은 둘. 그러면 옛것은 자연히 마른다.
 */
function legacyBusDir(root) {
  return path.join(root, 'docs', 'bus')
}

/**
 * 장부를 주고받을 원격의 **이름**.
 *
 * 🔴 예전에는 이 자리에 `hasRemote()` 가 있었고 `'origin'` 문자열을 직접 봤다.
 *    나머지 다섯 곳(fetch·push·ls-remote·init)이 그 판정을 믿고 `origin` 을 썼으므로,
 *    원격 이름이 `origin` 이 아니면 여섯 곳이 함께 거짓말했다.
 *
 *    증상이 무서운 쪽이다. `hasRemote` 가 false 가 되면 `syncLedger` 는 즉시
 *    return 하고 `pushLedger` 는 push 없이 'ok' 를 낸다. 그러면 **관문 1(CAS)이
 *    통째로 사라지고 관문 2만 남는데, 관문 2는 자기 장부에 대고 판정하므로
 *    영원히 자기 자신하고만 비교한다.** 여섯 명이 같은 파일을 잡아도 전부 성공한다.
 *    종료 코드는 0이고 경고는 init 때 한 줄뿐이었다 — 이 저장소가 금지한 fail-open 이다.
 *
 *    실제로 밟는 경우가 셋이다.
 *      - fork 워크플로 (origin=내 포크, upstream=본체)
 *      - `git remote rename origin gitlab` 같은 개인 취향
 *      - **원격이 둘 이상** — 팀 저장소를 `team` 으로 추가하고 origin 을 개인
 *        저장소로 두면 장부가 개인 저장소로 간다. 이건 경고조차 안 뜬다.
 *
 * 정하는 순서. 위에서부터 먼저 맞는 것을 쓴다.
 *
 *   1. `--remote <이름>`        그 명령에서만
 *   2. `AXMAP_REMOTE`           셸 단위
 *   3. `git config axmap.remote` 저장소에 박힌 값 — `init` 이 여기에 적어 둔다
 *   4. 원격이 **정확히 하나**면 그것. 이름이 무엇이든 상관없다
 *   5. `origin` 이 있으면 `origin` — 옛 동작과의 호환
 *   6. 그 밖 → `ambiguous`. **고르지 않는다**
 *
 * 6에서 하나를 골라 주지 않는 이유는 SPEC §3 의 원칙 그대로다 —
 * 치환은 서로 다른 두 입력을 같은 것으로 만들고, 락에서 그것은 곧 소유권 충돌이다.
 * 잘못 고르면 장부가 엉뚱한 저장소로 가고 **아무도 그것을 모른다.**
 *
 * @returns {{name: string|null, source: string, all: string[]}}
 *          `name` 이 null 이면 `source` 가 'none'(원격 없음) 또는 'ambiguous'(못 고름).
 */
function resolveRemote(root, flags = {}) {
  const all = git(['remote'], { cwd: root }).out.split('\n').map((s) => s.trim()).filter(Boolean)

  const pick = (name, source) => {
    // 지정된 이름이 실제로 없으면 조용히 넘어가지 않는다. 오타가 곧 무보호 상태다.
    if (!all.includes(name)) {
      die(
        `${source} 이(가) 가리키는 원격이 없습니다: ${name}\n` +
          (all.length ? `  이 저장소의 원격: ${all.join(', ')}` : '  이 저장소에는 원격이 없습니다.'),
      )
    }
    return { name, source, all }
  }

  if (typeof flags.remote === 'string') return pick(flags.remote, '--remote')
  if (process.env.AXMAP_REMOTE) return pick(process.env.AXMAP_REMOTE, 'AXMAP_REMOTE')

  const cfg = git(['config', '--get', 'axmap.remote'], { cwd: root }).out.trim()
  if (cfg) return pick(cfg, 'git config axmap.remote')

  if (all.length === 0) return { name: null, source: 'none', all }
  if (all.length === 1) return { name: all[0], source: '유일한 원격', all }
  if (all.includes('origin')) return { name: 'origin', source: '기본값(origin)', all }
  return { name: null, source: 'ambiguous', all }
}

/**
 * 원격 없이 도는 것을 **매번** 알린다.
 *
 * 🔴 예전에는 `init` 때 한 줄이 전부였다. 그 뒤 수백 번의 claim 이 전부 조용히
 *    성공하므로, 사람은 보호받고 있다고 믿는다. 락 시스템에서 가장 나쁜 실패는
 *    거부해야 할 것을 조용히 통과시키는 것이고, 여기서는 "혼자임"이 그것이다.
 *
 * 거부까지 가지 않고 경고에서 멈추는 이유는 혼자 쓰는 사람이 실제로 있기 때문이다.
 * 대신 **조용하지는 않게** 한다. stdout 이 아니라 stderr 로 낸다 — 파이프로
 * 흘려보내도 사람 눈에는 남는다.
 */
/**
 * 한 프로세스에서 한 번만 낸다. claim 은 CAS 재시도로 syncLedger 를 최대 5번 부르는데,
 * 같은 경고를 다섯 줄 쌓으면 사람이 그 다음부터 안 읽는다.
 *
 * 선언을 함수 위에 둔다 — 이 저장소는 `let` 이 첫 사용처보다 아래에 있어 TDZ 로
 * 부트스트랩이 통째로 죽은 적이 있다(CLAUDE.md).
 */
let soloWarned = false

function warnSolo(r) {
  if (r.name || soloWarned) return
  soloWarned = true
  if (r.source === 'ambiguous') {
    console.error(
      `경고: 원격이 여럿이라 장부를 어디에 둘지 정하지 못했습니다 (${r.all.join(', ')}).\n` +
        '      관문 1(CAS)이 작동하지 않습니다 — 다른 사람의 claim 을 보지 못합니다.\n' +
        '      정하려면:  git config axmap.remote <이름>',
    )
    return
  }
  console.error(
    '경고: 원격이 없어 단일 작업자 모드로 돕니다. 관문 1(CAS)이 작동하지 않습니다\n' +
      '      — 다른 사람의 claim 을 보지 못하고, 내 claim 도 아무에게도 가지 않습니다.',
  )
}

/**
 * 이름이 **어디서 왔는지**. 진단에 쓴다.
 *
 * 🔴 조용히 다른 사람이 되는 것이 이 도구에서 가장 위험한 사고다.
 *    `AXMAP_AGENT` 는 셸이 바뀌면 사라지고, 그러면 `git config user.name`
 *    으로 떨어져 **그럴듯한 다른 사람**이 된다. 아무 오류도 안 난다.
 */
let agentFrom = null

/**
 * 이름을 정하는 순서. **기본값은 없다.**
 *
 * 🔴 안전한 기본 이름을 두지 않는 이유. 예전 `.mcp.json` 은 이름이 없으면
 *    모두에게 `claude` 를 줬다. 그러면 팀원 다섯이 clone 했을 때 장부에는
 *    **한 명만** 존재하고, `checkOverlap` 은 자기 claim 을 겹침으로 보지 않으므로
 *    서로의 영역을 아무 경고 없이 덮어쓴다. 이 저장소가 fail-closed 로 막겠다고
 *    선언한 바로 그 실패다 — 치환이 곧 소유권 충돌이다.
 *
 * 옛 이름을 받아주던 한시적 분기는 걷어냈다. 이름을 바꾸기 전부터 돌고 있던 셸을
 * 위한 것이었고, 그런 셸은 이제 없다. 호환을 오래 두면 그것이 규격이 된다.
 */
/**
 * 이름을 정한다. **못 정해도 죽지 않는다** — 못 정한 이유를 돌려준다.
 *
 * 🔴 `agentName` 과 순서를 **공유해야** 한다. 두 곳에 적으면 한쪽이 먼저 낡고,
 *    그러면 claim 이 쓰는 이름과 다른 곳이 보는 이름이 갈린다. 갈린 이름은
 *    "자기가 잡은 것을 자기가 반납 못 하는" 사고가 되므로, 판정은 여기 하나뿐이다.
 *
 * @returns {{name: string|null, reason: string|null}}
 */
function resolveAgentName(flags) {
  let n = null
  if (flags.agent) {
    n = flags.agent
    agentFrom = '--agent'
  } else if (process.env.AXMAP_AGENT) {
    n = process.env.AXMAP_AGENT
    agentFrom = 'AXMAP_AGENT'
  } else {
    n = git(['config', 'user.name']).out
    agentFrom = 'git config user.name'
  }
  if (!n) {
    return {
      name: null,
      reason:
        '에이전트 이름을 알 수 없습니다. --agent 또는 AXMAP_AGENT 를 설정하세요.\n' +
        '기본 이름으로 대신 채우지 않습니다 — 여러 사람이 같은 이름이 되면\n' +
        '서로의 claim 을 겹침으로 보지 못해 같은 파일을 조용히 함께 고칩니다.',
    }
  }
  const err = agentNameError(String(n))
  if (err) return { name: null, reason: err }
  return { name: String(n), reason: null }
}

/** 이름이 반드시 필요한 자리. 못 정하면 **여기서 멈춘다.** */
function agentName(flags) {
  const r = resolveAgentName(flags)
  if (!r.name) die(r.reason)
  return r.name
}

/**
 * 세션 id 가 **어디서 왔는지**. 이름의 `agentFrom` 과 같은 이유로 남긴다 —
 * 막혔을 때 "왜 남이라고 하는가" 의 답이 대부분 여기 있다.
 */
let sessionFrom = null

/**
 * 이 실행은 **어느 세션의 것인가**. 이름과 달리 **없어도 죽지 않는다.**
 *
 * 🔴 이름은 없으면 die 인데 세션은 왜 아닌가.
 *
 *    이름이 없으면 장부에 아무것도 못 적는다 — 레코드의 키가 이름이다.
 *    세션은 키가 아니라 **키 안의 구별**이다. 없으면 지금까지처럼 돌고,
 *    다만 같은 이름의 두 주체를 구별하지 못할 뿐이다. 없다고 멈춰 세우면
 *    세션 개념이 없던 모든 셸에서 axMap 이 통째로 안 돈다.
 *
 * 순서. 이름(`resolveAgentName`)과 같은 모양으로 맞춘다 — 모양이 다르면
 * 한쪽만 기억하게 되고, 그때부터 둘 중 하나는 반드시 틀린다.
 *
 *   1. `--session <값>`          그 명령에서만
 *   2. `AXMAP_SESSION`           도구가 심어준다 (MCP 서버가 여기에 적는다)
 *   3. `CLAUDE_CODE_SESSION_ID`  Claude Code 가 세션마다 다르게 준다
 *   4. 없으면 null → "확인할 수 없음". 막지 않되 조용히 넘어가지도 않는다
 *
 * 🔴 **없다고 프로세스마다 다른 값을 지어내지 않는다.** pid 나 난수를 채우면
 *    `axmap` 을 부를 때마다 다른 세션이 되고, 자기가 잡은 것을 자기가 못 늘리고
 *    못 반납한다. 모를 때는 모른다고 말하는 것이 유일하게 안전한 값이다.
 */
function resolveSessionId(flags) {
  const pick = (v, src) => {
    sessionFrom = src
    return String(v)
  }
  if (typeof flags?.session === 'string' && flags.session) return pick(flags.session, '--session')
  if (process.env.AXMAP_SESSION) return pick(process.env.AXMAP_SESSION, 'AXMAP_SESSION')
  if (process.env.CLAUDE_CODE_SESSION_ID) return pick(process.env.CLAUDE_CODE_SESSION_ID, 'CLAUDE_CODE_SESSION_ID')
  sessionFrom = null
  return null
}

/**
 * 물러난 깃발 `--takeover` 를 만났을 때.
 *
 * 🔴 **그냥 무시하면 안 된다.** `parseArgs` 는 모르는 깃발을 조용히 흘려보내는데,
 *    `--takeover ci` 처럼 쓰면 뒤 낱말을 값으로 삼켜 **경로 하나가 통째로 사라진다.**
 *    그래서 여기서 `boolFlag` 로 한 번 걸러 그 사고부터 막는다.
 *
 * 이 깃발은 "같은 이름의 다른 세션에게서 레코드를 넘겨받는다" 는 뜻이었다.
 * 이제 세션마다 레코드가 따로라 넘겨받을 것이 없다. release 에서만 뜻이 남아
 * `--all-sessions` 로 이름이 바뀌었다.
 *
 * @returns {boolean} release 에서 `--all-sessions` 로 이어줄지
 */
function warnRetiredTakeover(flags, command) {
  if (!boolFlag(flags.takeover, 'takeover')) return false
  if (command === 'release') {
    console.error('알림: --takeover 는 --all-sessions 로 이름이 바뀌었습니다. 이번에는 그것으로 처리합니다.')
    return true
  }
  console.error(
    '알림: --takeover 는 이제 필요 없습니다 — 세션마다 레코드가 따로 적히므로 넘겨받을 것이 없습니다.\n' +
      '      claim 은 그대로 진행합니다.',
  )
  return false
}

/**
 * 장부 worktree 의 존재만 확인한다.
 *
 * claims 디렉터리의 존재로 판정하면 안 된다. git 은 빈 디렉터리를 추적하지 않으므로
 * 모두가 반납해 claim 파일이 하나도 없으면 reset --hard 가 그 디렉터리를 지운다.
 * 그러면 "정상적으로 다 반납한 상태"가 "장부가 없음"으로 오진된다.
 */
function requireLedger(root) {
  if (fs.existsSync(path.join(ledgerDir(root), '.git'))) return
  const home = axmapHome(root)
  let msg = `장부가 없습니다. 먼저 실행하세요:\n  axmap init`
  // 링크된 worktree 에서 실행 중이면 어디를 보고 없다고 하는지 밝힌다.
  // 안 밝히면 "여기 .axmap 이 없는데?" 로 읽혀 장부를 또 만들게 된다 (그러면 진실이 둘이다).
  if (path.resolve(home) !== path.resolve(root)) {
    msg += `\n\n찾아본 곳: ${path.join(home, LEDGER_REL)}`
    msg += `\n(여기는 링크된 worktree 라 장부는 메인 체크아웃에 하나만 둡니다.`
    msg += `\n 이 폴더 안에 장부를 또 만들지 마세요 — 같은 저장소에 장부가 둘이 되면 락이 아닙니다.)`
  }
  die(msg)
}

/** 지금 실행 위치가 장부 worktree 자신인가. */
function isLedgerWorktree(root) {
  return normalizePath(root).endsWith('/.axmap/ledger')
}

// ---------------------------------------------------------------------------
// 관문 1 - 원격과 동기화 / CAS push
// ---------------------------------------------------------------------------

/**
 * 원격 장부를 그대로 가져와 로컬 장부를 덮어쓴다.
 * reset --hard 인 이유: 장부는 병합 대상이 아니라 항상 원격이 진실이다.
 * 이전 시도에서 push 가 거부되어 남은 로컬 커밋도 여기서 같이 버려진다.
 */
/**
 * 원격에 닿을 수 있나.
 *
 * 🔴 fetch 실패를 "장부 브랜치가 아직 없음" 과 구분해야 한다.
 *
 * 예전에는 fetch 가 실패하면 조용히 통과시켰다. 그러면 **원격이 끊긴 상태에서도
 * claim 이 로컬 장부에만 기록되고**, 같은 시각 원격이 멀쩡한 다른 에이전트가
 * 같은 경로를 잡는다. 두 에이전트가 각자 "내가 쥐고 있다"고 믿는다 —
 * 락 시스템에서 가장 나쁜 실패 방향이고, 이 저장소가 내건 fail-closed 원칙과
 * 정면으로 어긋난다.
 *
 * `ls-remote` 로 원격 자체에 닿는지를 먼저 묻는다. 닿으면 브랜치가 없을 뿐이고,
 * 못 닿으면 그건 장애다.
 */
function remoteReachable(root, remote, cwd = ledgerDir(root)) {
  const r = git(['ls-remote', '--exit-code', remote, 'HEAD'], { cwd })
  // --exit-code 는 참조가 없을 때 2 를 준다. 그것도 "닿았다"는 뜻이다.
  return r.code === 0 || r.code === 2
}

function syncLedger(root) {
  const r0 = resolveRemote(root)
  const remote = r0.name
  // 🔴 조용히 넘어가지 않는다. 원격이 없으면 이 뒤의 모든 claim 이 성공하는데,
  //    그 성공은 "겹치지 않는다" 가 아니라 "남을 볼 수 없다" 는 뜻이다.
  if (!remote) { warnSolo(r0); return }
  // fetch 를 반드시 장부 worktree 안에서 실행해야 한다.
  // FETCH_HEAD 는 worktree 별로 따로 보관되므로, 메인 worktree 에서 fetch 하면
  // 장부 worktree 에서는 그 FETCH_HEAD 를 볼 수 없다.
  const dir = ledgerDir(root)
  const f = git(['fetch', '--quiet', remote, LEDGER_BRANCH], { cwd: dir })
  if (f.code === 0) {
    // reset 도 인덱스 락을 잡는다. add·commit 과 같은 경합에 같은 방식으로 대응한다.
    const r = gitLockRetry(['reset', '--hard', '--quiet', 'FETCH_HEAD'], { cwd: dir })
    if (r.lockExhausted) {
      lastLockError = lockReason(r)
      die(lockedMessage('장부 동기화'))
    }
    if (r.code !== 0) die(`git reset --hard FETCH_HEAD 실패\n${r.err || r.out}`)
    return
  }
  // fetch 가 실패했다. 원격에 닿기는 하는가?
  if (remoteReachable(root, remote)) return // 장부 브랜치가 아직 없다 - 첫 push 때 생긴다
  die(
    '원격 장부에 닿을 수 없습니다. 관문 1(직렬화)이 작동하지 않는 상태입니다.\n' +
      `  ${(f.err ?? '').trim().split('\n')[0]}\n\n` +
      '이 상태로 claim 하면 나만 아는 락이 됩니다 — 다른 에이전트는 그것을 볼 수 없고,\n' +
      '같은 경로를 동시에 잡게 됩니다. 연결을 고친 뒤 다시 시도하세요.',
  )
}

/**
 * 장부를 커밋하고 push 한다.
 *
 * @returns {'ok'|'rejected'|'nothing'|'unreachable'|'locked'}
 *   rejected 가 곧 CAS 실패 = 누가 먼저 도착함
 *   locked 는 로컬 인덱스 락 경합이 끝내 안 풀린 것. **여기서 죽지 않고 돌려준다** —
 *   부르는 쪽이 로컬 장부를 되돌려야 하기 때문이다. 되돌리지 않으면 커밋되지도
 *   push 되지도 않은 claim 파일이 worktree 에 남고, 그 저장소만 "내가 쥐고 있다"
 *   고 말한다. 그것이 이 파일이 rollbackLedger 로 막아온 fail-open 이다.
 */
function commitAndPush(root, message) {
  const dir = ledgerDir(root)
  const add = gitLockRetry(['add', '-A'], { cwd: dir })
  if (add.lockExhausted) {
    lastLockError = lockReason(add)
    return 'locked'
  }
  if (add.code !== 0) die(`git add -A 실패\n${add.err || add.out}`)
  if (git(['diff', '--cached', '--quiet'], { cwd: dir }).code === 0) return 'nothing'
  // --no-verify 가 반드시 필요하다.
  // 연결된 worktree 는 훅 디렉터리를 공유하므로(.git/hooks 는 git-common-dir 아래에 하나뿐),
  // 사용자가 pre-commit 훅을 설치하면 장부 커밋에도 그 훅이 발동한다.
  // 장부는 사용자 코드가 아니라 내부 기록이므로 사용자 훅의 대상이 아니다.
  const c = gitLockRetry(['commit', '--quiet', '--no-verify', '-m', message], { cwd: dir })
  if (c.lockExhausted) {
    lastLockError = lockReason(c)
    return 'locked'
  }
  if (c.code !== 0) die(`git commit 실패\n${c.err || c.out}`)
  const remote = resolveRemote(root).name
  if (!remote) return 'ok'
  const p = git(['push', '--quiet', remote, `HEAD:${LEDGER_BRANCH}`], { cwd: dir })
  if (p.code === 0) return 'ok'
  // 🔴 push 실패의 원인을 뭉개지 않는다.
  //
  // 예전에는 전부 'rejected'(= 남이 먼저 도착함) 로 만들었다. 그래서 원격 장애·
  // 인증 실패가 "누가 먼저 갱신했습니다. 잠시 후 다시 시도하세요" 로 표시됐고,
  // 그 조언은 절대 통하지 않는다. 원인을 알 수 없게 만드는 것이
  // fail-open 버그를 오래 숨긴 직접 원인이었다.
  if (!remoteReachable(root, remote)) {
    lastPushError = (p.err ?? '').trim()
    return 'unreachable'
  }
  return 'rejected'
}

/** 마지막 push 실패의 원문. 사람이 원인을 볼 수 있어야 한다. */
let lastPushError = ''

/**
 * 로컬 장부를 push 이전 상태로 되돌린다.
 *
 * 🔴 이것이 없으면 프로토콜이 fail-open 한다.
 *
 * push 가 끝내 실패했는데 로컬 장부에 claim 이 남아 있으면, 그 저장소의
 * `status` 는 "내가 쥐고 있다" 고 말하고 pre-commit 훅도 통과시킨다.
 * 정작 다른 에이전트는 그 claim 을 볼 수 없으므로 같은 경로를 잡는다.
 * **claim 은 원격 장부에 도달했을 때만 성립한다.**
 */
function rollbackLedger(root, before) {
  if (!before) return
  const dir = ledgerDir(root)
  git(['reset', '--hard', '--quiet', before], { cwd: dir })
}

/** 장부 worktree 의 현재 HEAD. 실패하면 null (아직 커밋이 없는 첫 상태) */
function ledgerHead(root) {
  const r = git(['rev-parse', 'HEAD'], { cwd: ledgerDir(root) })
  return r.code === 0 ? r.out.trim() : null
}

// ---------------------------------------------------------------------------
// 장부 읽기 / 쓰기
// ---------------------------------------------------------------------------

/**
 * 장부 전체를 읽는다.
 *
 * 읽을 수 없는 레코드가 하나라도 있으면 전체를 중단한다 (fail-closed).
 * 건너뛰면 그 에이전트가 아무것도 잡고 있지 않은 것처럼 보이고,
 * 남의 락 위에 내 claim 이 발급된다. 락 시스템에서 가장 나쁜 실패 방향이다.
 */
function readClaims(root) {
  const dir = claimsDir(root)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f)
      let rec
      try {
        rec = JSON.parse(fs.readFileSync(full, 'utf8'))
      } catch (e) {
        die(
          `장부 레코드를 읽을 수 없습니다: claims/${f}\n${e.message}\n\n` +
            '겹침을 판정할 수 없으므로 중단합니다. 손상된 레코드를 고치거나 지운 뒤 다시 시도하세요.',
        )
      }
      if (!rec?.agent || !Array.isArray(rec.paths) || !rec.since || !Number.isFinite(rec.ttlMs)) {
        die(`장부 레코드의 필수 필드가 없습니다: claims/${f}\n필요: agent, paths, since, ttlMs`)
      }
      return rec
    })
}

/**
 * 레코드 하나가 앉을 파일.
 *
 * 에이전트 이름은 agentNameError() 로 이미 검증되었으므로 그대로 파일명이 된다.
 * 여기서 문자를 치환하면 서로 다른 이름이 같은 파일을 가리킬 수 있다.
 *
 * 🔴 **세션마다 다른 파일이다.** 한 파일에 이름 하나면 두 번째 창이 적는 순간
 *    첫 창의 줄이 사라진다 — 그것이 이 판의 결함이었다 (protocol.mjs `isSameSubject`).
 *
 * 세션 id 는 **그대로 파일명에 못 쓴다.** 값이 환경변수에서 오므로 슬래시든
 * 무엇이든 들어올 수 있고, 이름 검증을 거치지 않는다. 그래서 짧게 해싱한다 —
 * 파일명은 자리를 가르기만 하면 되고, 진짜 값은 파일 **안**에 그대로 들어 있다.
 * 세션을 모르는 레코드는 예전과 같은 `<이름>.json` 이라 옛 장부와 그대로 맞물린다.
 */
function claimPath(root, agent, session = null) {
  if (!session) return path.join(claimsDir(root), `${agent}.json`)
  const h = crypto.createHash('sha256').update(String(session)).digest('hex').slice(0, 8)
  return path.join(claimsDir(root), `${agent}@${h}.json`)
}

/**
 * 같은 (이름, 세션) 짝의 레코드 파일을 **전부** 지운다. `keep` 만 남긴다.
 *
 * 🔴 파일명을 계산해서 지우는 것만으로는 부족하다. 세션 표식이 있는 레코드가
 *    옛 이름(`<이름>.json`)에 들어 있는 장부가 이미 돌아다니기 때문이다.
 *    그것을 안 지우면 같은 임자의 줄이 둘로 보이고, 지운 줄 알았던 것이 남는다.
 *    그래서 **파일 안을 열어보고** 임자가 같으면 지운다.
 */
function removeClaimFiles(root, agent, session, keep = null) {
  const dir = claimsDir(root)
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const full = path.join(dir, f)
    if (keep && path.resolve(full) === path.resolve(keep)) continue
    let rec
    try {
      rec = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch {
      continue // 깨진 파일은 readClaims 가 fail-closed 로 잡는다. 여기서 지우면 증거가 사라진다.
    }
    if (isSameSubject(rec, agent, session ?? null)) fs.rmSync(full, { force: true })
  }
}

/**
 * 파일 하나를 원자적으로 쓴다 — 임시 파일에 다 쓴 뒤 같은 디렉터리에서 rename 한다.
 *
 * 🔴 관문 1 이 CAS 인 이상 원자성은 선택이 아니다.
 *
 * `fs.writeFileSync` 는 호출 하나로 보이지만 커널이 여러 번에 나눠 쓸 수 있다.
 * 그 사이에 다른 에이전트의 `git add -A` 가 장부 worktree 를 통째로 스테이징하면
 * **반쯤 쓰인 레코드가 그대로 커밋된다.** readClaims 는 파싱 실패를 건너뛰지 않고
 * 전체를 중단하므로(fail-closed), 그 순간 팀 전원의 장부가 함께 멈춘다.
 * 창은 좁지만 터지면 범위가 전부다.
 *
 * 같은 디렉터리 안의 rename 은 같은 파일시스템이라 원자적이다. 보는 쪽은 옛 파일이나
 * 새 파일만 보고, 반쯤 쓰인 상태는 존재할 수 없다.
 *
 * 임시 이름이 `.json` 으로 끝나지 않는 것도 의도다. rename 직전에 누가 임시 파일을
 * 집어가도 readClaims 의 `.json` 필터가 걸러낸다 — 최악이 "깨진 레코드"가 아니라
 * "무해한 쓰레기 파일"이 된다. 못 막을 때는 실패의 크기라도 낮춘다.
 */
function writeFileAtomic(target, data) {
  const tmp = `${target}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, target)
  } catch (e) {
    // 정리하다 난 오류가 원래 원인을 가리지 않게 한다.
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 무시 */
    }
    throw e
  }
}

/**
 * 장부 worktree 가 임시 파일을 절대 커밋하지 않게 한다.
 *
 * writeFileAtomic 의 창은 좁지만 0 은 아니고, 프로세스가 강제 종료되면 임시 파일이
 * 그대로 남는다. `git add -A` 는 그것까지 스테이징하므로 쓰레기가 장부에 실려
 * 모든 클론으로 복제된다. .gitignore 한 줄이면 두 경우가 같이 사라진다.
 *
 * 옛 장부에는 이 파일이 없으므로 claim 할 때마다 존재를 확인한다. 한 번 만들어지면
 * 다음 장부 커밋에 실려 다른 클론에도 따라간다.
 */
function ensureLedgerIgnore(root) {
  const gi = path.join(ledgerDir(root), '.gitignore')
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*.tmp-*\n')
}

function writeClaim(root, claim) {
  fs.mkdirSync(claimsDir(root), { recursive: true })
  ensureLedgerIgnore(root)
  const target = claimPath(root, claim.agent, claim.session)
  // 같은 임자의 줄이 옛 이름으로 남아 있으면 지운다. 안 그러면 장부에 같은 줄이 둘이다.
  removeClaimFiles(root, claim.agent, claim.session ?? null, target)
  writeFileAtomic(target, JSON.stringify(claim, null, 2) + '\n')
}

/**
 * 커밋되기 **전에** 실패했을 때 내 레코드 파일을 원래대로 돌린다.
 *
 * 🔴 `git reset --hard` 로는 이 경우를 못 돌린다. 처음 claim 하는 에이전트의
 *    레코드는 아직 한 번도 add 된 적이 없어 **추적되지 않는 파일**이고, reset 은
 *    추적되지 않는 파일을 건드리지 않는다. 그대로 두면 커밋도 push 도 되지 않은
 *    claim 이 worktree 에 남아 그 저장소만 "내가 쥐고 있다" 고 말한다 —
 *    rollbackLedger 가 막으려던 fail-open 이 그 옆문으로 그대로 들어온다.
 *
 *    `git clean` 을 쓰지 않는 이유: 같은 worktree 에서 동시에 일하는 다른
 *    프로세스가 방금 쓴 레코드까지 지운다. 내 파일 하나만 정확히 되돌린다.
 */
function restoreClaimFile(file, prev) {
  if (prev === null) fs.rmSync(file, { force: true })
  else fs.writeFileSync(file, prev)
}

// ---------------------------------------------------------------------------
// 명령: init
// ---------------------------------------------------------------------------

/**
 * 쪽지함 worktree 를 준비한다. **이미 있으면 아무 일도 안 한다** (여러 번 불러도 안전).
 *
 * 🔴 여기서는 절대 `die` 하지 않는다. 장부와 정반대다.
 *    장부가 준비 안 되면 claim 이 나만 아는 락이 되므로 멈추는 것이 맞지만,
 *    쪽지함이 없다고 사람의 작업을 막을 이유는 없다. 못 만들었으면 그렇게 말하고
 *    나머지는 그대로 돈다.
 *
 * @returns {'ready'|'created'|'failed'}
 */
/**
 * 고아 브랜치(**코드 이력과 아무 조상도 공유하지 않는 별도 계보**) 하나를 만들고
 * 그것을 옆 폴더에 펼친다. 쪽지함과 사람별 상태가 **같은 코드**로 만들어진다.
 *
 * 🔴 이 함수가 있는 이유는 사본을 안 만들기 위해서다. 쪽지함 것을 복사해서
 *    사람 것을 만들면 두 벌이 되고, 두 벌은 반드시 어긋난다 — 이 저장소가 팀
 *    사본을 걷어낸 것과 같은 이유이고, 실제로 그 어긋남으로 쪽지가 묻혔다.
 *
 * @param what  실패 메시지에 쓸 사람 말 ("쪽지함" · "사람별 상태")
 * @param seed  worktree 를 만든 직후 그 안을 채우는 함수. 브랜치마다 다른 유일한 곳
 */
function ensureOrphan(root, { branch, rel, dir, what, seed }) {
  const fail = (r) => {
    console.error(`경고: ${what}을(를) 준비하지 못했습니다 - ${(r.err || r.out || '').split('\n')[0]}`)
    return 'failed'
  }
  if (fs.existsSync(path.join(dir, '.git'))) return 'ready'
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    console.error(`경고: ${rel} 가 있지만 ${what} worktree 가 아닙니다.\n  지운 뒤 다시 실행하세요:  rm -rf ${rel}`)
    return 'failed'
  }

  // 원격을 못 고르겠으면 **고르지 않는다.** 장부가 같은 자리에서 멈추는 것과 같은
  // 이유다 — 엉뚱한 저장소로 간 쪽지는 push 가 성공하고 아무도 못 읽는다.
  const r = resolveRemote(root)
  const remote = r.source === 'ambiguous' ? null : r.name

  let base = null
  if (remote && git(['fetch', '--quiet', remote, branch], { cwd: root }).code === 0) {
    base = git(['rev-parse', 'FETCH_HEAD'], { cwd: root }).out
  } else {
    // 빈 트리 -> 부모 없는 커밋 -> 브랜치. 작업 트리를 건드리지 않는 고아 브랜치.
    const tree = git(['mktree'], { cwd: root, input: '' })
    if (tree.code !== 0) return fail(tree)
    const c = git(['commit-tree', tree.out, '-m', `axmap: ${branch} init`], { cwd: root })
    if (c.code !== 0) return fail(c)
    base = c.out
  }

  if (git(['rev-parse', '--verify', '--quiet', branch], { cwd: root }).code !== 0) {
    const b = git(['branch', branch, base], { cwd: root })
    if (b.code !== 0) return fail(b)
  }
  const w = git(['worktree', 'add', '--quiet', dir, branch], { cwd: root })
  if (w.code !== 0) return fail(w)

  seed(dir)

  // 🔴 고아 브랜치는 **자기 트리의 `.gitattributes` 만** 본다. 저장소 루트에
  //    있는 것은 여기 안 닿으므로, 심어 두지 않으면 Windows(`core.autocrlf=true`)
  //    에서 파일이 CRLF 로 체크아웃된다. 2026-08-26 에 실제로 그랬고, 머리말
  //    파서가 `\r` 에 걸려 **쪽지가 목록에서 조용히 사라졌다.**
  //    파서도 함께 고쳤지만(`tools/bus.mjs`) 바이트가 플랫폼마다 달라지는 것
  //    자체를 막는 편이 낫다 — 해시도, diff 도, 파서도 전부 같은 것을 본다.
  fs.writeFileSync(
    path.join(dir, '.gitattributes'),
    '# 이 브랜치의 파일은 어느 OS 에서 만들어도 같은 바이트여야 한다.\n' +
      '# 저장소 루트의 .gitattributes 는 고아 브랜치에 닿지 않으므로 여기 따로 둔다.\n' +
      '* text=auto eol=lf\n',
  )

  if (remote) {
    git(['add', '-A'], { cwd: dir })
    // --no-verify: 연결된 worktree 는 훅을 공유한다. 이 브랜치는 사용자 코드가 아니다.
    git(['commit', '--quiet', '--no-verify', '-m', `axmap: ${branch} init`], { cwd: dir })
    const p = git(['push', '--quiet', remote, `HEAD:${branch}`], { cwd: dir })
    if (p.code !== 0) console.error(`경고: ${what} push 실패 - ${(p.err ?? '').split('\n')[0]}`)
  }
  return 'created'
}

function ensureBus(root) {
  return ensureOrphan(root, {
    branch: BUS_BRANCH, rel: BUS_REL, dir: busDir(root), what: '쪽지함',
    seed: () => {
      // git 은 빈 디렉터리를 추적하지 않는다. 쪽지가 0개인 동안에도 폴더가 살아 있게 한다.
      fs.mkdirSync(busMessagesDir(root), { recursive: true })
      fs.writeFileSync(path.join(busMessagesDir(root), '.gitkeep'), '')
    },
  })
}

function ensureUsers(root) {
  return ensureOrphan(root, {
    branch: USERS_BRANCH, rel: USERS_REL, dir: usersDir(root), what: '사람별 상태',
    seed: () => {
      fs.mkdirSync(usersFilesDir(root), { recursive: true })
      fs.writeFileSync(path.join(usersFilesDir(root), '.gitkeep'), '')
    },
  })
}

/**
 * 쪽지함만 준비한다. **장부는 건드리지 않는다.**
 *
 * 🔴 왜 `init` 을 부르지 않고 이 명령이 따로 있는가. 쪽지를 **읽는** 길에서
 *    부를 자리가 필요해서다. `init` 은 장부(`axmap/claims`)까지 만들고 그것을
 *    원격에 push 한다 — "내 쪽지 좀 보자" 가 남의 저장소에 **선점 장부**를
 *    만드는 일이 되면 안 된다. 쪽지 브랜치는 쪽지함이 원래 사는 곳이므로
 *    거기까지는 간다. 선을 긋는 자리는 "읽으려는 그것" 과 "그 밖의 것" 사이다.
 *
 *    그래서 `tools/bus.mjs` 는 쪽지함이 없을 때 이 명령을 부른다. 만드는 코드를
 *    저쪽에 복사하지 않는 이유는 사본이 곧 두 벌이고, 두 벌은 반드시 어긋나기
 *    때문이다 — 이 저장소가 팀 사본을 걷어낸 것과 같은 이유다.
 */
function cmdBusRepair() {
  const root = repoRoot()
  // .axmap 을 손으로 지웠어도 git 쪽에 worktree 등록이 남아 add 가 실패한다.
  git(['worktree', 'prune'], { cwd: root })
  const r = ensureBus(root)
  if (r === 'failed') process.exit(1)
  console.log(
    r === 'ready'
      ? `쪽지함이 이미 있습니다: ${BUS_REL}`
      : `쪽지함을 만들었습니다: ${BUS_REL}  (${BUS_BRANCH})`,
  )
}

/** 사람별 상태만 준비한다. `bus-repair` 와 같은 이유로 따로 있다. */
function cmdUsersRepair() {
  const root = repoRoot()
  git(['worktree', 'prune'], { cwd: root })
  const r = ensureUsers(root)
  if (r === 'failed') process.exit(1)
  console.log(
    r === 'ready'
      ? `사람별 상태가 이미 있습니다: ${USERS_REL}`
      : `사람별 상태를 만들었습니다: ${USERS_REL}  (${USERS_BRANCH})`,
  )
}

function cmdInit(flags = {}) {
  const root = repoRoot()
  const dir = ledgerDir(root)

  // .axmap 을 손으로 지웠어도 git 쪽에는 worktree 등록이 남아
  // worktree add 가 "already registered" 로 실패한다. 먼저 정리한다.
  git(['worktree', 'prune'], { cwd: root })

  if (fs.existsSync(path.join(dir, '.git'))) {
    console.log(`장부가 이미 있습니다: ${LEDGER_REL}`)
    // 🔴 여기서 끝내면 안 된다. 쪽지함은 장부보다 나중에 생겼으므로, 이미 init 을
    //    돌린 사람은 장부만 있고 쪽지함이 없다. 그 사람들이 다시 init 을 불렀을 때
    //    받아 가는 자리가 여기다.
    if (ensureBus(root) === 'created') console.log(`쪽지함을 만들었습니다: ${BUS_REL}  (${BUS_BRANCH})`)
    if (ensureUsers(root) === 'created') console.log(`사람별 상태를 만들었습니다: ${USERS_REL}  (${USERS_BRANCH})`)
    return
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    die(
      `${LEDGER_REL} 가 이미 있지만 정상적인 장부 worktree 가 아닙니다.\n` +
        `지운 뒤 다시 시도하세요:  rm -rf ${LEDGER_REL}`,
    )
  }

  // 🔴 원격을 고르는 것은 **여기서 한 번**이고, 고른 결과를 저장소에 박아 둔다.
  //
  //    claim 이 매번 다시 추론하면 상황이 바뀔 때마다(원격 추가·이름 변경) 판정이
  //    조용히 달라진다. 어제는 team 으로 가던 장부가 오늘은 origin 으로 간다.
  //    init 이 정하고 git config 에 적어 두면 그 뒤로는 아무도 추측하지 않는다.
  //
  //    여럿인데 못 고르겠으면 **고르지 말고 멈춘다.** 잘못 고르면 장부가 엉뚱한
  //    저장소로 가고, 그건 아무 증상이 없다 — push 는 성공하고 팀은 못 본다.
  const r = resolveRemote(root, flags)
  if (r.source === 'ambiguous') {
    die(
      `원격이 둘 이상입니다. 장부를 어디에 둘지 골라 주세요.\n\n` +
        r.all.map((n) => `  ${n.padEnd(10)} ${git(['remote', 'get-url', n], { cwd: root }).out}`).join('\n') +
        `\n\n  axmap init --remote <이름>\n` +
        `  (또는 미리:  git config axmap.remote <이름>)\n\n` +
        `아무거나 고르지 않는 이유: 장부가 엉뚱한 저장소로 가면 push 는 성공하고\n` +
        `팀은 서로의 claim 을 영영 못 봅니다. 증상이 없는 실패입니다.`,
    )
  }
  const remote = r.name
  if (remote) {
    // 고른 근거가 추론이었다면 못 박는다. 이미 설정에서 왔으면 다시 쓰지 않는다.
    if (!r.source.startsWith('git config')) {
      git(['config', 'axmap.remote', remote], { cwd: root })
    }
    console.log(`장부 원격: ${remote}  (${r.source})`)
  }

  // 원격에 이미 장부가 있으면 그것을 쓰고, 없으면 빈 트리로 새로 만든다.
  let base = null
  if (remote && git(['fetch', '--quiet', remote, LEDGER_BRANCH], { cwd: root }).code === 0) {
    base = git(['rev-parse', 'FETCH_HEAD'], { cwd: root }).out
    console.log('원격 장부를 발견했습니다. 이어서 사용합니다.')
  } else {
    // 작업 트리를 건드리지 않고 고아 브랜치를 만드는 방법:
    // 빈 트리 -> 그 트리를 가리키는 부모 없는 커밋 -> 브랜치.
    const tree = gitOrDie(['mktree'], { cwd: root, input: '' }).out
    base = gitOrDie(['commit-tree', tree, '-m', 'axmap: ledger init'], { cwd: root }).out
    console.log('새 장부를 만들었습니다.')
  }

  if (git(['rev-parse', '--verify', '--quiet', LEDGER_BRANCH], { cwd: root }).code !== 0) {
    gitOrDie(['branch', LEDGER_BRANCH, base], { cwd: root })
  }
  gitOrDie(['worktree', 'add', '--quiet', dir, LEDGER_BRANCH], { cwd: root })
  fs.mkdirSync(claimsDir(root), { recursive: true })
  // git 은 빈 디렉터리를 추적하지 않는다. 모두가 반납해 claim 파일이 0개가 되면
  // claims/ 자체가 사라지므로, 디렉터리를 붙잡아둘 파일을 하나 둔다.
  fs.writeFileSync(path.join(claimsDir(root), '.gitkeep'), '')
  // 임시 파일이 장부에 실리지 않게 한다 (writeFileAtomic 참고).
  ensureLedgerIgnore(root)

  // 장부 worktree 가 본 저장소에서 untracked 로 보이지 않게 한다.
  const gi = path.join(root, '.gitignore')
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : ''
  if (!cur.split(/\r?\n/).includes('.axmap/')) {
    fs.writeFileSync(gi, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '.axmap/\n')
  }

  if (remote) {
    const p = git(['push', '--quiet', remote, `HEAD:${LEDGER_BRANCH}`], { cwd: dir })
    if (p.code !== 0) console.error(`경고: 장부 push 실패 - ${p.err}`)
  } else {
    warnSolo(r)
  }

  ensureBus(root)
  ensureUsers(root)

  console.log(`준비 완료. 장부 ${LEDGER_BRANCH} · 쪽지함 ${BUS_BRANCH} · 사람별 상태 ${USERS_BRANCH}`)
}

// ---------------------------------------------------------------------------
// 명령: claim  (핵심)
// ---------------------------------------------------------------------------

function cmdClaim(positional, flags) {
  const root = repoRoot()
  requireLedger(root)
  const me = agentName(flags)
  const session = resolveSessionId(flags)
  warnRetiredTakeover(flags, 'claim')
  if (!positional.length) die('claim 할 경로를 하나 이상 지정하세요.\n  axmap claim src/auth --task task-12')
  for (const p of positional) {
    const err = claimPathError(p)
    if (err) die(err)
  }
  const want = positional.map(normalizePath)

  // 오타 방어. 아직 만들지 않은 파일을 미리 잡을 수도 있으므로 경고에 그친다.
  // 그냥 두면 존재하지 않는 경로를 잡은 채 실제 수정은 pre-commit 에 막혀 혼란스럽다.
  for (const p of want) {
    if (!fs.existsSync(path.join(root, p))) {
      console.error(`경고: 저장소에 없는 경로입니다 (오타가 아닌지 확인하세요): ${p}`)
    }
  }

  const ttlMs = parseTtl(flags.ttl)

  for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
    syncLedger(root) // 관문 1 준비: 최신 장부를 확보
    const t = now()

    // 관문 2. 판정과 상태 전이는 전부 순수 함수 안에 있다.
    const res = applyClaim({
      claims: readClaims(root),
      me,
      requested: want,
      now: t,
      ttlMs,
      task: typeof flags.task === 'string' ? flags.task : null,
      intent: typeof flags.intent === 'string' ? flags.intent : null,
      // 🔴 잘못된 값을 조용히 폴백하지 않는다.
      // 이 저장소는 "이상한 입력을 안전한 값으로 치환하지 말고 거부한다"를
      // 명시적 원칙으로 걸어뒀다 (CLAUDE.md, SPEC §3 입력 검증).
      // 치환은 서로 다른 두 입력을 같은 것으로 만든다 — 여기서는 색깔만
      // 정하는 필드라 피해가 작지만, 원칙에 예외를 두면 그 예외가 기준이 된다.
      actor: resolveActor(flags.actor),
      session,
    })
    if (!res.ok) {
      // 거부는 종료 코드 2 다 (SPEC 8절). 재시도하지 말고 방향을 바꾸라는 뜻이다.
      console.error(formatBlocks(res.blocks, t))
      process.exit(2)
    }
    if (res.hadExpired) {
      console.error(`알림: ${me} 의 이전 claim 이 만료되어 새 claim 으로 시작합니다.`)
    }
    if (res.otherSessions.length) {
      console.error(formatOtherSessions(res.otherSessions, want, t))
      console.error(`      (이 세션의 id 는 ${sessionFrom ?? '어디에서도 오지 않았습니다'})`)
    }
    // push 실패 시 되돌아갈 지점. 커밋을 만들기 **전에** 잡아둔다.
    const before = ledgerHead(root)
    // 커밋 전에 실패할 수도 있다. 그때는 HEAD 가 아니라 이 파일을 되돌려야 한다.
    const myFile = claimPath(root, me, session)
    const myFileBefore = fs.existsSync(myFile) ? fs.readFileSync(myFile) : null
    writeClaim(root, res.record)

    // 관문 1: push 가 거부되면 그 사이에 누가 장부를 바꾼 것이다.
    const pushed = commitAndPush(root, `claim(${me}): ${want.join(' ')}`)
    if (pushed === 'ok' || pushed === 'nothing') {
      console.log(`claim 성공 - ${me}`)
      for (const p of res.record.paths) console.log(`  + ${p}`)
      console.log(`  TTL ${humanDuration(ttlMs)} (만료 ${new Date(t + ttlMs).toISOString()})`)
      printOverlap(root, res.record.paths)
      printUnread(root, me)
      return
    }
    if (pushed === 'unreachable') {
      // 원격 장애다. 재시도해도 결과가 같고, 로컬에 남기면 나만 아는 락이 된다.
      rollbackLedger(root, before)
      die(
        '원격 장부에 push 할 수 없어 claim 을 취소했습니다.\n' +
          `  ${lastPushError.split('\n')[0]}\n\n` +
          '로컬에만 남겨두면 다른 에이전트는 이 claim 을 볼 수 없고,\n' +
          '같은 경로를 동시에 잡게 됩니다. 그래서 아무것도 잡지 않은 상태로 되돌렸습니다.',
      )
    }
    if (pushed === 'locked') {
      // 백오프를 다 쓰고도 인덱스 락이 안 풀렸다. 로컬에 남은 claim 은 이 저장소
      // 에서만 보이는 락이므로 되돌린다 — unreachable 과 같은 이유다.
      // 커밋 전에 실패했으므로 HEAD 되돌리기만으로는 부족하다(restoreClaimFile 참고).
      restoreClaimFile(myFile, myFileBefore)
      rollbackLedger(root, before)
      die(lockedMessage('claim'))
    }
    console.error(`관문 1: push 거부됨 (누가 먼저 장부를 갱신함). 재시도 ${attempt}/${MAX_CAS_RETRIES}`)
    // 다음 회차는 syncLedger 가 원격 상태로 reset 하므로 이 커밋은 어차피 사라진다.
    // 그래도 마지막 회차에서 빠져나갈 때를 위해 여기서 되돌려 둔다.
    rollbackLedger(root, before)
    /**
     * 🔴 즉시 다시 몰아치지 않는다.
     *
     * 예전에는 5회를 쉬지 않고 붙였다. 그러면 경합 중인 프로세스들이 매번 같은
     * 순간에 같이 fetch·push 하므로 **같은 순서로 같이 지는 쪽**이 계속 나온다
     * (I3 진행성이 걸리는 자리다). 흩어놓아야 누군가는 통과한다.
     */
    casBackoff(attempt)
  }

  die(`장부 경합이 심해 ${MAX_CAS_RETRIES}회 재시도 후 포기했습니다. 잠시 후 다시 시도하세요.\n(로컬 장부는 되돌렸습니다 — 아무것도 잡지 않은 상태입니다.)`)
}

// ---------------------------------------------------------------------------
// 명령: release / renew
// ---------------------------------------------------------------------------

function cmdRelease(positional, flags) {
  const root = repoRoot()
  requireLedger(root)
  const me = agentName(flags)
  const session = resolveSessionId(flags)
  // 다른 세션이 잡은 것까지 함께 푸는 문. 기본은 **이 세션이 잡은 것만**이다.
  // 둘을 각각 먼저 읽는다. `||` 로 이으면 앞이 참일 때 뒤가 안 불리고,
  // 그러면 `--takeover` 가 뒤 낱말을 삼키는 것을 못 잡는다 (warnRetiredTakeover 참고).
  const retired = warnRetiredTakeover(flags, 'release')
  const allSessions = boolFlag(flags['all-sessions'], 'all-sessions') || retired
  const drop = positional.map(normalizePath)

  for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
    syncLedger(root)
    // 🔴 release 는 시계를 안 본다. 만료된 껍데기도 반납 대상이다 — 지우는 것이 곧 정리다.
    const res = applyRelease({ claims: readClaims(root), me, drop, session, allSessions })
    if (res.hadNothing) {
      /**
       * 🔴 반납을 시켰는데 아무것도 반납 안 된 것은 **성공이 아니다.**
       *
       * 두 대로 협업하다 실제로 물렸다. `AXMAP_AGENT=X` 로 claim 한 뒤
       * 그 변수가 없는 셸에서 release 를 불렀고, 이름이 `git config` 로
       * 떨어져 "잡고 있는 경로가 없습니다" + **종료 코드 0** 이 나왔다.
       * 반납했다고 믿었지만 락은 그대로였고 다른 에이전트를 30분 더 막았다.
       *
       * 0 을 주면 스크립트와 에이전트는 성공으로 읽는다. 락 시스템에서
       * 조용히 통과시키는 것이 가장 나쁜 실패다.
       */
      const others = readClaims(root).filter((c) => c.agent !== me)
      console.error(`반납할 것이 없습니다 — "${me}" 이(가) 이 세션에서 잡고 있는 경로가 하나도 없습니다.`)
      console.error(`  이 이름은 ${agentFrom} 에서 왔습니다.`)
      /**
       * 🔴 **이름은 맞는데 세션이 달라서 못 찾은 경우를 따로 말한다.**
       *    둘을 같은 말로 내면 이름을 고치는 엉뚱한 처방으로 간다. 여기서는
       *    이름이 아니라 **어느 창이 잡았는가**가 원인이다.
       */
      if (res.otherSessions.length) {
        console.error('')
        console.error(`  같은 이름 "${me}" 을(를) 잡고 있는 것은 있습니다 — 다른 세션이 적은 줄입니다:`)
        for (const c of res.otherSessions) {
          console.error(`    세션 ${shortSession(c.session)}${c.task ? ` [${c.task}]` : ''}  경로 ${c.paths.length}개`)
        }
        console.error(`  (이 세션의 id 는 ${sessionFrom ?? '어디에서도 오지 않았습니다'})`)
        console.error('')
        console.error('  그것까지 풀려면 --all-sessions 를 붙이세요.')
        console.error('  저 창이 아직 살아 있다면 풀지 마세요 — 저쪽은 자기가 쥐고 있다고 믿습니다.')
      }
      if (others.length) {
        console.error('')
        console.error('  장부에는 다른 이름으로 잡힌 것이 있습니다:')
        for (const c of others) console.error(`    ${c.agent} [${c.task}] ${c.paths.length}개`)
        console.error('')
        console.error('  잡을 때와 다른 이름으로 반납하려 한 것일 수 있습니다.')
        console.error('  claim 할 때 쓴 AXMAP_AGENT 를 같은 값으로 주고 다시 시도하세요.')
      }
      process.exit(EXIT_NOTHING_RELEASED)
    }
    if (res.unheld.length) {
      console.error(`알림: 잡고 있지 않은 경로는 무시합니다: ${res.unheld.join(', ')}`)
    }
    for (const r of res.records) writeClaim(root, r)
    // 지우는 것도 파일명 계산이 아니라 **내용으로** 찾아 지운다 (removeClaimFiles 참고).
    for (const r of res.removed) removeClaimFiles(root, r.agent, r.session ?? null)

    const pushed = commitAndPush(root, `release(${me}): ${drop.length ? drop.join(' ') : 'all'}`)
    if (pushed === 'ok' || pushed === 'nothing') {
      const left = res.records.reduce((n, r) => n + r.paths.length, 0)
      console.log(`release 완료 - ${me}${left ? ` (남은 ${left}개)` : ' (전부 반납)'}`)
      return
    }
    if (pushed === 'locked') die(lockedMessage('release'))
    console.error(`관문 1: push 거부됨. 재시도 ${attempt}/${MAX_CAS_RETRIES}`)
    casBackoff(attempt)
  }
  die('release 실패 - 장부 경합이 계속됩니다.')
}

function cmdRenew(flags) {
  const root = repoRoot()
  requireLedger(root)
  const me = agentName(flags)
  const session = resolveSessionId(flags)
  const ttlMs = parseTtl(flags.ttl)

  for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
    syncLedger(root)
    const t = now()
    const res = applyRenew({ claims: readClaims(root), me, now: t, ttlMs, session })
    if (!res.ok) {
      let msg =
        `${me} 의 유효한 claim 이 이 세션에는 없습니다.\n` +
        'TTL 이 이미 만료되었다면 그 사이 다른 에이전트가 가져갔을 수 있습니다.\n' +
        'axmap claim 으로 다시 선점하세요 (겹침 검사를 다시 거칩니다).'
      // 같은 이름의 다른 창이 잡고 있는 것이라면 처방이 다르다 — 다시 잡는 게 아니라
      // 그 세션이라고 말하고 늘리는 것이다. 안 알려주면 두 번 잡게 된다.
      if (res.otherSessions.length) {
        msg += '\n\n같은 이름의 다른 세션이 잡고 있는 것은 있습니다:'
        for (const c of res.otherSessions) {
          msg += `\n  세션 ${shortSession(c.session)}${c.task ? ` [${c.task}]` : ''}  경로 ${c.paths.length}개`
        }
        msg += '\n그 세션의 것을 늘리려면 --session <그 세션 id> 로 그 세션이라고 말하세요.'
        msg += '\n저 창이 이미 끝난 것이면 늘리지 마세요 — 늘린 만큼 아무도 안 쓰는 경로가 막힙니다.'
      }
      die(msg)
    }
    writeClaim(root, res.record)
    const pushed = commitAndPush(root, `renew(${me})`)
    if (pushed === 'ok' || pushed === 'nothing') {
      console.log(`renew 완료 - ${me}, TTL ${humanDuration(ttlMs)} 연장`)
      return
    }
    if (pushed === 'locked') die(lockedMessage('renew'))
    console.error(`관문 1: push 거부됨. 재시도 ${attempt}/${MAX_CAS_RETRIES}`)
    casBackoff(attempt)
  }
  die('renew 실패 - 장부 경합이 계속됩니다.')
}

// ---------------------------------------------------------------------------
// 명령: status
// ---------------------------------------------------------------------------

function cmdStatus(flags) {
  const root = repoRoot()
  requireLedger(root)
  syncLedger(root)
  const t = now()
  const all = readClaims(root)

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          now: new Date(t).toISOString(),
          active: activeClaims(all, t),
          expired: all.filter((c) => claimExpiresAt(c) <= t),
        },
        null,
        2,
      ),
    )
    return
  }

  const live = activeClaims(all, t)
  const dead = all.filter((c) => claimExpiresAt(c) <= t)

  // 🔴 `status` 도 쪽지를 알린다. 예전에는 `claim` 만 알렸다.
  //    "지금 무슨 일이 벌어지고 있나" 를 묻는 자리가 여기인데, 정작 나에게 온
  //    말을 안 보여줬다. 이름을 못 정하면 조용히 건너뛴다 — 알림 때문에
  //    status 가 죽으면 안 된다.
  const mine = resolveAgentName(flags).name

  if (!live.length && !dead.length) {
    console.log('장부가 비어 있습니다. 아무도 아무것도 잡고 있지 않습니다.')
    printUnread(root, mine)
    return
  }

  console.log(`장부 상태 (${new Date(t).toISOString()})\n`)
  // 🔴 이름이 같은 줄이 **여럿일 수 있다.** 레코드가 (이름, 세션) 짝마다 하나라,
  //    창을 둘 띄우면 같은 이름이 두 줄로 선다. 그래서 세션을 반드시 함께 찍는다 —
  //    안 찍으면 같은 이름 두 줄이 장부의 버그처럼 보인다.
  const mySession = resolveSessionId(flags)
  for (const c of live) {
    console.log(`  ${c.agent}${c.task ? `  [${c.task}]` : ''}  - ${humanDuration(claimExpiresAt(c) - t)} 남음`)
    if (c.session) {
      const same = mySession && c.session === mySession
      console.log(`    세션 ${shortSession(c.session)}${same ? ' (이 세션)' : mySession ? ' (이 세션이 아님)' : ''}`)
    }
    if (c.intent) console.log(`    "${c.intent}"`)
    for (const p of c.paths) console.log(`      ${p}`)
    console.log('')
  }
  for (const c of dead) {
    console.log(`  ${c.agent}  - 만료됨 (자동 회수 대상, 아무것도 막지 않음)`)
    for (const p of c.paths) console.log(`      ${p}`)
    console.log('')
  }
  printUnread(root, mine)
}

// ---------------------------------------------------------------------------
// 명령: verify  (pre-commit 훅용)
// ---------------------------------------------------------------------------

function cmdVerify(flags) {
  const root = repoRoot()
  // 장부 자신에 대한 커밋은 검사 대상이 아니다.
  // commitAndPush 가 --no-verify 를 쓰므로 보통은 여기 오지 않지만,
  // 사람이 장부를 손으로 고칠 때를 대비한 두 번째 그물이다.
  if (isLedgerWorktree(root)) return
  requireLedger(root)
  const me = agentName(flags)
  syncLedger(root)

  // 여기서만 GIT_INDEX_FILE 을 남긴다.
  // git commit --only <경로> 는 임시 인덱스를 만들어 이 변수로 알려주므로,
  // 걷어내면 실제로 커밋될 내용이 아닌 엉뚱한 인덱스를 검사하게 된다.
  /**
   * 🔴 `-c core.quotepath=false` 가 없으면 **한글 경로가 통과하지 못한다.**
   *
   * git 은 기본으로 ASCII 밖의 글자를 8진 이스케이프로 바꾸고 경로 전체를
   * 따옴표로 감싼다 —
   *
   *   docs/bus/방향-전환.md
   *     → "docs/bus/\353\260\251\355\226\245-\354\240\204\355\231\230.md"
   *
   * 그러면 앞에 따옴표가 붙어 있어 `docs/bus` 로 시작하지 않게 되고,
   * **디렉터리를 선점했는데도 그 아래 파일이 거부된다.** 실제로 겪었다 —
   * `docs/bus` 를 잡은 채로 한글 제목 쪽지를 커밋하려다 막혔다.
   *
   * 더 나쁜 방향도 가능하다: 겹침 판정이 경로를 못 알아보면 **막아야 할 것을
   * 통과시킬** 수도 있다. 락에서 최악은 조용한 통과다.
   *
   * 이 저장소는 주석·문서·커밋 메시지가 전부 한국어라 파일 이름도 한국어가
   * 될 수 있다. 예외가 아니라 기본값으로 다뤄야 한다.
   */
  const staged = gitOrDie(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only'], {
    cwd: root,
    keepEnv: ['GIT_INDEX_FILE'],
  })
    .out.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizePath)
    .filter((f) => !f.startsWith('.axmap/'))

  if (!staged.length) return

  /**
   * 🔴 여기만 **사람 단위**로 본다 (세션이 아니라 이름 전체).
   *
   * 커밋하는 것은 세션이 아니라 사람이다. A 창에서 잡고 B 창에서 커밋하는 것은
   * 원래 되던 일이고, 여기까지 세션으로 좁히면 고치려던 것보다 큰 고장이 된다.
   */
  const paths = myActivePaths(readClaims(root), me, now())
  const uncovered = staged.filter((f) => !coversPath(paths, f))

  if (uncovered.length) {
    console.error('커밋 거부 - claim 하지 않은 파일을 수정했습니다.\n')
    for (const f of uncovered) console.error(`  x ${f}`)
    console.error(`\n${me} 이(가) 현재 잡고 있는 경로:`)
    if (paths.length) for (const p of paths) console.error(`  - ${p}`)
    else console.error('  (없음)')
    console.error('\n해결:\n  axmap claim <경로>   먼저 선점한 뒤 커밋하세요')
    process.exit(3)
  }
}

// ---------------------------------------------------------------------------
// 명령: audit  (사후 증명)
// ---------------------------------------------------------------------------

/**
 * `--code <범위>` 가 가리키는 **코드 커밋**을 모은다 (I5 · 강제 검사의 입력).
 *
 * 🔴 **머지 커밋은 뺀다** (`--no-merges`). 서버가 만든 것이라 사람이 파일을 고른
 *    적이 없고, 그것을 위반으로 세면 MR 을 쓸수록 빨개진다 — 문을 세운 결과가
 *    문을 우회하는 것이 된다.
 *
 * 🔴 **범위를 인자로 받는다. 이력 전체를 검사하지 않는다.** 장부가 생기기 전에
 *    쌓인 커밋은 아무도 잡지 않은 채 고쳐진 것이 당연하고, 그것까지 세면 이 잡은
 *    켠 날부터 영원히 빨갛다. CI 는 이번 push 로 들어온 구간만 넘긴다.
 */
function collectCodeCommits(root, range) {
  const ZERO = '0000000000000000000000000000000000000000'
  if (range.includes(ZERO)) {
    // 새 브랜치의 첫 push 면 GitLab 이 "이전 sha" 자리에 0 을 넣는다. 비교할 앞이 없다.
    console.log(`구간에 빈 sha 가 있습니다 (${range}) - 첫 push 로 보고 코드 대조를 건너뜁니다.`)
    return null
  }
  const log = git(['log', '--no-merges', '--format=%H%x00%an%x00%ct%x00%s', range], { cwd: root })
  if (log.code !== 0) {
    // 🔴 못 읽은 것을 통과로 내지 않는다. 조용히 빈 배열을 주면 "위반 0" 이 된다.
    die([
      `코드 구간을 읽지 못했습니다 (${range}).`,
      '  구간을 확인하세요 - 검사하지 못한 것을 통과로 내지 않습니다.',
    ].join(NL))
  }
  const out = []
  for (const line of log.out ? log.out.split(NL) : []) {
    if (!line) continue
    const [sha, author, ct, subject] = line.split(NUL)
    // 🔴 `-c core.quotepath=false` 가 없으면 **한글 경로가 claim 과 안 맞는다.**
    //    git 은 기본으로 ASCII 밖 글자를 역슬래시 + 8진수 세 자리로 감싸 내보낸다.
    //    그 문자열은 장부에 적힌 경로와 절대 같아질 수 없고, 검사는 "안 겹친다" 로
    //    **조용히 통과**한다 - 락에서 최악인 fail-open 이다.
    //    팀 CI 가 잡 안에서 `git config core.quotepath false` 로 막고 있었다.
    //    우회는 그 잡에만 걸린다. 부르는 자리에서 못을 박는다 (verify 와 같은 방식).
    const files = git(
      ['-c', 'core.quotepath=false', 'show', '--no-renames', '--name-only', '--format=', sha],
      { cwd: root },
    ).out
    out.push({
      sha,
      author,
      time: Number(ct) * 1000,
      subject,
      files: (files ? files.split(NL) : []).filter(Boolean),
    })
  }
  return out
}


// ---------------------------------------------------------------------------
// 감사 체크포인트 — "여기까지는 이미 재생해서 깨끗함을 봤다"
//
// 왜 필요한지와 왜 이력을 버리지 않는지는 src/invariants.mjs 의 planAudit 위에 있다.
// 여기 있는 것은 그 기록을 git 에 넣고 빼는 배관뿐이다.
// ---------------------------------------------------------------------------

/**
 * 체크포인트 브랜치의 끝을 **sha 로 굳혀서** 돌려준다. 없으면 null.
 *
 * FETCH_HEAD 는 worktree 마다 따로 보관되고 다음 fetch 가 덮어쓴다. 그래서 받자마자
 * sha 로 바꾼다 — 이 값은 그 뒤 어느 폴더에서 써도 같다 (한 저장소의 worktree 들은
 * 객체 저장소를 공유한다).
 */
function checkpointTip(root, { fetch }) {
  if (fetch) {
    const r = resolveRemote(root)
    const remote = r.source === 'ambiguous' ? null : r.name
    if (remote && git(['fetch', '--quiet', remote, CHECKPOINT_BRANCH], { cwd: root }).code === 0) {
      const h = git(['rev-parse', 'FETCH_HEAD'], { cwd: root })
      if (h.code === 0 && h.out) return h.out
    }
    /**
     * 못 받았으면 **아직 아무도 체크포인트를 안 남겼다**로 읽는다.
     * 원격이 죽은 경우는 장부를 받는 자리에서 이미 멈춰 있고(거기가 fail-closed),
     * 여기서 잘못 판단해도 대가는 "처음부터 다 재생한다" 뿐이다 — 느려질 뿐
     * 통과가 헐거워지지 않는다.
     */
  }
  const local = git(['rev-parse', '--verify', '--quiet', CHECKPOINT_BRANCH], { cwd: root })
  return local.code === 0 && local.out ? local.out : null
}

/**
 * 체크포인트 목록을 읽는다. **깨져 있으면 멈춘다** (fail-closed).
 *
 * 조용히 빈 목록으로 넘기면 그냥 느려질 뿐이라 무해해 보이지만 아니다 —
 * 이 목록이 **면제(amnesty) 경계**를 정한다. 없는 것으로 만들면 봐주는 범위가
 * 통째로 달라진다. 판정 범위를 정하는 입력은 못 읽었을 때 추측하지 않는다.
 */
function readCheckpoints(cwd, tipSha) {
  if (!tipSha) return []
  const r = git(['show', `${tipSha}:${CHECKPOINT_FILE}`], { cwd })
  if (r.code !== 0) return [] // 브랜치는 있는데 파일이 없다 = 아직 하나도 안 적혔다
  let doc
  try {
    doc = JSON.parse(r.out)
  } catch (e) {
    die(
      `체크포인트를 읽을 수 없습니다 (${CHECKPOINT_BRANCH}:${CHECKPOINT_FILE})` +
        NL + e.message + NL + NL +
        '어디서부터 재생할지 정할 수 없으므로 중단합니다 — 검사하지 못한 것을 통과로 내지 않습니다.',
    )
  }
  const list = Array.isArray(doc?.checkpoints) ? doc.checkpoints : null
  if (!list) {
    die(`체크포인트 파일에 checkpoints 배열이 없습니다 (${CHECKPOINT_BRANCH}:${CHECKPOINT_FILE}).`)
  }
  for (const c of list) {
    if (!/^[0-9a-f]{40}$/.test(c?.ledger ?? '') || !Number.isFinite(c?.time)) {
      die(
        `체크포인트 항목이 망가졌습니다: ${JSON.stringify(c)}` + NL +
          '필요: ledger(장부 커밋 sha 40자) · time(그 스냅샷의 논리 시각, ms)',
      )
    }
  }
  return list
}

function warnCheckpoint(r) {
  console.error(`경고: 체크포인트를 남기지 못했습니다 — ${(r.err || r.out || '').split(NL)[0]}`)
  console.error('  판정은 그대로입니다. 다음 감사가 그만큼 더 오래 걸립니다.')
}

/**
 * 이번에 재생해서 깨끗했던 끝점을 체크포인트로 남긴다.
 *
 * 🔴 **감사가 통과했을 때만 부른다.** 체크포인트의 뜻이 "여기까지 봤고 깨끗했다"
 *    이므로, 위반이 있는데 적으면 그 위반이 영원히 검사 밖으로 나간다.
 *
 * 🔴 적는 것은 장부 상태의 **사본이 아니라 커밋 sha 하나**다. 사본을 두면 장부와
 *    두 벌이 되고, 두 벌은 반드시 어긋난다. 주소는 어긋날 수가 없다.
 *
 * 실패해도 **죽지 않는다.** 못 적은 체크포인트의 대가는 다음 감사가 느린 것이지
 * 판정이 헐거워지는 것이 아니다 — 장부 push 실패와 정반대다.
 */
function saveCheckpoint(root, cwd, ledgerTip, time, snapshotCount, agent) {
  const r0 = resolveRemote(root)
  const remote = r0.source === 'ambiguous' ? null : r0.name
  const entry = {
    ledger: ledgerTip,
    time,
    at: new Date(time).toISOString(),
    snapshots: snapshotCount,
    by: agent,
  }
  // CI 컨테이너에는 git 신원이 없을 수 있다. commit-tree 는 그것 없이는 못 만든다.
  const ident = git(['config', 'user.email'], { cwd: root }).out
  const idArgs = ident ? [] : ['-c', 'user.name=axmap', '-c', 'user.email=axmap@invalid']

  // 회차는 1부터 센다 — casBackoff 가 그 관례로 대기 시간을 고른다.
  for (let attempt = 1; attempt <= MAX_CAS_RETRIES; attempt++) {
    const parent = checkpointTip(root, { fetch: !!remote })
    const list = readCheckpoints(cwd, parent)
    if (list.some((c) => c.ledger === ledgerTip)) {
      console.log(`체크포인트가 이미 있습니다: ${ledgerTip.slice(0, 7)}`)
      return
    }
    const next = [...list, entry].sort((a, b) => a.time - b.time)
    const body = JSON.stringify({ version: 1, checkpoints: next }, null, 2) + NL
    const blob = git(['hash-object', '-w', '--stdin'], { cwd: root, input: body })
    if (blob.code !== 0) return warnCheckpoint(blob)
    const tree = git(['mktree'], { cwd: root, input: `100644 blob ${blob.out}${TAB}${CHECKPOINT_FILE}${NL}` })
    if (tree.code !== 0) return warnCheckpoint(tree)
    const msg = `axmap: checkpoint ${ledgerTip.slice(0, 7)} (스냅샷 ${snapshotCount}개까지 재생 확인)`
    const commit = git(
      [...idArgs, 'commit-tree', tree.out, ...(parent ? ['-p', parent] : []), '-m', msg],
      { cwd: root },
    )
    if (commit.code !== 0) return warnCheckpoint(commit)

    if (!remote) {
      git(['branch', '-f', CHECKPOINT_BRANCH, commit.out], { cwd: root })
      warnSolo(r0)
      console.log(`체크포인트를 로컬에만 남겼습니다: ${ledgerTip.slice(0, 7)}`)
      return
    }
    // push 를 먼저 하고 성공했을 때만 로컬 브랜치를 옮긴다. 순서를 뒤집으면
    // 원격에 없는 체크포인트를 로컬이 진짜로 믿게 된다.
    const p = git(['push', '--quiet', remote, `${commit.out}:refs/heads/${CHECKPOINT_BRANCH}`], { cwd: root })
    if (p.code === 0) {
      git(['branch', '-f', CHECKPOINT_BRANCH, commit.out], { cwd: root })
      console.log(`체크포인트를 남겼습니다: ${ledgerTip.slice(0, 7)}  (${CHECKPOINT_BRANCH})`)
      return
    }
    // 거부 = 남이 먼저 올렸다. 다시 받아서 그 위에 얹는다 (장부의 CAS 와 같은 모양).
    if (attempt === MAX_CAS_RETRIES) return warnCheckpoint(p)
    casBackoff(attempt)   // 이 함수가 직접 잔다
  }
}

function cmdAudit(flags) {
  const root = repoRoot()
  const dir = ledgerDir(root)
  const hasWorktree = fs.existsSync(path.join(dir, '.git'))
  const wantCheckpoint = boolFlag(flags.checkpoint, 'checkpoint')

  /**
   * 🔴 **`--fetch` 는 장부 worktree 를 요구하지 않는다.**
   *
   * 예전에는 맨 앞에서 `requireLedger` 를 불렀다. 그런데 이 명령을 실제로 부르는
   * 곳은 팀 CI 의 `claims` 잡이고, **CI 는 신선한 clone 이라 `.axmap/ledger` 가
   * 없다.** 그래서 CI 에서는 늘 "장부가 없습니다. 먼저 axmap init" 으로 죽었다.
   * `--fetch` 라는 플래그가 바로 그 CI 를 위해 있는 것인데 순서가 뒤집혀 있었다.
   *
   * 이 잡은 **설치 여부와 무관한 유일한 강제 장치**로 설계됐다 — 훅은 각자 PC 에
   * 있고 이건 서버에 있다. 그것이 한 번도 안 돌았다는 뜻은, 선점 강제가 지금까지
   * **훅을 설치한 사람에게만** 걸려 있었다는 것이다.
   *
   * 고치는 방향은 코드가 이미 알려준다 — `audit` 은 **읽기만** 한다
   * (`log` · `ls-tree` · `show`). 쓰지 않으므로 worktree 가 필요 없고 ref 하나면 된다.
   */
  let cwd = dir
  let tip = null
  if (hasWorktree) {
    if (flags.fetch) syncLedger(root)
    tip = gitOrDie(['rev-parse', 'HEAD'], { cwd: dir }).out
  } else if (flags.fetch) {
    const r = resolveRemote(root)
    const remote = r.source === 'ambiguous' ? null : r.name
    if (!remote) {
      die('장부를 받아올 원격을 정할 수 없습니다.\n  git config axmap.remote <이름> 으로 정하거나 axmap init 을 실행하세요.')
    }
    if (git(['fetch', '--quiet', remote, LEDGER_BRANCH], { cwd: root }).code !== 0) {
      // 🔴 "아직 없다" 와 "못 닿는다" 를 가른다. init 이 같은 자리에서 하는 구분이다.
      //    닿는데 브랜치가 없으면 아무도 아직 claim 한 적이 없다는 뜻이고, 검사할
      //    것이 없는 것이지 실패가 아니다. 여기서 죽이면 장부를 처음 쓰는 팀의
      //    CI 가 영원히 빨갛다.
      if (remoteReachable(root, remote, root)) {
        console.log('장부가 아직 없습니다 - 검사할 스냅샷이 없습니다.')
        return
      }
      die(
        `원격 장부에 닿을 수 없습니다 (${remote}/${LEDGER_BRANCH}).\n` +
          '검사하지 못한 것을 통과로 내지 않습니다 — 연결을 고친 뒤 다시 시도하세요.',
      )
    }
    cwd = root
    // 🔴 FETCH_HEAD 를 그대로 들고 다니지 않는다. 바로 뒤에서 체크포인트를 또
    //    받으면 덮어쓴다. 받은 자리에서 sha 로 굳힌다.
    tip = gitOrDie(['rev-parse', 'FETCH_HEAD'], { cwd: root }).out
  } else {
    requireLedger(root)
    tip = gitOrDie(['rev-parse', 'HEAD'], { cwd: dir }).out
  }

  const codeCommits = typeof flags.code === 'string' && flags.code
    ? collectCodeCommits(root, flags.code)
    : null

  // 어디서부터 재생할지는 **이번 코드 구간에서 가장 오래된 커밋**이 정한다.
  // 왜 "가장 최근 체크포인트" 가 아닌지는 planAudit 위에 적혀 있다.
  const checkpoints = readCheckpoints(cwd, checkpointTip(root, { fetch: !!flags.fetch }))
  const plan = planAudit({ checkpoints, codeCommits })

  let replay = null
  let lines = []
  const FMT = '%H%x00%ct%x00%s'
  if (plan.from) {
    /**
     * 🔴 체크포인트가 가리키는 커밋이 지금 장부의 조상이 아니면 **판정 불가**다.
     *    이력이 다시 쓰였다는 뜻이고, 그러면 "여기까지 봤다" 는 문장이 가리키는
     *    이력이 더 이상 없다. 성능을 위해 보장을 무르게 만들지 않는다.
     */
    if (git(['merge-base', '--is-ancestor', plan.from.ledger, tip], { cwd }).code !== 0) {
      die(
        `판정 불가 — 체크포인트 ${plan.from.ledger.slice(0, 7)} 가 지금 장부(${tip.slice(0, 7)})의 조상이 아닙니다.` + NL +
          '  장부 이력이 다시 쓰였을 때만 이렇게 됩니다. 그 체크포인트가 보증하던 구간이 사라졌으므로' + NL +
          '  이어서 재생할 수 없습니다. 체크포인트 브랜치를 지우고 (' + CHECKPOINT_BRANCH + ')' + NL +
          '  `axmap audit --checkpoint` 로 처음부터 다시 세우세요.',
      )
    }
    const before = Number(gitOrDie(['rev-list', '--count', plan.from.ledger], { cwd }).out)
    replay = { from: plan.from.ledger, at: plan.from.at ?? new Date(plan.from.time).toISOString(), covered: before - 1 }
    // 체크포인트 자신도 재생 목록에 넣는다. I5 가 그 시점의 장부 상태를 밑바탕으로 쓴다.
    const head = gitOrDie(['log', '-1', `--format=${FMT}`, plan.from.ledger], { cwd }).out
    const rest = gitOrDie(['log', '--reverse', `--format=${FMT}`, `${plan.from.ledger}..${tip}`], { cwd }).out
    lines = [head, ...(rest ? rest.split(NL) : [])]
  } else {
    // 체크포인트가 하나도 없다. 예전과 똑같이 뿌리부터 전부 재생한다.
    const log = gitOrDie(['log', '--reverse', `--format=${FMT}`, tip], { cwd }).out
    lines = log ? log.split(NL) : []
  }

  const snapshots = []
  for (const line of lines) {
    if (!line) continue
    const [sha, ct, subject] = line.split(NUL)
    const files = git(['ls-tree', '-r', '--name-only', sha, 'claims/'], { cwd }).out
    const claims = []
    // readClaims 와 같은 규칙으로 .json 만 본다. claims/ 에는 .gitkeep 도 있다.
    for (const f of (files ? files.split(NL) : []).filter((f) => f.endsWith('.json'))) {
      const blob = git(['show', `${sha}:${f}`], { cwd })
      if (blob.code !== 0) continue
      try {
        claims.push(JSON.parse(blob.out))
      } catch {
        die(`감사 중단 - ${sha.slice(0, 7)} 의 ${f} 를 파싱할 수 없습니다.`)
      }
    }
    snapshots.push({ commit: sha, time: Number(ct) * 1000, subject, claims })
  }

  /**
   * 🔴 체크포인트에 적힌 시각과 그 커밋을 실제로 펼친 시각이 다르면 **판정 불가**다.
   *    시작 지점을 고르는 계산이 전부 그 시각 위에 서 있으므로, 어긋난 채로 가면
   *    "가장 오래된 코드 커밋보다 앞선다" 는 판단 자체가 거짓이 된다.
   */
  if (plan.from && snapshots.length) {
    const actual = snapshotTime(snapshots[0])
    if (actual !== plan.from.time) {
      die(
        `판정 불가 — 체크포인트 ${plan.from.ledger.slice(0, 7)} 에 적힌 시각과 실제 장부 스냅샷의 시각이 다릅니다.` + NL +
          `  적힌 것: ${new Date(plan.from.time).toISOString()}` + NL +
          `  실제:    ${new Date(actual).toISOString()}`,
      )
    }
  }

  const amnesty = plan.amnestied.map((c) => ({
    sha: c.sha,
    subject: c.subject,
    at: new Date(c.time).toISOString(),
  }))
  const report = auditLedger(snapshots, plan.judged, { replay, amnesty })

  /**
   * 🔴 그물. 판정하기로 한 커밋이 재생 구간보다 앞서 있으면 enforcementViolations
   *    가 그것을 "장부보다 앞선 커밋" 으로 조용히 건너뛴다 — 거부해야 할 것을
   *    통과시키는 쪽의 실패다. 시작 지점 고르기가 어긋났을 때만 생기는 일이라
   *    평소에는 절대 안 걸리지만, 걸리면 통과가 아니라 중단이어야 한다.
   */
  if (plan.from && report.codeSkipped?.length) {
    die(
      `판정 불가 — 재생 구간(체크포인트 ${plan.from.ledger.slice(0, 7)} 이후)보다 앞선 코드 커밋 ${report.codeSkipped.length}개가 남았습니다.` + NL +
        report.codeSkipped.map((s) => `  - ${String(s.commit).slice(0, 7)}  ${s.subject}`).join(NL),
    )
  }

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatAudit(report))
  }
  if (!report.ok) process.exit(4)

  if (wantCheckpoint) {
    if (!snapshots.length) {
      console.log('장부에 스냅샷이 없어 체크포인트를 남기지 않았습니다.')
      return
    }
    const total = Number(gitOrDie(['rev-list', '--count', tip], { cwd }).out)
    saveCheckpoint(root, cwd, tip, snapshotTime(snapshots[snapshots.length - 1]), total, resolveAgentName(flags).name)
  }
}

/**
 * `doctor` — 이 저장소에서 선점이 **실제로 도는지**를 스스로 확인한다.
 *
 * 🔴 왜 필요한가. 이 도구의 실패는 대부분 **조용하다.** 원격이 없거나, 이름이
 *    남과 같거나, 훅이 안 심겼거나 — 셋 다 claim 은 성공하고 아무 오류도 안 난다.
 *    그래서 "붙였는데 되는 건가?" 를 사람이 확인할 방법이 필요하다.
 *
 *    새 팀원이 clone 하고 나서 물어볼 사람 없이 혼자 답을 얻을 수 있어야 한다는 것이
 *    이 명령의 전부다. 통과/실패를 눈으로 보여주고 종료 코드로도 낸다.
 *
 * 판정 기준은 **경고와 오류를 나눈다.** 혼자 쓰는 것은 오류가 아니지만(경고),
 * 이름이 없는 것은 오류다 — 그 상태로는 장부가 거짓말을 한다.
 */
function cmdDoctor(flags) {
  const lines = []
  let bad = 0
  let warn = 0
  const ok = (what, detail) => lines.push(['ok', what, detail])
  const no = (what, detail) => { bad++; lines.push(['no', what, detail]) }
  const hm = (what, detail) => { warn++; lines.push(['hm', what, detail]) }

  // 1. node
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) ok('node', `v${process.versions.node}`)
  else no('node', `v${process.versions.node} — 20 이상이 필요합니다`)

  // 2. 저장소
  let root = null
  try { root = repoRoot() } catch { /* 아래에서 처리 */ }
  if (root) ok('저장소', root)
  else { no('저장소', 'git 저장소 안이 아닙니다'); return finishDoctor(lines, bad, warn, flags) }

  // 3. 이름 — 여기가 제일 중요하다. 여럿이 같은 이름이면 장부가 조용히 거짓말한다.
  let me = null
  try { me = agentName(flags) } catch { /* die 가 먼저 난다 */ }
  if (me) ok('내 이름', `${me}  (${agentFrom})`)
  else no('내 이름', 'AXMAP_AGENT 도 git config user.name 도 없습니다')

  // 3-b. 세션 — 이름이 같은 두 주체를 가르는 것. 없으면 못 가른다(= 예전 사고 그대로)
  const sid = resolveSessionId(flags)
  if (sid) ok('내 세션', `${shortSession(sid)}  (${sessionFrom})`)
  else {
    hm(
      '내 세션',
      '알 수 없습니다 — 같은 이름의 다른 세션을 구별하지 못합니다\n' +
        '         세션마다 AXMAP_SESSION 을 다르게 주세요 (Claude Code 는 자동입니다)',
    )
  }

  // 4. 장부
  const home = axmapHome(root)
  const hasLedger = fs.existsSync(path.join(ledgerDir(root), '.git'))
  // 링크된 worktree 면 장부가 어디 있는지 그대로 보여준다. 같은 저장소에 장부는 하나다.
  const where = path.resolve(home) === path.resolve(root) ? LEDGER_REL : path.join(home, LEDGER_REL)
  if (hasLedger) ok('장부', where)
  else no('장부', `없습니다 (${where}) — 'axmap init' 또는 setup 스크립트를 실행하세요`)

  // 5. 원격 — 없어도 돌지만, 그때 claim 은 "겹치지 않는다" 가 아니라 "남을 못 본다" 다
  const r = resolveRemote(root, flags)
  if (r.name) {
    const url = git(['remote', 'get-url', r.name], { cwd: root }).out
    ok('장부 원격', `${r.name}  (${r.source})\n         ${url}`)
    if (hasLedger && !remoteReachable(root, r.name)) {
      no('원격 연결', `${r.name} 에 닿지 못했습니다 — 관문 1(직렬화)이 작동하지 않습니다`)
    } else if (hasLedger) {
      ok('원격 연결', '닿습니다')
    }
  } else if (r.source === 'ambiguous') {
    hm('장부 원격', `원격이 여럿이라 고르지 못했습니다 (${r.all.join(', ')})\n         git config axmap.remote <이름>`)
  } else {
    hm('장부 원격', '없습니다 — 혼자 쓸 때만 안전합니다. 다른 사람의 claim 을 보지 못합니다')
  }

  // 6. 훅 — 없으면 이 프로토콜은 권고 사항에 불과하다
  const hookPath = path.join(git(['rev-parse', '--git-common-dir'], { cwd: root }).out || path.join(root, '.git'), 'hooks', 'pre-commit')
  const hookAbs = path.isAbsolute(hookPath) ? hookPath : path.join(root, hookPath)
  if (fs.existsSync(hookAbs) && fs.readFileSync(hookAbs, 'utf8').includes('axmap')) {
    // 훅은 절대 경로를 담는다. 폴더 이름이 바뀌면 사라진 곳을 가리킨다.
    // 다만 요즘 훅은 그 경로가 없을 때 저장소 안을 한 번 더 본다(cmdHookInstall 참조).
    // 그래서 박아둔 경로만 보고 빨간불을 켜면 **거짓 경보**가 된다.
    const target = (fs.readFileSync(hookAbs, 'utf8').match(/"([^"]+axmap\.mjs)"/) ?? [])[1]
    const fallbacks = ['ci/axmap/bin/axmap.mjs', 'axmap/bin/axmap.mjs', 'bin/axmap.mjs']
      .map((rel) => path.join(root, rel))
      .filter((p) => fs.existsSync(p))
    if (!target || fs.existsSync(target)) ok('커밋 훅', '심겨 있습니다')
    else if (fallbacks.length) ok('커밋 훅', `심겨 있습니다 (박아둔 경로 대신 ${path.relative(root, fallbacks[0]).replace(/\\/g, '/')} 를 씁니다)`)
    else no('커밋 훅', `가리키는 파일이 없습니다 (저장소 안에도 없습니다): ${target}\n         axmap hook install 로 다시 심으세요`)
  } else {
    no('커밋 훅', `없습니다 — claim 하지 않은 파일도 그냥 커밋됩니다\n         axmap hook install`)
  }

  // 7. MCP 설정 — AI 도구가 자동으로 붙는 경로
  //
  // 🔴 붙는 길은 **둘**이다. 저장소의 `.mcp.json` 과 각 도구의 홈 설정.
  //    예전에는 앞의 것만 봤다. 그래서 npm 판을 깔고 `axmap setup` 까지 끝낸 사람에게도
  //    ".mcp.json 이 없습니다 — AI 도구가 자동으로 붙지 않습니다" 라고 말했다.
  //    붙어 있는데 안 붙었다고 하는 것이라, 새로 온 팀은 첫날 이 줄을 보고 설치가
  //    잘못된 줄 안다. 홈 등록이 기본이 된 지금은 `.mcp.json` 이 **없는 것이 정상**이다.
  const homeMcp = homeRegistrations()
  const homeWord = homeMcp.found.length
    ? `홈에 등록돼 있습니다 (${homeMcp.found.join(' · ')})` +
      (homeMcp.guessed.length ? `  ※ ${homeMcp.guessed.join(' · ')} 는 설정 파일 글자만 보고 짐작한 것입니다` : '')
    : null
  const mcpJson = path.join(root, '.mcp.json')
  if (fs.existsSync(mcpJson)) {
    let server = null
    try { server = JSON.parse(fs.readFileSync(mcpJson, 'utf8'))?.mcpServers?.axmap?.args?.[0] } catch { /* 아래 */ }
    if (!server) hm('MCP 설정', '.mcp.json 은 있는데 axmap 서버를 못 찾았습니다')
    else if (!fs.existsSync(path.resolve(root, server))) no('MCP 설정', `서버 파일이 없습니다: ${server}`)
    else ok('MCP 설정', `${server}  (AI 도구가 승인만 하면 붙습니다)`)
    // 둘 다 있으면 **저장소 쪽이 이긴다.** 같은 서버면 문제가 없지만, npm 판을 깔아 둔
    // 사람이 "내가 깐 것이 쓰이겠거니" 하고 여기서 엇갈린다. 그 자리에서 말해 준다.
    if (homeMcp.found.length) {
      hm('MCP 설정', `홈에도 등록돼 있습니다 (${homeMcp.found.join(' · ')}) — 이 저장소에서는 위의 .mcp.json 이 먼저 쓰입니다`)
    }
  } else if (homeWord) {
    ok('MCP 설정', `${homeWord} — 저장소에 파일이 없어도 됩니다`)
  } else if (homeMcp.unreadable.length) {
    hm('MCP 설정', `홈 설정을 읽지 못했습니다 (${homeMcp.unreadable.join(' · ')}) — 붙었는지 판단하지 않습니다`)
  } else {
    hm('MCP 설정', '아직 등록된 곳이 없습니다 — AI 도구가 자동으로 붙지 않습니다\n         axmap setup')
  }

  // 8. 실제로 판정이 도는가 — 장부를 바꾸지 않고 읽기만 한다
  if (hasLedger) {
    try {
      const active = activeClaims(readClaims(root), now())
      const mine = active.filter((c) => c.agent === me).length
      ok('선점 판정', `지금 유효한 claim ${active.length}건` + (mine ? ` (그중 내 것 ${mine}건)` : ''))
    } catch (e) {
      no('선점 판정', `장부를 읽지 못했습니다: ${e.message}`)
    }
  }

  // 9. 버전 — 🔴 여기서 네트워크를 치지 않는다. 마지막으로 물어본 결과만 읽는다.
  //    doctor 는 "지금 도는가" 를 재는 자리이고, 레지스트리를 기다리게 만들면
  //    네트워크가 느린 날 점검 자체가 안 끝난다.
  const ver = selfVersion()
  if (isVendored(SELF_ROOT)) {
    ok('버전', `${ver ?? '(모름)'} — 벤더링된 사본입니다. npm 이 아니라 tools/vendor.mjs 가 갱신합니다`)
  } else {
    const cache = readCache()
    const notice = noticeLine(ver, cache?.latest)
    if (notice) hm('새 버전', notice.split('\n').join('\n         '))
    else if (cache) ok('버전', `${ver ?? '(모름)'} — 최신입니다 (확인: ${new Date(cache.checkedAt).toISOString()})`)
    else ok('버전', `${ver ?? '(모름)'} — 새 버전이 있는지 물어본 적이 없습니다 (axmap update)`)
  }

  return finishDoctor(lines, bad, warn, flags)
}

function finishDoctor(lines, bad, warn, flags) {
  if (flags.json) {
    console.log(JSON.stringify({ ok: bad === 0, errors: bad, warnings: warn, checks: lines.map(([s, w, d]) => ({ status: s, what: w, detail: d })) }, null, 2))
  } else {
    const mark = { ok: '  OK ', no: '  !! ', hm: '  ~~ ' }
    console.log('')
    for (const [s, what, detail] of lines) console.log(`${mark[s]} ${what.padEnd(10)} ${detail}`)
    console.log('')
    if (bad) console.log(`고쳐야 할 것 ${bad}건${warn ? `, 알아둘 것 ${warn}건` : ''}. 위의 !! 줄을 보세요.`)
    else if (warn) console.log(`쓸 수 있습니다. 다만 알아둘 것이 ${warn}건 있습니다 (~~ 줄).`)
    else console.log('전부 정상입니다. 파일을 고치기 전에 claim 하는 것만 지키면 됩니다.')
    console.log('')
  }
  process.exit(bad ? 1 : 0)
}

function cmdHookInstall() {
  const root = repoRoot()
  const dir = gitOrDie(['rev-parse', '--git-common-dir'], { cwd: root }).out
  const hooks = path.resolve(root, dir, 'hooks')
  fs.mkdirSync(hooks, { recursive: true })
  // 검사 대상 저장소가 아니라 이 CLI 자신의 위치를 박는다.
  // axMap 은 검사 대상 저장소 바깥에 설치되어 있을 수 있다.
  const self = fileURLToPath(import.meta.url).replace(/\\/g, '/')

  /**
   * 🔴 박아둔 경로를 **1순위로 두되 유일한 길로 두지 않는다.**
   *
   * 위 주석의 의도(바깥 설치 대응)는 옳다. 그래서 `self` 를 그대로 첫 번째로 둔다.
   * 그런데 저장소가 갈래마다 axMap 을 다른 자리에 두면 — 원본은 `axmap/`, 벤더링
   * 사본은 `ci/axmap/` — 브랜치를 옮기는 순간 박아둔 경로가 **사라진다.**
   *
   * 문제는 사라졌다는 사실이 아니라 **죽는 방식**이다. 훅은 "검사 실패" 가 아니라
   * `MODULE_NOT_FOUND` 로 죽고, 0 이 아닌 종료 코드는 곧 커밋 차단이다. 즉
   * **선점과 무관한 커밋까지 전부 막힌다.** 막히면 사람은 계속 일해야 하므로
   * `--no-verify` 를 쓰기 시작하고, **그 습관은 훅이 고쳐진 뒤에도 남는다.**
   * 지금의 고장보다 그것이 비싸다.
   *
   * 그래서 넷을 차례로 본다. **배치가 셋이라는 것은 브랜치를 훑어 실측한 것이다**
   * (2026-08-27 · `git cat-file -e <브랜치>:<경로>`):
   *
   *   1. 박아둔 절대 경로        (바깥 설치)
   *   2. <루트>/ci/axmap/bin     main · common/dev · bigData/dev   ← 현재 표준
   *   3. <루트>/axmap/bin        chore/axmap-bootstrap · backup/*
   *   4. <루트>/bin              back/dev · front/dev              ← 옛 배치
   *
   * 🔴 4번을 빠뜨리면 **도구가 거기 있는데 못 찾아서 통과한다.** 그건 "설치 안 됨"
   *    이 아니라 "찾는 목록이 짧음" 이고, 아래 fail-open 의 근거가 성립하지 않는
   *    경우다. 하필 `back/dev` · `front/dev` 는 BE·FE 가 앞으로 실제로 쓸 갈래다.
   *
   * 🔴 셋 다 없으면 **시끄럽게 경고하고 통과시킨다(exit 0).**
   *
   *    "도구를 못 찾은 것" 과 "검사가 실패한 것" 은 다르다. 도구가 있는데 선점을
   *    안 했으면 반드시 막아야 하지만, 도구를 못 찾은 것은 설치 문제다. 설치 문제로
   *    **선점과 무관한 커밋까지 전부 막으면** 사람은 `--no-verify` 를 쓰기 시작하고,
   *    그 습관은 훅이 고쳐진 뒤에도 남는다. 그때는 진짜로 아무것도 안 막힌다.
   *    `ax_inbox` 의 "없는 것과 못 읽은 것은 다르다" 와 같은 결이다.
   *
   *    ⚠ 다만 **CI 가 대신 잡아 준다고 말하지 않는다.** 팀 저장소의 `claims` 잡은
   *      `merge_request_event` 에서만 돌고 `changes:` 목록에 든 폴더만 본다.
   *      dev 브랜치 직접 push 와 목록 밖 폴더는 그물 밖이다. 그래서 여기서 할 수
   *      있는 것은 **조용히 넘어가지 않는 것**뿐이고, 문구는 그 사실만 말한다.
   *      (그물을 넓히는 것은 `.gitlab-ci.yml` 쪽 일이라 여기서 처리하지 않는다.)
   */
  const body = `#!/bin/sh
# axMap - claim 하지 않은 파일의 커밋을 막는다.
# 경로를 하나만 박지 않는다 — 저장소가 갈래마다 axMap 을 다른 자리에 두기 때문이다
# (ci/axmap · axmap · bin 세 배치). 자세한 근거는 bin/axmap.mjs 의 cmdHookInstall.
AX="${self}"
if [ ! -f "$AX" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || ROOT=""
  for p in "$ROOT/ci/axmap/bin/axmap.mjs" "$ROOT/axmap/bin/axmap.mjs" "$ROOT/bin/axmap.mjs"; do
    if [ -f "$p" ]; then AX="$p"; break; fi
  done
fi
if [ ! -f "$AX" ]; then
  echo "" >&2
  echo "  !!  axMap: 검사 도구를 찾지 못했습니다." >&2
  echo "      이 커밋은 선점 검사를 거치지 않았습니다." >&2
  echo "      고치려면 - node <axmap 위치>/bin/axmap.mjs hook install" >&2
  echo "" >&2
  exit 0
fi
exec node "$AX" verify
`

  /**
   * 🔴 `pre-commit` 하나로는 부족하다.
   *
   * git 은 **자동 머지 커밋에 `pre-commit` 을 부르지 않는다.** `pre-merge-commit`
   * 을 부른다. 그래서 훅을 설치해도 이 경로가 통째로 열려 있었다 —
   *
   *   git commit           막힘 (pre-commit)
   *   git commit -m … 후
   *   git merge <브랜치>   **안 막힘** → 남의 영역이 main 으로 들어오고 push 까지 된다
   *
   * 실제로 재현됐다. claim 이 0건인 에이전트가 `--no-verify` 로 브랜치에 커밋한 뒤
   * merge 하면 무단 변경이 main 에 올라간다.
   *
   * `git merge` 가 충돌 없이 자동 커밋할 때는 `pre-merge-commit` 이,
   * 충돌을 사람이 풀고 `git commit` 할 때는 `pre-commit` 이 돈다. 둘 다 걸어야 한다.
   *
   * cherry-pick·revert·rebase 는 내부적으로 `git commit` 경로를 타므로
   * `pre-commit` 으로 덮인다. `--no-verify` 는 여전히 우회할 수 있고,
   * 그건 훅의 본질적 한계라 문서에 남긴다 (SPEC §7).
   */
  const installed = []
  for (const name of ['pre-commit', 'pre-merge-commit']) {
    const file = path.join(hooks, name)
    fs.writeFileSync(file, body)
    try {
      fs.chmodSync(file, 0o755)
    } catch {
      /* 윈도우에서는 무시 */
    }
    installed.push(file)
  }
  for (const f of installed) console.log(`훅 설치 완료: ${f}`)
  console.log('  (merge 로 남의 영역이 들어오는 경로까지 막습니다)')
}

// ---------------------------------------------------------------------------
// 명령: setup  (배포판으로 들어온 사람의 첫 한 줄)
// ---------------------------------------------------------------------------

/**
 * 설치 전체를 `tools/setup.mjs` 에 넘긴다.
 *
 * 🔴 **import 하지 않고 spawn 한다.** 이유가 둘이다.
 *
 *   1. `tools/setup.mjs` 는 설치기를 부르느라 `app/lib/agentcli.mjs` 계열까지
 *      끌고 온다. 여기서 static import 를 걸면 그 전부가 `src/closure.mjs` 의
 *      import 그래프에 잡혀 **팀 저장소의 `ci/axmap/` 사본이 통째로 불어난다.**
 *      사본은 CI 가 판정에 쓰는 파일만 담기로 한 자리다.
 *   2. 설치는 판정이 아니다. 실패해도 CLI 의 나머지가 멈출 이유가 없다.
 *
 * 그 대가로 **사본에는 이 파일이 없다.** 없을 때 조용히 실패하지 않고, 왜 없는지와
 * 무엇을 대신 하면 되는지를 말한다 — 이 저장소가 `tools/bus.mjs` 로 한 번 겪은
 * 실패다(사본에 빠져 있는데 오류만 났다).
 */
/**
 * 딸린 프로그램들. **이름을 경로로 바꿔 주는 것이 전부다.**
 *
 * 🔴 원래는 파일 경로로 불렀다 — `node axmap/governance/gate.mjs`. 저장소 안에
 *    사본을 두고 쓸 때는 그게 됐다. 사본의 자리를 팀이 알고 있었기 때문이다.
 *    **npm 으로 설치하면 그 경로가 기계마다 다르다.** 그래서 팀의 CI 설정과
 *    슬래시 명령이 경로를 박아 둘 수밖에 없었고, 경로가 박혀 있는 한 사본을
 *    지울 수 없었다. 여기 이름이 하나 생길 때마다 박힌 경로가 하나 사라진다.
 *
 * 값은 [파일, 한 줄 설명] 이다. 설명은 HELP 와 오류 메시지가 같이 쓴다 —
 * 두 군데 적으면 한 쪽만 고쳐지는 날이 온다.
 */
const RUNNERS = {
  gate: ['governance/gate.mjs', '이 MR 이 정족수를 채웠는가'],
  vote: ['governance/vote.mjs', '표를 던진다'],
  bus: ['tools/bus.mjs', '에이전트 사이 쪽지함'],
  'mr-target': ['tools/mr-target.mjs', '이 브랜치가 저 브랜치로 갈 수 있는가'],
  version: ['tools/version.mjs', '브랜치 단계로 다음 버전을 정한다'],
  promote: ['tools/promote.mjs', '한 단계 위로 올리는 MR 을 만든다'],
  mcp: ['mcp/server.mjs', 'AI 도구가 붙는 서버를 띄운다'],
  setup: ['tools/setup.mjs', '이 PC 와 이 저장소에 axMap 을 붙인다'],
}

function cmdRun(name) {
  const [rel, what] = RUNNERS[name]
  const script = path.join(SELF_ROOT, ...rel.split('/'))
  if (!fs.existsSync(script)) {
    die(
      `이 axMap 에는 ${name}(${what})이 들어 있지 않습니다: ${script}\n\n` +
        (isVendored(SELF_ROOT)
          ? `  여기는 팀 저장소 안의 **벤더링된 사본**입니다(옆에 SOURCE.json 이 있습니다).\n` +
            `  사본에는 CI 가 판정에 쓰는 파일만 들어 있습니다.\n\n` +
            `  배포판으로 부르세요:\n    npx -y ${PACKAGE_NAME}@latest ${name}`
          : `  꾸러미가 온전하지 않습니다. 다시 받으세요:\n    npx -y ${PACKAGE_NAME}@latest ${name}`),
    )
  }
  // 인자는 그대로 넘긴다. 여기서 다시 해석하면 두 곳의 플래그 목록이 어긋난다.
  //
  // 🔴 명령 이름은 **처음 나온 것 하나만** 뗀다. 전부 지우면 같은 낱말이 값으로
  //    올 때 그 값까지 사라진다 — `axmap bus post --subject vote` 의 "vote".
  const argv = process.argv.slice(2)
  const at = argv.indexOf(name)
  if (at >= 0) argv.splice(at, 1)
  const r = spawnSync(process.execPath, [script, ...argv], { stdio: 'inherit', windowsHide: true })
  process.exit(r.status ?? 1)
}

// ---------------------------------------------------------------------------
// 명령: update  (새 버전이 있는지 묻는다. 바꾸지는 않는다)
// ---------------------------------------------------------------------------

/**
 * 🔴 **확인만 하고 아무것도 갈아치우지 않는다.**
 *
 * 사람이 모르는 사이에 도구가 바뀌면 어제 되던 것이 오늘 안 되고, 원인을 찾을
 * 실마리가 없다 — 바뀐 것이 자기 코드가 아니기 때문이다. 그래서 적용은 사람이
 * 아래에 찍히는 한 줄을 직접 실행하는 것으로만 일어난다.
 *
 * 종료 코드: 0 물어봤다 (최신이든 아니든) · 1 못 물어봤다
 *
 * 🔴 **이 명령만은 `process.exit()` 로 끝내지 않는다 (2026-09-10).**
 *
 *    레지스트리에 묻는 순간 fetch 가 소켓을 연다. 답을 다 읽은 뒤에도 그 소켓은
 *    아직 **닫히는 중**이고, 그 상태에서 `process.exit()` 를 부르면 Windows 의
 *    node 가 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 로 스스로
 *    중단한다. 화면에는 "최신입니다" 가 이미 찍힌 뒤라 **사람 눈에는 정상인데
 *    종료 코드가 127** 이다. 판정을 종료 코드로 하는 이 저장소에서 그건 조용한
 *    실패고, 이 명령을 검사에 넣는 순간 언제나 빨개진다.
 *
 *    한 틱 미루는 것(`setImmediate`)으로는 안 된다 — 재봤을 때 똑같이 죽었다.
 *    이벤트 루프가 실제로 비워질 때까지 기다려야 한다. 그래서 `process.exitCode`
 *    만 세우고 돌아간다. 느려지지 않는다 (둘 다 230ms 안쪽이었다).
 */
async function cmdUpdate(flags) {
  const current = selfVersion()

  // 사본은 npm 이 아니라 tools/vendor.mjs 가 갱신한다. 여기서 레지스트리를 치면
  // 팀 CI 가 매번 바깥 네트워크에 의존하게 되고, 안내를 받은 팀원이 할 수 있는
  // 일도 없다 (사본은 axMap 저장소에서 vendor.mjs 를 다시 돌려야 바뀐다).
  if (isVendored(SELF_ROOT)) {
    console.log('')
    console.log('여기는 팀 저장소 안의 벤더링된 사본입니다 (옆에 SOURCE.json 이 있습니다).')
    console.log('사본은 npm 이 아니라 axMap 저장소의 tools/vendor.mjs 가 갱신합니다.')
    console.log('')
    console.log('  사본이 온전한지:  node ci/verify-vendor.mjs')
    console.log('  어느 커밋의 사본인지:  ci/axmap/SOURCE.json')
    console.log('')
    process.exit(0)
  }

  const registry = registryUrl()
  console.log('')
  console.log(`지금 버전: ${current ?? '(모름)'}`)
  console.log(`묻는 곳:   ${registry}/${PACKAGE_NAME}`)

  let latest = null
  try {
    latest = await fetchLatest({ registry })
  } catch (e) {
    console.error('')
    console.error(`새 버전을 확인하지 못했습니다: ${e.message}`)
    console.error('네트워크가 안 되거나, 아직 배포된 적이 없는 꾸러미일 수 있습니다.')
    console.error('')
    process.exitCode = 1
    return
  }

  writeCache({ latest, current, checkedAt: Date.now(), registry })

  const notice = noticeLine(current, latest)
  console.log(`최신 버전: ${latest}`)

  // 🔴 **훅이 부르는 사본도 같이 본다 (2026-09-12).**
  //
  //    판이 이 PC 에 **두 군데** 있다. `axmap` 명령(전역 설치)과 git 훅이 부르는
  //    사본(`~/.axmap/app`)이다. `npm i -g` 는 앞의 것만 올리고 뒤의 것은 `setup`
  //    이 올린다 — 서로 안 따라간다.
  //
  //    그런데 이 명령은 **자기 판만 보고** "최신입니다" 라고 답했다. 훅이 부르는
  //    사본이 옛 판인데도 그랬다. 막는 것보다 나쁘다 — **괜찮다고 말하고 넘어간다.**
  //    실측 (2026-09-12): `npm i -g` 로 전역이 1.2.3 이 된 직후 이 명령이
  //    "최신입니다" 라고 했는데 훅이 부르는 사본은 1.2.2 였다.
  const installed = installedAppVersion()
  const skewed = Boolean(installed && current && installed !== current)
  if (skewed) {
    console.log('')
    console.log(`🔴 git 훅이 부르는 사본은 아직 ${installed} 입니다 (이 명령은 ${current}).`)
    console.log('   둘은 따로 움직입니다 — 전역은 `npm i -g`, 사본은 `axmap setup` 이 올립니다.')
    console.log('')
    console.log('   맞추려면:  axmap setup')
  }

  console.log('')
  if (notice) {
    for (const l of notice.split('\n')) console.log(l)
    console.log('')
    console.log('  🔴 저절로 바뀌지 않습니다. 위 명령을 직접 실행할 때만 바뀝니다.')
  } else if (skewed) {
    // 여기서 "최신입니다" 라고 말하면 거짓이 된다. 이 PC 의 실력은 **가장 낡은 것**이다.
    console.log('레지스트리 기준으로는 최신이지만, 위 사본이 아직 안 맞습니다.')
  } else {
    console.log('최신입니다.')
  }
  console.log('')
}

/**
 * git 훅이 실제로 부르는 사본(`~/.axmap/app`)의 판. 없거나 못 읽으면 `null`.
 *
 * 🔴 **`selfVersion()` 과 다른 것을 본다.** `selfVersion()` 은 *"지금 이 코드"* 의
 *    판이고, 이 함수는 *"커밋할 때마다 실제로 도는 코드"* 의 판이다. 둘이 갈릴 수
 *    있다는 것이 이 PC 구조의 사실이므로, 하나만 보고 답하면 거짓말이 된다.
 *
 * 🔴 자리를 여기서 새로 정하지 않는다 — `stateDir()` 을 쓴다. 그래야
 *    `AXMAP_STATE_DIR` 이 여기에도 걸린다. 그 환경변수가 있는 이유가
 *    `src/repotarget.mjs` 에 적혀 있다 — *"테스트가 사람의 작업 환경을 고치는
 *    것은 어떤 이유로도 정당하지 않다."* `os.homedir()` 를 직접 부르면 이 명령의
 *    출력이 **돌리는 사람의 PC 상태에 따라 달라지고**, 그러면 시험이 사람마다
 *    다른 답을 낸다 (실제로 그렇게 깨졌다).
 *
 * 🔴 못 읽으면 `null` 을 돌려 **아무 말도 안 한다.** 사본을 안 쓰는 설치도 있고
 *    (팀 저장소 안의 벤더링 사본은 위에서 이미 걸러진다), 없는 것을 낡았다고
 *    말하면 그 경고는 곧 아무도 안 읽는 잡음이 된다.
 */
function installedAppVersion() {
  try {
    const p = path.join(stateDir(), 'app', 'package.json')
    return JSON.parse(fs.readFileSync(p, 'utf8'))?.version ?? null
  } catch {
    return null
  }
}

/**
 * 마지막으로 물어본 결과가 "새 버전이 있다" 였으면 **stderr 에** 한 줄 알린다.
 *
 * 🔴 여기서 네트워크를 치지 않는다. 도구를 부를 때마다 레지스트리를 기다리면
 *    선점이 느려지고, 그건 확인 편의보다 훨씬 나쁘다. 캐시는 `axmap update` 와
 *    `axmap setup` 이 채운다.
 *
 * 🔴 stdout 이 아니라 stderr 다. stdout 은 `--json` 이 쓰는 자리라, 사람이 읽는
 *    글을 섞으면 그 출력을 파싱하는 쪽이 조용히 깨진다.
 */
function warnIfStale() {
  if (checkDisabled() || isVendored(SELF_ROOT)) return
  const cache = readCache()
  if (!cache) return
  const notice = noticeLine(selfVersion(), cache.latest)
  if (notice) console.error(`\n${notice}\n`)
}

// ---------------------------------------------------------------------------

const HELP = `axmap - AI 에이전트 작업 선점 프로토콜

  axmap setup                        이 PC 와 이 저장소에 axMap 을 붙인다 (첫 한 번)
                                        [--remote <이름|git 주소>] [--name] [--dry-run]
  axmap init                         장부(고아 브랜치 + worktree)를 준비한다
  axmap bus-repair                   쪽지함만 준비한다 (장부는 안 건드린다)
                                     쪽지를 읽다가 "쪽지함을 못 열었습니다" 를 봤을 때
  axmap users-repair                 사람별 상태(어디까지 읽었나)만 준비한다
  axmap claim <경로...>              경로를 선점한다  [--task --intent --ttl 30m]
  axmap release [경로...]            반납한다 (경로 생략 시 이 세션이 잡은 것 전부)
                                        [--all-sessions  같은 이름의 다른 창이 잡은 것까지]
  axmap renew                        TTL 을 연장한다  [--ttl 30m]
                                     claim·release·renew 는 [--session <id>]
  axmap status                       누가 무엇을 잡고 있는지  [--json]
  axmap verify                       staged 파일이 내 claim 안에 있는지 검사
  axmap audit                        장부 이력 전체를 재생해 상호배제 위반을 사후 증명
                                        [--json] [--fetch] [--code <구간>]
                                        [--checkpoint  통과하면 "여기까지 봤다" 를 남긴다]
  axmap doctor                       이 PC 에서 선점이 실제로 도는지 점검  [--json]
  axmap hook install                 verify 를 pre-commit 훅으로 설치
  axmap update                       새 버전이 있는지 묻는다 (바꾸지는 않는다)
  axmap --version                    지금 도는 판 번호를 찍는다 (아래 version 명령과 다르다)

딸린 프로그램 — 예전에는 파일 경로로 불렀다. 이제 이름으로 부른다.
인자는 그대로 전달되고, 각각의 사용법은 그 프로그램이 답한다.

  axmap gate                         이 MR 이 정족수를 채웠는가 (CI 가 부른다)
  axmap vote                         표를 던진다
  axmap bus                          에이전트 사이 쪽지함 (post · list · read · reply)
  axmap mr-target                    이 브랜치가 저 브랜치로 갈 수 있는가
  axmap version                      브랜치 단계로 다음 버전을 정한다
  axmap promote                      한 단계 위로 올리는 MR 을 만든다
  axmap mcp                          AI 도구가 붙는 서버를 띄운다 (직접 부를 일은 없다)

에이전트 이름: --agent 또는 AXMAP_AGENT, 없으면 git config user.name
세션 id     : --session 또는 AXMAP_SESSION, 없으면 CLAUDE_CODE_SESSION_ID
              레코드는 이름당 하나가 아니라 (이름, 세션) 짝마다 하나다. 그래서
              한 PC 의 창 둘이 서로를 덮지 않고, release 도 이 세션이 잡은 것만 푼다.
              다른 창이 두고 간 것까지 풀려면 release --all-sessions.
장부 원격:     --remote 또는 AXMAP_REMOTE, 없으면 git config axmap.remote
`

const { positional, flags } = parseArgs(process.argv.slice(2))
const [cmd, ...rest] = positional

/**
 * 🔴 `--version` 은 명령이 아니라 **깃발**이라 아래 switch 에 안 걸린다.
 *    그대로 default 로 떨어져 **도움말을 찍고 종료 코드 0** 을 냈다. 팀 CI 가
 *    "어느 판이 돌았는지" 를 남기려고 넣은 줄이 조용히 쓸모없어졌고, 0 이라
 *    아무도 못 알아챘다 (실측 2026-09-01, 팀 저장소 .gitlab-ci.yml eb3b56d).
 *
 * 🔴 `version` **명령과는 다른 것을 답한다.** 저쪽(tools/version.mjs)은
 *    `process.cwd()` 의 git 태그를 읽는 도구라, 남의 저장소에서 부르면 그
 *    저장소의 버전이 나온다. 여기가 답해야 하는 것은 "지금 도는 axMap 이 몇
 *    판인가" 이고, 그 답은 설치본 자기 package.json 에만 있다.
 *
 *    못 읽으면 죽는다. 모르는 것을 빈 줄로 내면 CI 로그에는 "판을 확인했다" 는
 *    흔적만 남고 실제로는 아무것도 확인되지 않는다.
 */
if (boolFlag(flags.version, 'version') && !cmd) {
  const v = selfVersion()
  if (!v) die('버전을 알 수 없습니다 - package.json 이 없는 사본입니다.')
  console.log(v)
  process.exit(0)
}

switch (cmd) {
  // 이름을 경로로 바꿔 주는 것들 (RUNNERS). 인자는 손대지 않고 그대로 간다.
  case 'setup':
  case 'gate':
  case 'vote':
  case 'bus':
  case 'mr-target':
  case 'version':
  case 'promote':
  case 'mcp':
    cmdRun(cmd)
    break
  case 'update':
    // 이 파일은 ESM 이라 최상위 await 이 된다. update 만 비동기다 (레지스트리에 묻는다).
    await cmdUpdate(flags)
    break
  case 'init':
    cmdInit(flags)
    break
  case 'bus-repair':
    cmdBusRepair()
    break
  case 'users-repair':
    cmdUsersRepair()
    break
  case 'claim':
    cmdClaim(rest, flags)
    break
  case 'release':
    cmdRelease(rest, flags)
    break
  case 'renew':
    cmdRenew(flags)
    break
  case 'status':
    cmdStatus(flags)
    // 캐시에 "새 버전이 있다" 가 적혀 있으면 stderr 로 한 줄. 네트워크는 안 친다.
    warnIfStale()
    break
  case 'verify':
    cmdVerify(flags)
    break
  case 'audit':
    cmdAudit(flags)
    break
  case 'doctor':
    cmdDoctor(flags)
    break
  case 'hook':
    if (rest[0] === 'install') cmdHookInstall()
    else die(HELP)
    break
  default:
    console.log(HELP)
    process.exit(cmd ? 1 : 0)
}
