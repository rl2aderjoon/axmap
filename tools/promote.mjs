#!/usr/bin/env node
/**
 * 승격 봇 — 정해진 주기로 브랜치를 한 칸씩 올리는 실행기.
 *
 *   node axmap/tools/promote.mjs --step dev-to-part  [--dry-run]   하루 한 번
 *   node axmap/tools/promote.mjs --step part-to-main [--dry-run]   주 한 번
 *
 * 판정은 전부 순수 함수에 있다. 여기는 **GitLab API 와 git 과 출력**만 담당한다.
 *
 *   짝 만들기   `src/promote.mjs`      의 planPromotions (그 안에서 checkTarget)
 *   정족수      `governance/gate.mjs`  을 자식 프로세스로 부르고 종료 코드를 본다
 *
 * ── 🔴 이 파일의 핵심 요구: 머지에 sha 를 반드시 싣는다 ──────────────────────
 *
 * 표(찬성표)는 **커밋 하나에 묶여 있다** (governance/GOVERNANCE.md 의 G3).
 * 정족수를 판정한 뒤 머지하기까지는 아무리 짧아도 창(window)이 열려 있고, 그
 * 사이에 누가 소스 브랜치에 커밋을 하나 더 올리면 **표가 없는 커밋이 봇의 손으로
 * 머지된다.**
 *
 * 그래서 머지 호출에 `sha`(= 정족수를 판정할 때 쓴 그 커밋)를 함께 보낸다. GitLab
 * 은 그 값이 지금 MR 헤드와 다르면 **409 로 거부한다.** 이것이 CAS(**Compare-And-
 * Swap** — "내가 읽은 뒤로 바뀐 게 없을 때만 쓴다". git push 가 원래 이렇게
 * 동작한다)다.
 *
 * 🔴 409 를 받으면 **재시도하지 않는다.** 409 는 고장이 아니라 "내용이 바뀌었다"
 *    는 뜻이고, 바뀐 내용은 새로 표를 받아야 한다. 다시 걸면 봇이 새 커밋을
 *    옛 표로 머지하게 되고, 그게 정확히 sha 로 막으려던 사고다.
 *
 * 🔴 같은 이유로 merge_when_pipeline_succeeds(**파이프라인이 초록이 되면 나중에
 *    자동으로 머지**) 를 쓰지 않는다. 그건 판정 시점과 머지 시점을 벌려 놓는
 *    장치이고, 벌어진 그 사이가 정확히 위 사고가 나는 자리다.
 *
 * ── 토큰이 없으면 ────────────────────────────────────────────────────────────
 *
 * `.gitlab-ci.yml` 의 version 잡과 같은 태도다. 조용히 건너뛰지 않고, 무엇을
 * 했을지 계산해서 찍고, 설정하는 법을 안내하고 종료 코드 0 으로 끝낸다.
 * **승격이 안 되고 있는 것을 아무도 모르는 상태가 제일 나쁘다.**
 *
 * ── 종료 코드 ────────────────────────────────────────────────────────────────
 *
 *   0  할 일을 다 했다 (아무것도 안 한 것, 표 부족으로 건너뛴 것 포함)
 *   1  판정 불가 · API 오류 · 설정 오류
 *   4  정책 자체가 깨짐 (게이트에서 그대로 올라온다)
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { planPromotions, formatPlan, describeStep, mergeCommitMessage, STEPS } from '../src/promote.mjs'

/** 이 도구의 종료 코드. */
export const EXIT = { OK: 0, ERROR: 1, POLICY_BROKEN: 4 }

/** 게이트의 종료 코드. `src/governance.mjs` 의 EXIT 과 같은 값이다. */
const GATE = { OK: 0, UNDECIDABLE: 1, SHORT: 2, POLICY_BROKEN: 4 }

/** `axmap/` 폴더. **프로그램**을 찾을 때만 쓴다 (옆에 있는 gate.mjs 같은 것). */
const AXMAP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 🔴 git 은 **서 있는 저장소**에서 부른다. 프로그램이 있는 폴더가 아니다.
 *    npm 으로 설치하면 그 폴더는 `node_modules/axmap-cli/` 이고 저장소가 아니다.
 *    근거는 tools/version.mjs 의 같은 자리 주석.
 */
const REPO = process.cwd()

// ---------------------------------------------------------------------------
// 인자 — `--k v` · `--k=v` · `--k`(=true). gate.mjs 의 parseArgs 와 같은 규칙.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i]
    else flags[a.slice(2)] = true
  }
  return flags
}

/** 플래그 값이 **문자열일 때만** 쓴다. `--step` 만 주면 값은 true 다. */
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

const HELP = `승격 봇 — 정해진 주기로 브랜치를 한 칸씩 올린다

  node axmap/tools/promote.mjs --step dev-to-part  [--dry-run]
  node axmap/tools/promote.mjs --step part-to-main [--dry-run]

  --step       dev-to-part  = <파트>/dev  -> <파트>/main   (하루 한 번)
               part-to-main = <파트>/main -> 최상위 main   (주 한 번)
  --dry-run    아무것도 만들지도 머지하지도 않는다. 무엇을 할지만 찍는다
  --project    GitLab 프로젝트 ID 또는 경로. 없으면 CI_PROJECT_ID
  --api        GitLab API 주소. 없으면 CI_API_V4_URL, 그것도 없으면 CI_SERVER_URL/api/v4

  🔴 플래그가 환경변수를 이긴다.
  🔴 토큰은 플래그로 받지 않는다. 명령줄에 적으면 셸 기록과 프로세스 목록에 남는다.
     AXMAP_BOT_TOKEN 환경변수에 넣는다.

종료 코드
  0  할 일을 다 했다 (아무것도 안 한 것 · 표 부족으로 건너뛴 것 포함)
  1  판정 불가 · API 오류 · 설정 오류
  4  정책 자체가 깨짐
`

const TOKEN_HELP = [
  '설정하려면: Settings -> Access Tokens 에서 Role=Maintainer, scope=api 로 토큰을',
  '만들고 Settings -> CI/CD -> Variables 의 AXMAP_BOT_TOKEN (Masked + Protected)',
  '에 붙여넣습니다.',
  '',
  'version 잡은 태그를 push 하는 것뿐이라 write_repository 로 충분했지만, 여기는',
  'MR 을 만들고 머지하므로 api 가 필요합니다.',
  '',
  '🔴 AXMAP_BOT_TOKEN 을 Protected 로 두면 보호 브랜치에서 도는 잡에만 값이 갑니다.',
  '   이 봇이 도는 스케줄 파이프라인의 브랜치가 보호 브랜치가 아니면 토큰이 빈 채로',
  '   여기까지 와서 초록으로 끝납니다 — 지금 보고 있는 이 메시지가 그 상태일 수 있습니다.',
].join('\n')

// ---------------------------------------------------------------------------
// 바깥 세계 — 기본 구현. 테스트는 전부 주입해서 갈아 끼운다.
// ---------------------------------------------------------------------------

/**
 * git 한 번. 훅이 심어 놓는 `GIT_*` 를 지우는 것은 `governance/gate.mjs` 와 같은
 * 이유다 — 남아 있으면 다른 저장소·다른 인덱스를 가리킨 채로 읽는다.
 */
function defaultGit(args) {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) delete env[k]
  const r = spawnSync('git', args, { cwd: REPO, env, encoding: 'utf8', windowsHide: true })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/**
 * 정족수 게이트를 **자식 프로세스로** 부른다.
 *
 * 🔴 judge() 를 직접 부르지 않는 이유: 게이트는 정책을 **타깃 브랜치의 커밋에서**
 *    읽고(G2) 표를 `axmap/votes` 에서 모은다. 그 재료 수집을 여기서 다시 구현하면
 *    CI 의 게이트와 봇의 게이트가 서로 다르게 판정할 수 있다. 부르는 쪽은 종료
 *    코드만 본다 — 게이트의 계약이 곧 종료 코드다.
 *
 * `--json` 을 붙이면 판정문은 stderr, 기계가 읽을 판정은 stdout 으로 나온다.
 * 우리가 stdout 에서 꺼내는 것은 **판정에 쓴 커밋(sha)** 하나다.
 */
function defaultGate({ source, target }) {
  const r = spawnSync(
    process.execPath,
    [path.join(AXMAP, 'governance', 'gate.mjs'), '--source', source, '--target', target, '--json'],
    { cwd: REPO, encoding: 'utf8', windowsHide: true },
  )
  let verdict = null
  try { verdict = JSON.parse(r.stdout ?? '') } catch { verdict = null }
  return {
    exit: r.status ?? GATE.UNDECIDABLE,
    sha: verdict && typeof verdict.sha === 'string' ? verdict.sha : null,
    text: (r.stderr ?? '').trim(),
  }
}

// ---------------------------------------------------------------------------
// GitLab API
// ---------------------------------------------------------------------------

class ApiError extends Error {}

/**
 * PRIVATE-TOKEN 헤더로 부르는 GitLab REST 호출 하나.
 *
 * 4xx·5xx 를 던지지 않고 그대로 돌려준다 — 409 는 **정상적인 답**(내용이 바뀌었다)
 * 이라 부르는 쪽이 상태 코드를 보고 갈라야 하기 때문이다. 네트워크가 아예 안 되는
 * 것만 던진다.
 */
function makeGitlab({ fetchImpl, api, project, token }) {
  const base = `${String(api).replace(/\/+$/, '')}/projects/${encodeURIComponent(project)}`
  return async function call(method, pathname, { query, body } = {}) {
    const url = new URL(base + pathname)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v))
    const headers = { 'PRIVATE-TOKEN': token, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let res
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (e) {
      throw new ApiError(`${method} ${url.pathname} — GitLab 에 닿지 못했습니다: ${e.message}`)
    }
    const text = typeof res.text === 'function' ? await res.text() : ''
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    const status = Number(res.status)
    return { status, ok: status >= 200 && status < 300, json, text }
  }
}

/** 실패한 응답을 사람이 읽는 한 줄로. GitLab 은 대개 {"message": ...} 를 준다. */
function apiWhy(r) {
  const m = r.json && (r.json.message ?? r.json.error)
  const s = m ? (typeof m === 'string' ? m : JSON.stringify(m)) : (r.text || '').slice(0, 200)
  return `HTTP ${r.status}${s ? ` — ${s}` : ''}`
}

/**
 * 프로젝트의 브랜치 이름 전부. 한 쪽(page)이 꽉 차면 다음 쪽을 더 읽는다.
 *
 * 못 읽고 넘어가는 브랜치가 있으면 **승격이 덜 일어나는 쪽**으로 틀린다. 그건
 * 안전한 방향이라 멈추지 않는다 — 게이트가 표를 덜 세는 쪽으로 기우는 것과 같은
 * 판단이다.
 */
async function listBranches(gl, { perPage = 100, maxPages = 20 } = {}) {
  const names = []
  for (let page = 1; page <= maxPages; page++) {
    const r = await gl('GET', '/repository/branches', { query: { per_page: perPage, page } })
    if (!r.ok) throw new ApiError(apiWhy(r))
    if (!Array.isArray(r.json)) throw new ApiError('브랜치 목록이 배열이 아닙니다')
    for (const b of r.json) if (b && typeof b.name === 'string') names.push(b.name)
    if (r.json.length < perPage) break
  }
  return names
}

// ---------------------------------------------------------------------------
// 토큰이 없을 때 쓰는 로컬 재료 (git)
// ---------------------------------------------------------------------------

/** bin/axmap.mjs · governance/gate.mjs 와 같은 순서로 원격을 고른다. */
function resolveRemote(git) {
  const all = git(['remote']).out.split('\n').map((s) => s.trim()).filter(Boolean)
  const cfg = git(['config', '--get', 'axmap.remote']).out
  if (cfg && all.includes(cfg)) return cfg
  if (all.length === 1) return all[0]
  if (all.includes('origin')) return 'origin'
  return null
}

/**
 * 로컬에서 본 브랜치 목록과, 이름 하나를 ref 로 바꾸는 함수.
 *
 * 원격 추적 ref(**원격에서 마지막으로 받아온 상태를 가리키는 ref**)를 먼저 본다.
 * 봇이 올리는 것은 언제나 원격의 브랜치이지 내 작업 트리가 아니다.
 */
function localRefs(git) {
  const remote = resolveRemote(git)
  if (remote) {
    const prefix = `refs/remotes/${remote}/`
    const r = git(['for-each-ref', '--format=%(refname)', prefix])
    if (r.code === 0 && r.out) {
      const names = r.out.split('\n').map((s) => s.trim()).filter(Boolean)
        .map((s) => s.slice(prefix.length))
        // origin/HEAD 는 브랜치가 아니라 기본 브랜치를 가리키는 심볼릭 ref 다.
        .filter((n) => n && n !== 'HEAD')
      if (names.length) return { label: `${remote}/* (원격 추적 ref)`, names, ref: (n) => `${remote}/${n}` }
    }
  }
  const l = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  const names = l.code === 0 && l.out ? l.out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  return { label: '로컬 브랜치 (원격 추적 ref 가 없습니다)', names, ref: (n) => n }
}

/** 타깃에 없는 커밋 수. 셀 수 없으면 null — 0 으로 치지 않는다. */
function aheadLocal(git, refOf, source, target) {
  const r = git(['rev-list', '--count', `${refOf(target)}..${refOf(source)}`])
  if (r.code !== 0) return null
  const n = Number(r.out)
  return Number.isInteger(n) ? n : null
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

/** 커밋 해시처럼 생겼는가. 표는 커밋 하나에 묶이므로 이게 없으면 머지하지 않는다. */
const looksLikeSha = (s) => typeof s === 'string' && /^[0-9a-f]{7,64}$/i.test(s)

/** 표가 몇 장 모자란지 한 줄로. 게이트의 판정문에서 그 줄만 꺼낸다. */
function shortLine(verdict) {
  const line = (verdict.text ?? '').split('\n').find((l) => l.includes('합의 미달'))
  return line ? line.trim() : '유효 찬성이 문턱에 못 미칩니다'
}

/** 봇이 연 MR 의 본문. 사람이 이 MR 을 왜 봐야 하는지가 첫 줄에 있어야 한다. */
function promotionBody({ source, target, step, ahead }) {
  return [
    `승격 봇이 연 MR 입니다 — ${describeStep(step)}`,
    '',
    `- 올리는 것: \`${source}\` -> \`${target}\` (커밋 ${ahead}개)`,
    '- 봇은 **정족수(통과에 필요한 최소 찬성 수)가 찰 때까지 머지하지 않습니다.**',
    '  표를 주려면: `node axmap/governance/vote.mjs` (근거는 axmap/governance/GOVERNANCE.md)',
    '',
    '머지할 때 봇은 정족수를 판정한 그 커밋의 sha 를 함께 보냅니다. 그 사이에 새 커밋이',
    '올라오면 GitLab 이 머지를 거부하고, 봇은 재시도하지 않습니다 — 새 커밋은 새로 표를',
    '받아야 하기 때문입니다.',
  ].join('\n')
}

/**
 * @param {string[]} argv 플래그들 (`process.argv.slice(2)`)
 * @param {object} io 바깥 세계. 테스트는 전부 갈아 끼운다
 * @returns {Promise<number>} 종료 코드. **여기서 process.exit 을 부르지 않는다** —
 *   부르면 테스트가 자기 프로세스를 죽인다.
 */
export async function run(argv, io = {}) {
  const env = io.env ?? process.env
  const fetchImpl = io.fetch ?? globalThis.fetch
  const git = io.git ?? defaultGit
  const gate = io.gate ?? defaultGate
  const log = io.log ?? ((s) => console.log(s))
  const warn = io.warn ?? ((s) => console.error(s))

  const flags = parseArgs(argv)
  if (flags.help || flags.h) { log(HELP); return EXIT.OK }

  const step = str(flags.step)
  if (!step || !STEPS.includes(step)) {
    warn(`--step 을 주세요: ${STEPS.join(' | ')}`)
    warn('')
    warn('  추측하지 않는 이유: 주기를 잘못 고르면 하루치 검토밖에 안 지난 것이')
    warn('  최상위 main 으로 올라갑니다.')
    return EXIT.ERROR
  }
  const dryRun = flags['dry-run'] === true || flags['dry-run'] === 'true'

  const token = str(env.AXMAP_BOT_TOKEN)
  const project = str(flags.project) ?? str(env.CI_PROJECT_ID)
  const api = str(flags.api) ?? str(env.CI_API_V4_URL)
    ?? (str(env.CI_SERVER_URL) ? `${str(env.CI_SERVER_URL).replace(/\/+$/, '')}/api/v4` : null)

  // ── 토큰이 없다 — 계산만 하고 안내한다 (version 잡과 같은 태도) ──────────────
  if (!token) {
    if (!dryRun) {
      // 🔴 맨 앞에 온다. 이 줄이 뒤로 밀리면 로그 끝만 보는 사람은 승격이 된 줄 안다.
      log('🔴 AXMAP_BOT_TOKEN 이 없습니다 — 이번 주기에 아무것도 승격되지 않았습니다.')
      log('   아래는 토큰이 있었다면 무엇을 했을지 계산한 것입니다.')
    } else {
      log('AXMAP_BOT_TOKEN 이 없습니다. GitLab 을 부르지 않고 계산만 합니다.')
    }
    log('')
    const refs = localRefs(git)
    log(`브랜치 목록 출처: ${refs.label}`)
    let plan
    try { plan = planPromotions(refs.names, { step }) } catch (e) { warn(e.message); return EXIT.ERROR }
    log('')
    log(formatPlan(plan))
    log('')
    for (const p of plan.pairs) {
      const n = aheadLocal(git, refs.ref, p.source, p.target)
      if (n === null) log(`  ? ${p.source} -> ${p.target}   올릴 것이 몇 개인지 셀 수 없습니다 (ref 를 못 찾았습니다)`)
      else if (n === 0) log(`  - ${p.source} -> ${p.target}   올릴 것이 없습니다. MR 을 만들지 않습니다`)
      else log(`  o ${p.source} -> ${p.target}   커밋 ${n}개를 올렸을 것입니다 (MR 확인 -> 정족수 판정 -> sha 를 실어 머지)`)
    }
    log('')
    log('정족수 판정과 머지는 토큰이 있을 때만 합니다.')
    log('')
    log(TOKEN_HELP)
    return EXIT.OK
  }

  // ── 토큰은 있는데 어디에 걸어야 할지를 모른다 — 이건 설정 오류다 ─────────────
  if (!api || !project) {
    warn('AXMAP_BOT_TOKEN 은 있는데 어느 프로젝트의 어느 API 로 걸어야 할지 모릅니다.')
    warn(`  API      : ${api ?? '(없음)'}   <- --api 또는 CI_API_V4_URL / CI_SERVER_URL`)
    warn(`  프로젝트 : ${project ?? '(없음)'}   <- --project 또는 CI_PROJECT_ID`)
    warn('')
    warn('추측하지 않습니다 — 엉뚱한 프로젝트에 MR 을 만들고 머지하게 됩니다.')
    return EXIT.ERROR
  }

  const gl = makeGitlab({ fetchImpl, api, project, token })

  log(`승격 봇 — ${describeStep(step)}`)
  log(`  프로젝트 : ${project}   (${api})`)
  if (dryRun) log('  --dry-run : 아무것도 만들지도 머지하지도 않습니다')
  log('')

  let worst = EXIT.OK
  /** 판정 불가(1)보다 정책 깨짐(4)을 먼저 낸다 — 저쪽이 무엇을 고쳐야 하는지 더 구체적이다. */
  const fail = (code) => { if (code === EXIT.POLICY_BROKEN || worst === EXIT.OK) worst = code }

  let branches
  try {
    branches = await listBranches(gl)
  } catch (e) {
    if (!(e instanceof ApiError)) throw e
    warn(`브랜치 목록을 읽지 못했습니다: ${e.message}`)
    return EXIT.ERROR
  }

  let plan
  try { plan = planPromotions(branches, { step }) } catch (e) { warn(e.message); return EXIT.ERROR }
  log(formatPlan(plan))
  log('')

  const tally = { nothing: 0, created: 0, short: 0, merged: 0, conflict: 0, blocked: 0, failed: 0, planned: 0 }

  for (const pair of plan.pairs) {
    const { source, target } = pair
    const say = (mark, msg) => log(`  ${mark} ${source} -> ${target}   ${msg}`)

    try {
      // 1. 올릴 것이 있나. 없으면 건너뛴다 — 아무 일도 안 한 주에 MR 을 만들지 않는다.
      const cmp = await gl('GET', '/repository/compare', { query: { from: target, to: source } })
      if (!cmp.ok) { say('x', `비교 실패 — ${apiWhy(cmp)}`); tally.failed++; fail(EXIT.ERROR); continue }
      const ahead = Array.isArray(cmp.json?.commits) ? cmp.json.commits.length : null
      if (ahead === null) { say('x', '비교 응답에서 커밋 목록을 찾지 못했습니다'); tally.failed++; fail(EXIT.ERROR); continue }
      if (ahead === 0) { say('-', '올릴 것이 없습니다. MR 을 만들지 않습니다'); tally.nothing++; continue }

      // 2. 열려 있는 MR 이 있나. 없으면 만든다.
      const found = await gl('GET', '/merge_requests', {
        query: { state: 'opened', source_branch: source, target_branch: target, per_page: 100 },
      })
      if (!found.ok) { say('x', `열린 MR 을 찾지 못했습니다 — ${apiWhy(found)}`); tally.failed++; fail(EXIT.ERROR); continue }
      let mr = Array.isArray(found.json) && found.json.length ? found.json[0] : null

      if (!mr) {
        if (dryRun) {
          say('o', `커밋 ${ahead}개 — MR 을 새로 만들었을 것입니다`)
        } else {
          const made = await gl('POST', '/merge_requests', {
            body: {
              source_branch: source,
              target_branch: target,
              title: `승격: ${source} -> ${target}`,
              description: promotionBody({ source, target, step, ahead }),
              // 🔴 소스 브랜치를 지우지 않는다. front/dev 가 사라지면 그 파트의
              //    작업 흐름이 통째로 끊긴다. 승격은 옮기는 것이 아니라 올리는 것이다.
              remove_source_branch: false,
              squash: false,
            },
          })
          if (!made.ok) { say('x', `MR 을 만들지 못했습니다 — ${apiWhy(made)}`); tally.failed++; fail(EXIT.ERROR); continue }
          mr = made.json
          say('o', `커밋 ${ahead}개 — MR !${mr?.iid ?? '?'} 를 새로 만들었습니다`)
          tally.created++
        }
      } else {
        say('o', `커밋 ${ahead}개 — 이미 열려 있는 MR !${mr.iid} 를 씁니다`)
      }

      // 3. 정족수 판정. 게이트의 종료 코드를 그대로 읽는다.
      const verdict = await gate({ source, target })
      const label = mr?.iid ? `MR !${mr.iid}` : '(아직 안 만든 MR)'

      if (verdict.exit === GATE.SHORT) {
        // 실패가 아니다. 사람이 투표하면 다음 주기에 풀린다.
        say('-', `${label} 표가 모자랍니다 — ${shortLine(verdict)}. 머지하지 않고 넘어갑니다`)
        tally.short++
        continue
      }
      if (verdict.exit !== GATE.OK) {
        // 🔴 판정 불가는 통과가 아니다. 여기서 잡을 실패시킨다.
        say('x', `${label} 정족수를 판정하지 못했습니다 (게이트 종료 코드 ${verdict.exit})`)
        if (verdict.text) for (const line of String(verdict.text).split('\n')) log(`      | ${line}`)
        tally.failed++
        fail(verdict.exit === GATE.POLICY_BROKEN ? EXIT.POLICY_BROKEN : EXIT.ERROR)
        continue
      }

      // 🔴 판정에 쓴 커밋이 없으면 머지하지 않는다. sha 없는 머지는 표가 없는
      //    커밋을 머지할 수 있는 창을 그대로 열어 두는 것이다.
      if (!looksLikeSha(verdict.sha)) {
        say('x', `${label} 정족수는 충족인데 판정에 쓴 커밋(sha)을 못 받았습니다. 머지하지 않습니다`)
        tally.failed++
        fail(EXIT.ERROR)
        continue
      }

      if (dryRun) {
        say('o', `${label} 정족수 충족 — sha ${verdict.sha.slice(0, 12)} 를 실어 머지했을 것입니다`)
        tally.planned++
        continue
      }

      // 4. 머지. 🔴 sha 를 반드시 싣는다 (CAS).
      //
      // 🔴 표의 이유를 **머지 커밋 본문**에 싣는다 (src/promote.mjs 의 근거 참고).
      //    MR 댓글에 두면 clone 에 안 따라오고 GitLab 을 떠나면 사라진다. 트레일러로
      //    적으면 `git log --grep` 과 `git interpret-trailers --parse` 가 읽는다.
      //    표가 하나도 없으면 null 이고, 그때는 필드를 아예 안 보내 GitLab 기본
      //    메시지를 그대로 쓴다 — 빈 문자열을 보내면 기본 메시지를 덮어쓴다.
      const message = mergeCommitMessage({ source, target, verdict })
      const merged = await gl('PUT', `/merge_requests/${mr.iid}/merge`, {
        body: {
          // 판정할 때 본 그 커밋. 지금 MR 헤드가 다르면 GitLab 이 409 로 거부한다.
          sha: verdict.sha,
          ...(message ? { merge_commit_message: message } : {}),
          // 🔴 판정 시점과 머지 시점을 벌리지 않는다. 벌어진 사이에 들어온 커밋이
          //    옛 표로 머지되는 것이 이 파일이 막으려는 사고 전부다.
          merge_when_pipeline_succeeds: false,
          squash: false,
          should_remove_source_branch: false,
        },
      })

      if (merged.status === 409) {
        // 🔴 재시도하지 않는다. 내용이 바뀌었다는 뜻이고, 바뀐 내용은 새로 표를 받는다.
        say('!', `MR !${mr.iid} 머지 거부(409) — 판정 뒤에 소스가 움직였습니다. `
          + '재시도하지 않습니다. 새 커밋은 새로 표를 받아야 합니다')
        tally.conflict++
        continue
      }
      if (merged.status === 405) {
        /**
         * 🔴 405 는 "지금은 머지할 수 없다" 이지 "고장" 이 아니다.
         *
         * 제일 흔한 원인은 **파이프라인이 아직 도는 중**이다. `Pipelines must
         * succeed` 가 켜져 있으면 초록이 되기 전에는 머지 버튼이 안 열리는데,
         * 봇은 바로 위에서 MR 을 **방금 만들었다.** 그 주기에는 파이프라인이
         * 이제 막 시작한 참이라 거의 언제나 405 다.
         *
         * 이걸 실패로 세면 **MR 을 만드는 밤마다 스케줄 잡이 빨개진다.**
         * 늘 빨간 잡은 아무도 안 읽고, 안 읽는 검사는 없는 검사다 —
         * 이 저장소가 "개수를 문서에 적지 않는다" 로 막으려는 것과 같은 종류의
         * 낡음이다.
         *
         * 그래서 넘어가되 **조용히 넘어가지 않는다.** 다음 주기에 다시 온다.
         * 충돌·드래프트처럼 사람이 손대야 풀리는 것도 405 로 오는데, 그건
         * 같은 줄이 며칠 연속 찍히는 것으로 드러난다.
         */
        say('!', `MR !${mr.iid} 아직 머지할 수 없습니다(405) — ${apiWhy(merged)}. `
          + '파이프라인이 도는 중이거나, 충돌·드래프트입니다. 다음 주기에 다시 봅니다')
        tally.blocked++
        continue
      }
      if (!merged.ok) {
        say('x', `MR !${mr.iid} 머지 실패 — ${apiWhy(merged)}`)
        tally.failed++
        fail(EXIT.ERROR)
        continue
      }
      say('o', `MR !${mr.iid} 머지 완료 — sha ${verdict.sha.slice(0, 12)}`)
      tally.merged++
    } catch (e) {
      if (!(e instanceof ApiError)) throw e // 우리 버그는 스택과 함께 터뜨린다
      say('x', e.message)
      tally.failed++
      fail(EXIT.ERROR)
    }
  }

  log('')
  log('요약')
  log(`  짝            : ${plan.pairs.length}개 (계획에서 뺀 것 ${plan.skipped.length}개)`)
  log(`  올릴 것 없음  : ${tally.nothing}개`)
  log(`  MR 새로 만듦  : ${tally.created}개`)
  log(`  표 부족       : ${tally.short}개`)
  log(dryRun ? `  머지했을 것   : ${tally.planned}개` : `  머지          : ${tally.merged}개`)
  log(`  409 로 넘김   : ${tally.conflict}개`)
  log(`  405 로 넘김   : ${tally.blocked}개  (아직 머지 불가 — 다음 주기에 다시 봅니다)`)
  log(`  실패          : ${tally.failed}개`)
  if (worst !== EXIT.OK) log(`  -> 종료 코드 ${worst}`)
  return worst
}

// 직접 실행할 때만 돈다. import 하면 아무것도 안 한다 (테스트가 run 을 부른다).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(e?.stack ?? String(e)); process.exit(EXIT.ERROR) },
  )
}
