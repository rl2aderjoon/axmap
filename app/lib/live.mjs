/**
 * 실시간 계층 — 지금 AI 가 어디를 건드리고 있고 무엇을 하려는지.
 *
 * 두 개를 겹친다.
 *   선언  axMap 장부의 claim   — 어디를 건드리겠다고 했나 + 왜 (intent)
 *   실제  git status + 파일 감시   — 실제로 지금 뭐가 바뀌었나
 *
 * 둘의 차이가 docs/DECISIONS.md 의 D3 다. PR 시점이 아니라 작업 중에 보면
 * 몇 시간을 번다. 선언 밖 수정은 그 자리에서 경고가 된다.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { activeClaims, coversPath, claimExpiresAt, normalizePath } from '../../src/protocol.mjs'

// ---------------------------------------------------------------------------
// 선언 — axMap 장부
// ---------------------------------------------------------------------------

/**
 * 이 저장소에서 '나'는 누구인가. 팀원과 구분하는 기준이다.
 *
 * 이름을 정하는 순서는 CLI·MCP 와 같아야 한다 (SPEC "에이전트 이름을 정하는 순서").
 * 여기만 다르면 CLI 는 `A` 로 claim 했는데 화면은 그 claim 을 **남의 것**으로
 * 칠해 보여준다. 순서가 갈리는 것 자체가 버그이므로 세 곳을 함께 고친다.
 */
export function whoAmI(repoRoot) {
  if (process.env.AXMAP_AGENT) return process.env.AXMAP_AGENT
  const r = spawnSync('git', ['config', 'user.name'], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
  })
  return (r.stdout ?? '').trim() || null
}

export function readClaims(repoRoot, now = Date.now(), me = null) {
  const dir = path.join(repoRoot, '.axmap', 'ledger', 'claims')
  if (!fs.existsSync(dir)) return { available: false, claims: [] }
  const claims = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      claims.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    } catch {
      // 장부가 손상됐으면 조용히 넘기지 않고 표시한다 (axMap 본체는 중단하지만
      // 뷰어는 읽기 전용이므로 경고만 남긴다)
      claims.push({ agent: `(손상: ${f})`, paths: [], since: new Date(0).toISOString(), ttlMs: 0, broken: true })
    }
  }
  return {
    available: true,
    claims: activeClaims(
      claims.filter((c) => !c.broken),
      now,
    ).map((c) => ({
      agent: c.agent,
      task: c.task ?? null,
      intent: c.intent ?? null,
      // 표시용 — 사람 / 대화형 AI / 백그라운드 에이전트 / 다른 팀원
      actor: c.actor ?? (c.agent === me ? 'human' : 'team'),
      paths: c.paths.map(normalizePath),
      since: c.since,
      expiresAt: new Date(claimExpiresAt(c)).toISOString(),
    })),
    broken: claims.filter((c) => c.broken).map((c) => c.agent),
  }
}

// ---------------------------------------------------------------------------
// 실제 — git 이 보는 변경
// ---------------------------------------------------------------------------

export function modifiedFiles(repoRoot) {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.status !== 0) return { available: false, files: [] }
  const files = []
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2).trim()
    // 이름 변경은 "old -> new" 형태
    const raw = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')
    files.push({ path: normalizePath(raw), code })
  }
  return { available: true, files }
}

// ---------------------------------------------------------------------------
// 겹치기 — 파일마다의 상태
// ---------------------------------------------------------------------------

/**
 * @returns Map<path, {state, agent, intent}>
 *   declared    선언했지만 아직 안 건드림
 *   working     선언했고 실제로 건드리는 중
 *   undeclared  선언 안 했는데 건드림  ← 경고
 */
export function overlay(claims, modified, knownPaths = []) {
  const out = new Map()

  for (const c of claims) {
    for (const p of c.paths) {
      const mark = { state: 'declared', agent: c.agent, actor: c.actor, intent: c.intent, task: c.task, claimed: p }
      out.set(p, mark)
      // 디렉터리를 claim 하면 그 아래 파일도 선점된 것이다.
      // 그래프 노드는 파일 단위이므로 전파하지 않으면 화면에서 회색으로 남아
      // "아무도 안 잡은 곳"처럼 보인다.
      for (const f of knownPaths) {
        if (f !== p && coversPath([p], f)) out.set(f, { ...mark })
      }
    }
  }

  for (const m of modified) {
    const owner = claims.find((c) => coversPath(c.paths, m.path))
    if (owner) {
      const covering = owner.paths.find((p) => coversPath([p], m.path))
      out.set(m.path, {
        state: 'working',
        agent: owner.agent,
        actor: owner.actor,
        intent: owner.intent,
        task: owner.task,
        claimed: covering,
        code: m.code,
      })
      // 디렉터리 claim 이면 그 디렉터리 자체도 '작업중'으로 물들인다
      if (covering !== m.path && out.get(covering)?.state === 'declared') {
        out.set(covering, { ...out.get(covering), state: 'working' })
      }
    } else {
      out.set(m.path, { state: 'undeclared', agent: null, intent: null, code: m.code })
    }
  }

  return out
}

/** 화면 상단에 띄울 한 줄 요약. */
/**
 * 지금 누가 무엇을 잡고 있나 — 한 줄 요약.
 *
 * 🔴 장부를 **못 읽었으면 숫자를 내지 않는다.**
 *
 * 벤치마크에서 잡혔다. `/api/watch` 가 `ledgerAvailable: false` 를 보내면서
 * 동시에 `claims: []` 와 `summary.agents: 0` 을 함께 보냈다. 텍스트만 보는
 * 신입이 그 0 을 읽고 **"아무도 안 잡고 있어 부딪힐 대상 없음"** 이라고
 * 확신 있게 틀린 답을 냈다.
 *
 * 같은 화면을 그림으로 본 신입은 맞게 "못 함" 이라고 했다 — 화면은 경고를
 * 크게 그렸기 때문이다. **화면이 API 보다 정직했다.**
 *
 * 플래그는 있었다. 문제는 **0 이 더 크게 말한다**는 것이다. 읽는 쪽이
 * 플래그를 안 보면 그건 우리 잘못이다 — 애초에 0 을 주지 말아야 한다.
 *
 * 이 저장소가 락에서 뿌리뽑은 fail-open 이고, 오늘 아침 SSOT 서버에서
 * 고친 `recorded: 0` 과 정확히 같은 유형이다. 세 번째다.
 *
 * @param {boolean} available 장부를 실제로 읽었는가
 */
export function summarize(claims, modified, ov, available = true) {
  if (!available) {
    return {
      // 🔴 null 은 "모른다" 이고 0 은 "없다" 다. 둘을 같은 값으로 말하지 않는다.
      agents: null,
      declaredPaths: null,
      declared: null,
      working: null,
      undeclared: null,
      // 수정 파일은 git 에서 오므로 장부와 무관하게 알 수 있다.
      modified: modified.length,
      unknown: true,
      why: '장부를 읽지 못했습니다 — 0 이 아니라 모르는 것입니다',
    }
  }
  return summarizeKnown(claims, modified, ov)
}

function summarizeKnown(claims, modified, ov) {
  const undeclared = [...ov.values()].filter((v) => v.state === 'undeclared').length
  const working = [...ov.values()].filter((v) => v.state === 'working').length
  /**
   * 🔴 세 색깔에는 세 숫자가 있어야 한다.
   *
   * 범례는 색을 셋으로 나눠 설명하는데(선점만·작업 중·선언 밖) 여기서는 둘만
   * 셌다. 화면은 없는 `claimed` 필드를 읽어 `?? 0` 으로 떨어졌고, 그래서
   * **장부에 세 명이 잡고 있어도 "선점 0" 이라고 썼다.**
   *
   * 장부가 없는 환경에서만 돌리는 동안에는 이 버그가 안 보였다 — 0 이 맞는
   * 답처럼 보였기 때문이다. 4회차에서 실제 claim 을 넣고서야 드러났다.
   * 검증하지 않은 축은 조용히 썩는다.
   */
  const declared = [...ov.values()].filter((v) => v.state === 'declared').length
  return {
    agents: claims.length,
    declaredPaths: claims.reduce((a, c) => a + c.paths.length, 0),
    modified: modified.length,
    // 잡았지만 아직 안 건드린 것. 디렉터리 claim 은 그 아래 파일까지 물들므로
    // 이것은 **파일 수**이지 claim 건수가 아니다 (화면 라벨도 그렇게 쓴다).
    declared,
    working,
    undeclared, // D3 — 선언 ⊂ 실제. 이 숫자가 0 이 아니면 볼 이유가 있다
  }
}

// ---------------------------------------------------------------------------
// git 작성자별 작업 이력
//
// "이 사람이 뭘 건드렸나" 를 그래프에서 한번에 보여주기 위한 것.
// 장부(claim)는 지금 무슨 일이 일어나는지를, 이것은 지금까지 누가 무엇을 했는지를 말한다.
// ---------------------------------------------------------------------------

export function authorMap(repoRoot, { since = '3 months ago', maxCommits = 4000 } = {}) {
  const r = spawnSync(
    'git',
    // --relative 가 반드시 필요하다. 없으면 git 저장소 루트 기준 경로가 나오는데,
    // 뷰어가 저장소의 하위 디렉터리를 보고 있으면 그래프 노드 ID 와 하나도 맞지 않는다.
    // (e101 은 저장소 루트가 e101_hj 이고 뷰어는 그 아래 BE_robot 을 본다)
    ['log', `--since=${since}`, `-n${maxCommits}`, '--no-merges', '--relative',
      '--format=\x01%an\x02%ae\x02%ct\x02%h', '--name-only'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  if (r.status !== 0) return { available: false, authors: [] }

  const byAuthor = new Map()
  let cur = null
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('\x01')) {
      const [name, email, ct, sha] = line.slice(1).split('\x02')
      if (!byAuthor.has(name)) byAuthor.set(name, { name, email, commits: 0, last: 0, files: new Map() })
      cur = byAuthor.get(name)
      cur.commits++
      cur.last = Math.max(cur.last, Number(ct) * 1000)
      cur.lastSha = cur.lastSha ?? sha
      continue
    }
    const p = line.trim()
    if (!cur || !p) continue
    const n = normalizePath(p)
    cur.files.set(n, (cur.files.get(n) ?? 0) + 1)
  }

  return {
    available: true,
    authors: [...byAuthor.values()]
      .map((a) => ({
        name: a.name,
        email: a.email,
        commits: a.commits,
        lastAt: new Date(a.last).toISOString(),
        fileCount: a.files.size,
        files: [...a.files.entries()].sort((x, y) => y[1] - x[1]).map(([p, n]) => ({ path: p, touches: n })),
      }))
      .sort((x, y) => y.commits - x.commits),
  }
}

/**
 * 커밋마다 바뀐 파일 목록. 기능 클러스터의 재료다 (features.mjs).
 *
 * `authorMap` 과 같은 git 호출을 쓰지만 결과가 다르다 — 저쪽은 사람별로
 * 접고, 여기는 **커밋 단위 묶음이 그대로 필요하다.** 무엇이 무엇과 함께
 * 바뀌었는지가 신호이므로 커밋 경계를 잃으면 안 된다.
 *
 * `--relative` 가 필요한 이유는 authorMap 주석과 같다. 뷰어가 저장소의
 * 하위 디렉터리를 보고 있으면 루트 기준 경로는 노드 ID 와 하나도 안 맞는다.
 *
 * 코드 파일만 남긴다. 문서·설정이 섞이면 "릴리스 커밋"처럼 온갖 것이 함께
 * 바뀐 커밋이 기능 신호를 뭉갠다.
 */
const CODE_EXT = /\.(py|mjs|cjs|js|jsx|ts|tsx|java|kt|go|rs|rb|php|cs|swift|c|cc|cpp|h|hpp)$/i

/**
 * @param {string} ref 어디서부터 거슬러 올라갈지. 기본은 `HEAD`.
 *
 *   🔴 PR 화면(prdiff.mjs Q4)이 `merge-base` 를 넘긴다. "평소 이 파일들이
 *      함께 바뀌던 범위" 를 재는데 **이번 변경 자체가 그 표본에 들어가면**
 *      비교가 무의미해진다 — 이번 커밋을 포함한 평균과 이번 커밋을 비교하게 된다.
 *      기본값을 HEAD 로 두었으므로 기존 호출자의 동작은 그대로다.
 */
export function commitFiles(repoRoot, { since = '1 year ago', maxCommits = 4000, ref = 'HEAD' } = {}) {
  const r = spawnSync(
    'git',
    // `--format=%x01` 이지 `--format=\x01` 이 아니다. 값에 `%` 가 없으면 git 은
    // 그것을 **형식 이름**으로 보고 `invalid --pretty format` 으로 거부한다.
    // (authorMap 은 `%an` 이 들어 있어 우연히 문제가 없었다)
    //
    // 제목(`%s`)도 함께 가져온다. 기능 이름을 지을 때 쓴다 —
    // 단, **명단은 제목과 무관하다.** 제목이 `wip` 뿐인 저장소에서도
    // 파일 묶음은 그대로 나오고 이름만 파일명 추출로 떨어진다.
    ['log', ref, `--since=${since}`, `-n${maxCommits}`, '--no-merges', '--relative',
      '--format=%x01%s', '--name-only'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  if (r.status !== 0) return { available: false, commits: [] }

  const commits = []
  let cur = null
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('\x01')) {
      cur = { subject: line.slice(1).trim(), files: [] }
      commits.push(cur)
      continue
    }
    const p = line.trim()
    if (!cur || !p || !CODE_EXT.test(p)) continue
    // 하위 디렉터리를 보고 있으면 그 밖의 파일은 `../` 로 나온다. 그래프에 없는 것이다.
    if (p.startsWith('..')) continue
    cur.files.push(normalizePath(p))
  }
  return { available: true, commits: commits.filter((c) => c.files.length) }
}

// ---------------------------------------------------------------------------
// 감시
// ---------------------------------------------------------------------------

const SKIP = /[\\/](\.git|node_modules|__pycache__|\.axmap[\\/]ledger[\\/]\.git)[\\/]/

/**
 * 변경이 멎은 뒤 한 번만 알린다.
 * AI 는 파일을 연달아 여러 개 쓰므로 매 이벤트마다 다시 계산하면 낭비다.
 */
export function watch(repoRoot, onChange, { debounceMs = 400 } = {}) {
  let timer = null
  let watcher
  try {
    watcher = fs.watch(repoRoot, { recursive: true }, (_type, filename) => {
      if (filename && SKIP.test(`/${filename}/`)) return
      clearTimeout(timer)
      timer = setTimeout(onChange, debounceMs)
    })
  } catch (e) {
    return { ok: false, error: e.message, close() {} }
  }
  return {
    ok: true,
    close() {
      clearTimeout(timer)
      watcher.close()
    },
  }
}
