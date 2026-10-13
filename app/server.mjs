#!/usr/bin/env node
/**
 * axMap 뷰어 — 로컬 웹서버.
 *
 *   node app/server.mjs <대상경로> [포트]
 *   node app/server.mjs ../e101_hj/redesign/S15P11E101/BE_robot 7777
 *
 * 브라우저로도 열리고 Electron 셸(`desktop/`)로도 열린다. 셸은 이 파일을 자식
 * 프로세스로 띄우고 창을 그리로 가리킬 뿐이라, 여기는 셸의 존재를 모른다 —
 * import 방향은 `desktop/` → 코어 단방향이다 (docs/DECISIONS.md D16).
 *
 * 외부 의존성 0. 이유는 폐쇄망에서 npm 이 안 되기 때문이 **아니다**(설치본에는 번들되어
 * 나간다). 이 프로세스가 `src/protocol.mjs` 의 판정을 들고 돌기 때문에 감사 대상 코드를
 * 최소로 유지하는 것이다. 의존성을 쓰는 자리는 `desktop/` 이다.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  askOf, build, coupling, depths, detail, entryOf, referenceEdges, scan,
} from './lib/analyze.mjs'
import { resolveThresholds, dominantLang, fetchBaseline, bandOf, cellFor } from './lib/ssot.mjs'
import { registrationPoints, say as sayNewFile } from './lib/newfile.mjs'
// 겹침 판정은 프로토콜의 것을 그대로 쓴다 — 화면과 락이 다른 답을 하면 안 된다.
import { coversPath } from '../src/protocol.mjs'
import {
  authorMap, commitFiles, modifiedFiles, overlay, readClaims, summarize as liveSummary, watch, whoAmI,
} from './lib/live.mjs'
import { applyEdits, draft, featureEdges } from './lib/features.mjs'
import { aliasImportEdges, coChange, lastCommitSetsError, overlayEdges, readCommitSets } from './lib/cochange.mjs'
import { historyNodes } from './lib/datanodes.mjs'
import { featureScope } from './lib/scope.mjs'
import { findRoots, splitNeeded } from './lib/roots.mjs'
import { coreSubset, entryPoints } from './lib/entry.mjs'
import { featureAdjacency } from './lib/adjacent.mjs'
import { basicFlow, entryStarts } from './lib/flow.mjs'
import { ladder, pathBetween, isAux } from './lib/ladder.mjs'
import { featureGraph, modulesOf, docLines, matchDocs } from './lib/featuregraph.mjs'
import { fetchRepo, isRemote } from './lib/fetchrepo.mjs'
import { prReview } from './lib/prdiff.mjs'
import { detect as detectAgents, preferred as preferredAgent } from './lib/agentcli.mjs'
import * as sess from './lib/session.mjs'
import * as llm from './lib/llm.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, 'web')
/** `app/` 자신. 순수 모듈(`app/lib/*.mjs`)을 화면에 주기 위해 쓴다. */
const ROOT_DIR_OF_APP = path.dirname(WEB)

/**
 * 대상은 로컬 경로 **또는 git 주소**다 — 서사 1단계 (D14).
 *
 *   node app/server.mjs .                                    로컬
 *   node app/server.mjs https://github.com/pallets/flask      원격
 *   node app/server.mjs github.com/pallets/flask              스킴 생략도 받는다
 *
 * 원격이면 받아서 캐시에 두고 그 경로를 쓴다. 두 번째부터는 다시 안 받는다.
 */
const TARGET = process.argv[2] ?? process.cwd()
let CLONED = null
if (isRemote(TARGET)) {
  try {
    CLONED = fetchRepo(TARGET, { onLog: (m) => console.log(`  ${m}`) })
    console.log(`  커밋 ${CLONED.commits.toLocaleString()}개${CLONED.cached ? ' (캐시)' : ''}\n`)
  } catch (e) {
    // 실패를 삼키고 빈 폴더로 진행하면 "저장소가 비었다" 는 틀린 결론이 화면에 뜬다.
    console.error(`\n  ${e.message}\n`)
    process.exit(1)
  }
}
const ROOT = path.resolve(CLONED?.dir ?? TARGET)
const PORT = Number(process.argv[3] ?? 7777)

/**
 * 읽기전용 모드 — 밖으로 열 때 쓴다.
 *
 * 🔴 이 뷰어는 localhost 전용으로 설계됐다. `127.0.0.1` 에만 바인딩하는 것이
 *    유일한 방어선이었고, 그 전제 위에서 파일을 쓰고 LLM 키를 저장하는
 *    엔드포인트를 열어뒀다.
 *
 * 터널·리버스프록시로 밖에 내보내는 순간 그 전제가 깨진다. 그래서 상태를
 * 바꾸는 모든 경로를 한 곳에서 막는다. **막는 쪽을 기본으로 두지 않은 것은
 * 로컬 개발을 위해서지만, 노출할 때는 반드시 켜야 한다.**
 *
 *   node app/server.mjs <경로> <포트> --readonly
 */
const READONLY = process.argv.includes('--readonly')

/**
 * Basic 인증 — `--auth 사용자:비밀번호` 또는 환경변수 `AXMAP_AUTH`.
 *
 * 리버스 프록시가 인증을 걸어주지 못하는 자리가 있다. 그럴 때 앱이 스스로 건다.
 * 읽기전용이어도 **소스 코드가 그대로 보이므로** 밖으로 열 때는 인증이 필수다.
 *
 * 🔴 상시 서비스로 돌릴 때는 `--auth` 를 쓰지 않는다.
 *
 * argv 는 `/proc/<pid>/cmdline` 에 그대로 있고 그 파일은 **누구나 읽는다.**
 * 그래서 `ps aux` 한 줄이면 비밀번호가 나온다 — AWS 에 systemd 로 올리면서
 * 실제로 그렇게 새고 있었다. 환경변수는 `/proc/<pid>/environ` 에 있지만
 * 그쪽은 프로세스 소유자만 읽는다.
 *
 * `--auth` 를 남겨두는 이유는 손으로 잠깐 띄울 때 편하기 때문이고, 그때는
 * 셸 히스토리가 이미 같은 값을 알고 있으므로 잃을 것이 없다.
 * 둘 다 있으면 `--auth` 가 이긴다 — 손으로 준 것이 더 구체적인 의도다.
 */
/**
 * 🔴 공개로 여는데 자격증명이 없으면 **뜨지 않는다.**
 *
 * 한때 여기에 옛 이름 환경변수를 받아주는 분기가 있었다. 서버의 env 파일이
 * 아직 옛 이름이었기 때문인데, 그 호환이 가리고 있던 진짜 문제는 따로 있었다 —
 * **자격증명이 비면 이 함수가 조용히 `null` 을 돌려주고, 공개 뷰어가 인증 없이
 * 소스를 통째로 내보낸다.** 아무 오류도 안 난다.
 *
 * 그래서 호환을 늘리는 대신 실패 방향을 뒤집었다. `--readonly`(공개 배포)인데
 * 자격증명이 없으면 **거부하고 죽는다.** env 파일 이름이 틀리면 서버가 안 뜨고,
 * 안 뜨는 것은 사람이 즉시 안다. 반대는 아무도 모른다.
 *
 * 손으로 로컬에서 띄울 때(`--readonly` 없이)는 그대로 인증 없이 돈다.
 * 그때는 127.0.0.1 에만 열리고 잃을 것이 없다.
 */
const AUTH = (() => {
  const i = process.argv.indexOf('--auth')
  if (i >= 0 && process.argv[i + 1]) {
    return `Basic ${Buffer.from(process.argv[i + 1]).toString('base64')}`
  }
  const cred = process.env.AXMAP_AUTH
  if (!cred) {
    if (READONLY) {
      console.error(
        '공개(--readonly)로 열려는데 자격증명이 없습니다.\n' +
          '  AXMAP_AUTH=사용자:비밀번호  또는  --auth 사용자:비밀번호\n' +
          '인증 없이 공개하면 소스가 통째로 나갑니다. 그래서 뜨지 않고 멈춥니다.',
      )
      process.exit(1)
    }
    return null
  }
  return `Basic ${Buffer.from(cred).toString('base64')}`
})()

/** 길이에 무관한 시간으로 비교한다. 빨리 끝나는 비교는 문자 단위로 정답을 알려준다. */
function sameSecret(a, b) {
  const A = Buffer.from(a), B = Buffer.from(b)
  if (A.length !== B.length) return false
  let d = 0
  for (let k = 0; k < A.length; k++) d |= A[k] ^ B[k]
  return d === 0
}

/**
 * 🔴 API 접두사를 바꿀 수 있게 한다.
 *
 * 리버스 프록시 아래에 붙일 때 `/api/` 가 남의 것과 부딪힌다. 이 서버를
 * `/dev/` 아래에 붙이려 했더니 nginx 에 `location /dev/api/` 가 따로 있어서
 * 우리 요청이 **다른 백엔드로 흘러갔다.** 그쪽 응답을 우리 데이터인 줄 알고
 * 파싱하게 된다 — 조용히 틀리는 최악의 방식이다.
 *
 * 그래서 `/_bm/` 을 별칭으로 받는다. 화면은 이쪽을 쓰고, 로컬에서는 `/api/` 도
 * 그대로 동작한다.
 */
const API_ALIAS = '/_bm/'

if (!fs.existsSync(ROOT)) {
  console.error(`대상 경로가 없습니다: ${ROOT}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 그래프 캐시 — 파일이 바뀌면 무효화
// ---------------------------------------------------------------------------

/**
 * 코퍼스 기준. 서버가 뜨기 전에 한 번 받는다.
 *
 * 🔴 첫 요청 뒤에 받으면 안 된다. 그래프는 지연 생성되고 문턱값은 **생성 시점에**
 * 박히므로, 늦게 도착한 기준은 이미 만들어진 그래프에 반영되지 않는다.
 * 그러면 화면은 "코퍼스 기준 적용" 이라고 말하면서 기본값으로 그린 그래프를
 * 보여주게 된다 — 도구가 거짓말하는 종류의 실패다.
 */
const { baseline: BASELINE, from: BASELINE_FROM, error: BASELINE_ERR } = await fetchBaseline()

/** 저장소 커밋 수. 코퍼스의 규모 칸(small/mid/large)을 고르는 데 쓴다. */
function commitCount() {
  const r = git(['rev-list', '--count', 'HEAD'])
  const n = Number((r.stdout ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

// ── 저장소 받아오기 (자식 프로세스) ────────────────────────────────────────

/** 진행 중이거나 끝난 클론 작업. id → {state, root, error, log[]} */
const fetchJobs = new Map()
let fetchSeq = 0

/**
 * 클론을 자식에게 맡기고 **작업 id 만 돌려준다.** 이 프로세스는 막히지 않는다.
 * 왜 자식에게 넘기는지는 `app/lib/fetchrepo-run.mjs` 머리말에 있다.
 */
function startFetch(url) {
  const id = `f${++fetchSeq}`
  const job = { id, state: 'running', url, root: null, error: null, log: [] }
  fetchJobs.set(id, job)

  const child = spawn(process.execPath, [path.join(HERE, 'lib', 'fetchrepo-run.mjs'), url], {
    cwd: HERE,
    windowsHide: true,
    /**
     * 🔴 stdin 을 막고 git 이 **묻지 못하게** 한다.
     *
     * 자격증명이 필요한 주소(사설 저장소, 만료된 토큰)에서 git 은 아이디를
     * 물어보며 stdin 을 기다린다. 창이 없으니 아무도 대답하지 않고, 작업은
     * **영원히 "받아오는 중"** 에 머문다. 실제로 그렇게 멈췄다 — 오류도 없고
     * 타임아웃도 없어서 사용자는 저장소가 큰가 보다 하고 기다리게 된다.
     *
     * 물어보지 못하게 하면 git 이 그 자리에서 실패하고, 우리는 그 이유를
     * 그대로 화면에 올린다. 기다리게 하는 것보다 거절하는 것이 낫다.
     */
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      /**
       * 윈도우의 Git Credential Manager. `never` 는 **캐시된 자격증명은 그대로
       * 쓰되 창을 띄우지 않는다** — 권한 있는 사설 저장소는 계속 열리고,
       * 권한 없는 곳에서만 즉시 실패한다.
       */
      GCM_INTERACTIVE: 'never',
      /**
       * ssh 주소(`git@…`)도 같은 함정이 있다. 암호구절이나 호스트 키를 물으면
       * 역시 영원히 멈춘다. `BatchMode` 가 그 자리에서 실패하게 만든다.
       */
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    },
  })

  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => { out += c })
  // 진행 로그는 stderr 로 온다. 화면이 "받아오는 중" 대신 진짜 상황을 보여줄 수 있다.
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (c) => {
    for (const line of String(c).split('\n')) if (line.trim()) job.log.push(line.trim())
  })

  child.on('error', (e) => { job.state = 'error'; job.error = e.message })
  child.on('close', (code) => {
    if (job.state === 'error') return
    let r = null
    try { r = JSON.parse(out) } catch { /* 아래에서 실패로 떨어진다 */ }
    if (code !== 0 || !r || r.error) {
      job.state = 'error'
      /**
       * 🔴 자식이 왜 죽었는지 삼키지 않는다.
       * "실패했습니다" 만 뜨면 사용자는 주소가 틀린 건지 네트워크가 막힌 건지
       * 사설 저장소라 권한이 없는 건지 알 수 없다. git 이 한 말을 그대로 올린다.
       */
      job.error = r?.error || job.log.slice(-3).join(' / ') || `종료 코드 ${code}`
      return
    }
    Object.assign(job, { state: 'done', root: r.dir, commits: r.commits, cached: r.cached })
  })

  return id
}

let graphCache = null
function graph() {
  if (!graphCache) {
    const t0 = Date.now()
    const files = scan(ROOT)
    // 문턱값은 이 저장소의 성격(언어·규모)에 따라 달라진다. 파일을 봐야 정해지므로
    // build 보다 먼저, 그러나 같은 scan 결과 위에서 정한다.
    const t = resolveThresholds(BASELINE, {
      lang: dominantLang(files.map((f) => f.path)),
      commits: commitCount(),
    })
    graphCache = build(files, { splitOver: t.splitOver, hubCap: t.hubCap })
    graphCache.stats.buildMs = Date.now() - t0
    // 근거를 그래프에 붙여 화면까지 내보낸다. 숫자만 주고 출처를 안 주면
    // 사람은 그 숫자를 검증할 방법이 없다 (SSOT 원칙 2 — 적용 조건을 붙인다).
    graphCache.ssot = { ...t, fetchedFrom: BASELINE_FROM, fetchError: BASELINE_ERR ?? null }
  }
  return graphCache
}

// ---------------------------------------------------------------------------
// 오버레이 — 정적 파싱 × git 공변경
// ---------------------------------------------------------------------------

/**
 * 히스토리는 커밋이 쌓여야 바뀌므로 파일 감시로 무효화하지 않는다.
 * 저장소 전체 로그를 한 번 갈아야 해서 비싸고(immich 10,746 커밋 기준 수 초),
 * 그 사이 답이 달라질 일이 없다.
 */
let overlayCache = null
function overlayGraph() {
  if (overlayCache) return overlayCache
  const t0 = Date.now()
  const g = graph()
  const ids = new Set(g.nodes.map((n) => n.id))

  // 정적 엣지 = analyze.mjs 의 것 + 별칭 import 보강.
  // 보강을 안 하면 tsconfig paths 를 쓰는 저장소에서 정적 엣지가 대량 누락되고,
  // 그 누락이 전부 "숨은 결합"으로 잘못 표시된다 (cochange.mjs 주석 참조).
  const seen = new Set(g.edges.map((e) => (e.source < e.target ? `${e.source}\0${e.target}` : `${e.target}\0${e.source}`)))
  const alias = aliasImportEdges(ROOT, ids)
    .filter((e) => !seen.has(e.source < e.target ? `${e.source}\0${e.target}` : `${e.target}\0${e.source}`))
    .map((e) => ({ ...e, kind: 'import', hub: false, directed: true, via: ['alias'] }))
  const staticEdges = [...g.edges, ...alias]

  /**
   * 🔴 히스토리만 있는 파일을 노드로 올린다 (datanodes.mjs).
   *
   * baritone 에서 가장 중요한 숨은 결합이
   * `mixins.baritone.json` ↔ `Mixin*.java` (67커밋 중 53커밋 동반) 였는데
   * `.json` 이 노드가 아니라 통째로 사라졌다. 정적 파싱이 안 되는 파일이라도
   * git 공변경은 언어와 무관하게 계산된다 — 노드로만 넣으면 된다.
   */
  const rawSets = readCommitSets(ROOT)
  const extra = rawSets ? historyNodes(ROOT, rawSets, ids) : { nodes: [], stats: null }
  for (const n of extra.nodes) ids.add(n.id)
  const allNodes = [...g.nodes, ...extra.nodes]

  const co = coChange(ROOT, ids, { raw: rawSets })
  if (!co) {
    overlayCache = {
      nodes: allNodes, edges: staticEdges.map((e) => ({ ...e, origin: 'static' })),
      quadrant: { both: 0, cochange: 0, stable: 0, unknown: staticEdges.length },
      /**
       * 🔴 `noGit: true` 만으로는 화면이 "히스토리 부족" 이라고 말한다.
       *    그런데 부족한 것과 **못 읽은 것**은 다르다.
       *
       * 벤치 2회차에서 신입이 잡았다 — 같은 서버가 여기서는 "커밋 0개" 라 하고
       * /api/featuregraph 에서는 커밋을 멀쩡히 세고 있었다. 진짜 원인은
       * `git log` 가 `fatal: unable to read <sha>` 로 죽은 것이었다.
       * 이유를 함께 실어야 다음 사람이 "이 저장소는 커밋이 적구나" 로 오독하지 않는다.
       */
      stats: {
        ...g.stats,
        noGit: true,
        gitError: lastCommitSetsError(),
        aliasEdges: alias.length,
        buildMs: Date.now() - t0,
      },
      freq: {},
    }
    return overlayCache
  }

  const { edges, quadrant } = overlayEdges(staticEdges, co.edges, co.freq)

  /**
   * 🔴 파서가 못 읽은 언어를 화면에 반드시 알린다.
   *
   * syft(Go, 파일 1,244개)에서 실측된 상황이다.
   * 노드의 98.6%가 `parsed:false` 였고 정적 엣지가 **1개**였다. 그런데 화면은
   * 그 상태를 결과처럼 보여줬다 —
   *
   *   "숨은 결합 1,082 · import 없는데 함께 바뀜"
   *      → 사실은 import 를 **안 본** 것이다. syft 에는 내부 import 가 2,702개 있다.
   *   "가장 많이 연결된 곳: .github/scripts/labeler.py"
   *      → 저장소에서 가장 안 중요한 CI 스크립트를 "파급 1위" 로 내놨다.
   *   "아무와도 안 이어진 곳"
   *      → 사실상 "가장 큰 파일 12개".
   *
   * 데이터에는 이미 `confidence: 'unparsed'` 가 있었다. **읽는 코드가 없었을 뿐이다.**
   * 침묵으로 실패하고 그 실패를 답으로 내놓는 것이 이 도구의 최악의 실패다 (D5).
   */
  // 히스토리 전용 노드는 애초에 파싱 대상이 아니므로 분모에서 뺀다.
  const parseable = allNodes.filter((n) => n.confidence !== 'history-only')
  const unparsed = parseable.filter((n) => n.confidence === 'unparsed')
  const langCount = new Map()
  for (const n of unparsed) {
    const ext = n.id.slice(n.id.lastIndexOf('.') + 1).toLowerCase()
    if (ext && ext !== n.id) langCount.set(ext, (langCount.get(ext) ?? 0) + 1)
  }
  const parsing = {
    total: parseable.length,
    unparsed: unparsed.length,
    ratio: parseable.length ? +(unparsed.length / parseable.length).toFixed(3) : 0,
    // 히스토리만으로 올린 노드가 몇 개인지도 알린다. 정적 엣지가 없는 것이 정상이다.
    historyOnly: extra.nodes.length,
    historyStats: extra.stats,
    // 무엇을 못 읽었는지 확장자로 말한다. "Go 를 못 읽는다" 가
    // "엣지가 없다" 보다 훨씬 쓸모 있는 정보다.
    tops: [...langCount].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([ext, n]) => ({ ext, n })),
    staticEdges: staticEdges.length,
    /**
     * 🔴 **커서 안 그린 모듈.** '못 읽었다' 의 형제이고, 화면에서 같은 자리에 선다.
     *
     * 스위프트 모듈은 파일 수십 개가 보통이라 상한(D9)을 넘는 것이 예외가 아니라
     * 기본값이다. 실측(apple/swift-argument-parser): 본체 ArgumentParser 가 52개
     * 파일이고 87개 파일이 그것을 부르는데, 그리면 4,524개 선이 된다.
     *
     * 안 그리는 것까지는 맞다. 문제는 **안 그렸다는 말을 안 하면** 화면이
     * '이 저장소는 결합이 없다' 로 읽힌다는 것이다. syft 에서 파싱 실패를
     * 결과처럼 보여줬던 것과 같은 실패다 — 그때도 데이터에는 이미 있었고
     * 읽는 코드가 없었을 뿐이다.
     */
    wideModules: g.wideModules ?? [],
  }

  overlayCache = {
    parsing,
    nodes: allNodes,
    edges,
    quadrant,
    hubs: g.hubs,
    // 기능 범위(/api/scope)가 원본 공변경 결과를 그대로 필요로 한다.
    // JSON 응답에는 안 나간다 — freq 가 Map 이라 직렬화되지 않기 때문이고,
    // 화면에는 이미 평평하게 편 freq 를 따로 주고 있다.
    co,
    freq: Object.fromEntries(co.freq),
    stats: {
      ...g.stats, ...co.stats,
      staticEdges: staticEdges.length,
      analyzeEdges: g.edges.length,
      aliasEdges: alias.length,
      coEdges: co.edges.length,
      buildMs: Date.now() - t0,
    },
  }
  return overlayCache
}

// ---------------------------------------------------------------------------
// 실시간 — 선언(claim) + 실제(git status)
// ---------------------------------------------------------------------------

const ME = whoAmI(ROOT)

// ---------------------------------------------------------------------------
// 기능 클러스터 — 초안(git 동시변경) + 사람의 편집
//
// 🔴 공개 API 는 제거했다 (2026-08-19). 지금은 taxonomy/index 층의 내부 재료로만 쓴다.
//
// `/api/features`, `/api/features/edit`, `unit=feature` 그래프를 없앴다.
// 화면에서 이 층을 부르는 코드가 하나도 없었다 — app.js 를 지울 때 함께 끊겼고
// 다시 붙이지 않았다. 계산은 하는데 아무도 안 보는 상태였다.
//
// 그리고 그대로 붙이면 안 되는 상태였다. syft(커밋 3,486) 실측:
//   · 54개 묶음 중 28개의 이름이 커밋 제목 그대로 (dependabot 버전 올림 포함)
//   · commitFiles 의 기본 창이 1년이라 커밋의 6%만 보고, 그 사실을 안 알림
//   · 같은 저장소에 파일 수가 두 개 (그래프 1,244 / 기능 842)
// 붙였으면 또 하나의 "확신 있게 틀린 답" 이 됐다.
//
// 기능 단위 질문은 /api/scope 가 답한다 — 커밋 메시지와 공변경으로 범위를 만들고
// 근거가 된 커밋 제목을 함께 보여준다. 그쪽은 출처를 말할 수 있다.
// ---------------------------------------------------------------------------

/**
 * 편집 기록은 **대상 저장소에** 둔다. 팀이 커밋해서 함께 보는 것이기 때문이다.
 * 초안은 여기 없다 — 코드에서 언제든 다시 계산되는 파생물이라 커밋하면
 * 저장소만 부풀고 머지 충돌만 늘어난다 (app/.cache 와 같은 기준).
 */
const EDITS = path.join(ROOT, '.axmap', 'features.jsonl')

function readEdits() {
  try {
    return fs.readFileSync(EDITS, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      // 한 줄이 깨져도 나머지는 살린다. append-only 파일이라 마지막 줄이
      // 쓰다 만 상태일 수 있고, 그것 때문에 팀 전체의 이름이 사라지면 안 된다.
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch {
    return []
  }
}

let featureCache = null
function features() {
  if (!featureCache) {
    const t0 = Date.now()
    const { available, commits } = commitFiles(ROOT)
    // 🔴 그래프 노드로 거르면 안 된다. 정적 파서가 읽는 언어는 6종뿐이라
    // Java 저장소에서는 노드가 0개이고, 그러면 기능 목록도 통째로 비어 버린다.
    // 기능 클러스터의 존재 이유가 정확히 "파서가 못 읽는 곳에서도 되는 것"이므로
    // 여기서는 **디스크에 실제로 있는가**만 본다.
    const known = new Set(
      [...new Set(commits.flatMap((c) => c.files))].filter((p) => {
        const abs = safeJoin(ROOT, p)
        return abs && fs.existsSync(abs)
      }),
    )
    const d = draft(commits, known)
    const { features: list, orphans } = applyEdits(d.features, readEdits())
    featureCache = {
      gitAvailable: available,
      features: list,
      orphans,
      // 분모는 **지금 디스크에 있는 파일**이다. 이력에 나온 경로를 다 세면
      // 지워진 파일까지 분모에 들어가 커버리지가 실제보다 낮게 나온다
      // (실측에서 194 vs 180 — 8%p 차이).
      liveFiles: known.size,
      stats: { ...d.stats, ms: Date.now() - t0 },
    }
  }
  return featureCache
}




// ---------------------------------------------------------------------------
// 대분류 · 파일 색인 — 자연어 단위로 노드를 세우기 위한 층
//
// 큰 모델이 대분류를 한 번 만들고(authored, 커밋), 작은 모델이 파일마다
// 그 목록에서 고른다(derived, 캐시). 자세한 근거는 llm.mjs 의 classify 주석.
// ---------------------------------------------------------------------------

/** 팀이 함께 보는 것이라 대상 저장소에 커밋한다. 초안은 큰 모델이 만들어 준다. */
const TAXONOMY = path.join(ROOT, '.axmap', 'taxonomy.json')

function readTaxonomy() {
  try {
    const j = JSON.parse(fs.readFileSync(TAXONOMY, 'utf8'))
    return Array.isArray(j?.categories) ? j.categories.filter((c) => typeof c === 'string') : []
  } catch {
    return []
  }
}

/**
 * 큰 모델에게 대분류를 물을 때 붙여 줄 재료.
 *
 * axMap 이 Claude API 키를 들고 있지 않아도 되게, **재료만 만들어 주고**
 * 사람이 자기 큰 모델에 붙여넣게 한다. 최소 설치라는 목표에 맞고,
 * 결과를 사람이 읽고 커밋하므로 검토 단계도 자연스럽게 생긴다.
 */
function taxonomyPrompt() {
  const f = features().features.filter((x) => !x.hidden)
  const dirs = [...new Set(graph().nodes.map((n) => n.dir.split('/').slice(0, 3).join('/')))]
  return [
    '아래는 한 저장소의 기능 묶음과 디렉터리 구조다.',
    '이 저장소를 사람이 이해하기 좋은 **대분류 6~10개**로 나눠라.',
    '분류 이름은 자연어로, 코드 용어가 아니라 하는 일로 적어라.',
    'JSON 으로만 답하라: {"categories":["...","..."]}',
    '',
    '## 기능 묶음',
    ...f.map((x) => `- ${x.name} (${x.paths.length}개): ${x.paths.slice(0, 4).map((p) => p.split('/').pop()).join(', ')}`),
    '',
    '## 디렉터리',
    ...dirs.slice(0, 40).map((d) => `- ${d}`),
  ].join('\n')
}

/**
 * 파일별 분류. 개별 오류는 **기능 클러스터 다수결**로 흡수한다.
 *
 * 실측에서 40개 중 1개가 틀렸다 (`StompWebSocketConfig.java` → 영상·인식).
 * STOMP 설정이 영상 중계에도 쓰이니 헷갈릴 만하다. 그런데 그 파일이 속한
 * 기능은 11개 중 10개가 `로봇 상태·통신` 이었다 — 다수결이 고쳐 준다.
 *
 * 즉 **개별 분류가 완벽할 필요가 없다.** 결정론적 묶음이 투표 블록이 되어
 * 준다. 큰 모델 없이 작은 모델로 버틸 수 있는 이유가 이것이다.
 */
let indexCache = null
let indexing = null

function indexState() {
  const cats = readTaxonomy()
  const files = graph().nodes
  return {
    categories: cats,
    ready: !!indexCache && indexCache.cats.join('') === cats.join(''),
    running: !!indexing,
    done: indexCache?.done ?? 0,
    total: files.length,
    byPath: indexCache?.byPath ?? {},
  }
}

async function buildIndex() {
  const cats = readTaxonomy()
  if (!cats.length) return { error: '대분류가 없습니다' }
  if (indexing) return { running: true }

  const nodes = graph().nodes
  indexCache = { cats, byPath: {}, done: 0 }

  indexing = (async () => {
    for (const n of nodes) {
      let text = ''
      try {
        const abs = safeJoin(ROOT, n.id)
        text = abs ? fs.readFileSync(abs, 'utf8') : ''
      } catch { /* 지워진 파일 */ }
      if (text) {
        const r = await llm.classify(n.id, text, cats)
        if (r.category) indexCache.byPath[n.id] = { category: r.category, role: r.role, raw: r.category }
      }
      indexCache.done++
    }

    // 기능 클러스터 다수결로 개별 오류를 흡수한다
    for (const f of features().features) {
      if (f.hidden || f.paths.length < 3) continue
      const votes = new Map()
      for (const p of f.paths) {
        const c = indexCache.byPath[p]?.category
        if (c) votes.set(c, (votes.get(c) ?? 0) + 1)
      }
      const [top, n2] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? []
      // 과반이 아니면 고치지 않는다. 근거가 약한 보정은 원래 답보다 나쁠 수 있다.
      if (!top || n2 <= f.paths.length / 2) continue
      for (const p of f.paths) {
        const e = indexCache.byPath[p]
        if (e && e.category !== top) { e.category = top; e.corrected = true }
      }
    }
    indexing = null
  })()

  return { running: true }
}

// ---------------------------------------------------------------------------
// PR — 올리기 전에 "뭘 바꿨고 어디까지 갔나" (D2)
//
// 판정은 전부 app/lib/prdiff.mjs 가 한다. 여기는 git 을 부르고 경로를 맞추는
// 일만 한다 (CLAUDE.md — 순수 로직과 부수효과를 섞지 않는다).
// ---------------------------------------------------------------------------

function git(args) {
  return spawnSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  })
}

/**
 * "여기에 새로 만들려면 어디를 고치나" 의 재료를 git 에서 캔다.
 *
 * 두 번 읽는다. 한 번에 못 하는 이유가 있다 —
 *   1) `-- <범위>` 를 걸면 그 범위 **안의** 파일만 보인다. 우리가 알고 싶은 것은
 *      그 커밋이 범위 **밖에서** 무엇을 고쳤나 이므로 그것만으로는 답이 안 나온다.
 *   2) 그렇다고 전체 히스토리를 상태까지 읽으면 큰 저장소에서 비싸다.
 * 그래서 먼저 "새 파일을 추가한 커밋" 만 좁혀 찾고(1), 그 커밋들만 다시 펼친다(2).
 *
 * 판정은 하지 않는다. newfile.mjs 가 한다 (CLAUDE.md — 순수 로직과 부수효과 분리).
 */
const MAX_ADD_COMMITS = 150

function newFileCommits(scope) {
  // ROOT 가 저장소 하위일 수 있다. git 은 늘 저장소 루트 기준 경로를 주므로 맞춰준다.
  const prefix = (git(['rev-parse', '--show-prefix']).stdout ?? '').trim()
  const full = scope ? `${prefix}${scope}` : prefix || null

  const args = ['log', '--no-merges', '--diff-filter=A', '--format=@%H', '--name-only', `-n${MAX_ADD_COMMITS}`]
  if (full) args.push('--', full)
  const a = git(args)
  if (a.status !== 0) return null

  const added = new Map() // sha -> 이 커밋이 범위 안에 새로 만든 파일
  let cur = null
  for (const line of (a.stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('@')) { cur = t.slice(1); added.set(cur, []); continue }
    if (cur) added.get(cur).push(t)
  }
  const shas = [...added.keys()].filter((s) => added.get(s).length)
  if (!shas.length) return []

  // 그 커밋들이 건드린 **전부**. 범위를 걸지 않는다.
  const b = git(['log', '--no-walk', '--no-merges', '--format=@%H', '--name-only', ...shas])
  if (b.status !== 0) return null

  const touched = new Map()
  cur = null
  for (const line of (b.stdout ?? '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('@')) { cur = t.slice(1); touched.set(cur, []); continue }
    if (cur) touched.get(cur).push(t)
  }

  // 화면의 노드 id 는 ROOT 기준이므로 prefix 를 벗긴다. 벗겨지지 않는 것은
  // ROOT 밖의 파일이라 화면에 없다 — 그래도 등록 지점일 수 있으므로 버리지 않고 그대로 둔다.
  const strip = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p)

  return shas.map((sha) => ({
    sha,
    added: added.get(sha).map(strip),
    touched: (touched.get(sha) ?? []).map(strip),
  }))
}

/**
 * ⑤가 기본으로 물어볼 범위 — "새로 만든다면 아마 여기" 인 폴더.
 *
 * 파일이 가장 많은 폴더를 고른다. 신입에게 실제로 시키는 일이 대개
 * "이 목록에 하나 더 추가해줘" 이기 때문이다 (theHarvester 라면 `discovery/`).
 *
 * 테스트·문서 폴더는 뺀다. 거기에 새로 만드는 것은 결과물이 아니라 부산물이다.
 * 못 고르면 null 을 내고 저장소 전체를 본다 — 추측해서 엉뚱한 폴더를 답으로
 * 내놓는 것보다 범위가 넓은 편이 낫다.
 */
const AUX_DIR = /(^|\/)(tests?|__tests__|spec|specs|docs?|examples?|samples?|fixtures?|vendor|node_modules)(\/|$)/i

/**
 * ⑤가 물어볼 범위를 고르고, **그곳이 무엇인지도 함께** 낸다.
 *
 * 🔴 이름 없이 폴더만 주면 절반만 답한 것이다.
 *
 * 2회차 온보딩 실험에서 에이전트가 정확히 이 틈을 짚었다 —
 * ⑤가 `theHarvester/discovery` 의 등록 지점을 정확히 알려줬는데,
 *
 * > "discovery 폴더 = 새 데이터 소스가 들어가는 곳" 이라는 연결 자체는
 * > 도구가 문장으로 말해준 게 아니라 내가 파일명을 보고 추론한 것이다.
 *
 * 즉 "어디를 고치나" 는 답했는데 "여기가 어디냐" 를 안 말했다. 신입은 그 둘이
 * 다 있어야 움직인다. README 가 이미 그 폴더에 이름을 붙여뒀다 —
 * "Discovery routes and enrichment". 그것을 가져와 같이 낸다.
 *
 * 커밋은 읽지 않는다. modulesOf·docLines·matchDocs 는 순수 함수라
 * 경로와 README 만으로 이름을 짓는다 (featuregraph.mjs 가 쓰는 것과 같은 것).
 */
function pickScope(nodes) {
  const paths = nodes.map((n) => String(n.id ?? ''))
  const { mods, root } = modulesOf(paths)

  let readme = null
  for (const f of ['README.md', 'README.rst', 'readme.md', 'README']) {
    try { readme = fs.readFileSync(path.join(ROOT, f), 'utf8'); break } catch { /* 다음 후보 */ }
  }
  const docs = matchDocs(mods, docLines(readme), { skip: root })

  // 후보: 테스트·문서가 아닌 묶음. README 가 이름 붙인 것을 먼저 본다 —
  // 저자가 "여기는 이런 곳" 이라고 이미 말해둔 곳이 신입이 갈 곳이다.
  const cand = [...mods]
    .filter(([dir]) => dir && !AUX_DIR.test(dir))
    .map(([dir, files]) => ({ dir, files: files.length, doc: docs.get(dir) ?? null }))
  if (!cand.length) return null

  cand.sort((a, b) =>
    (b.doc ? 1 : 0) - (a.doc ? 1 : 0)      // README 가 이름 붙인 것 우선
    || b.files - a.files                    // 그 다음 파일이 많은 것
    || (a.dir < b.dir ? -1 : 1))            // 동률은 이름으로 — 답을 결정론적으로

  const w = cand[0]
  return {
    dir: w.dir,
    files: w.files,
    name: w.doc?.label ?? null,
    // 🔴 이름의 출처를 반드시 같이 낸다. 비전공자에게는 이것이 유일한 검증 수단이다.
    nameSource: w.doc ? 'docs' : 'path',
    docLine: w.doc?.line ?? null,
    why: w.doc
      ? 'README 가 이름을 붙인 묶음 중 파일이 가장 많다'
      : '테스트·문서를 뺀 폴더 중 파일이 가장 많다 (README 가 이름 붙인 곳은 없었다)',
  }
}

/** git 을 두 번 읽으므로 캐시한다. 커밋이 늘 때만 달라진다 — 감시자가 비운다. */
let newFileCache = null
function newFileForFlow(nodes) {
  if (newFileCache) return newFileCache
  const place = pickScope(nodes)
  const scope = place?.dir ?? null
  const commits = newFileCommits(scope)
  if (commits === null) {
    return (newFileCache = { answered: false, why: 'git 히스토리를 읽지 못했습니다', scope, place, points: [] })
  }
  const r = registrationPoints(commits)
  return (newFileCache = {
    ...r,
    scope,
    // 어디를 고치나 + 여기가 어디냐. 둘 다 있어야 신입이 움직인다.
    place,
    sentence: sayNewFile(r, scope),
    capped: commits.length >= MAX_ADD_COMMITS ? MAX_ADD_COMMITS : null,
  })
}

/**
 * 이 저장소의 기본 브랜치.
 *
 * 🔴 `main` 을 하드코딩하고 있었다. theHarvester 는 `master` 라서 PR 화면이
 * 첫 진입에 바로 에러를 냈다 — 온보딩 실험에서 에이전트가 "PR 비교 기능이
 * 고장났다고 오해하고 포기할 수도 있다" 고 적었다.
 *
 * `origin/HEAD` 가 원격이 스스로 선언한 기본 브랜치라 가장 믿을 만하다.
 * 클론이 그것을 안 받았을 수 있으므로(--single-branch 등) 흔한 이름을 차례로 본다.
 * 그래도 없으면 **추측하지 않고 null** 을 낸다. 호출자가 있는 브랜치 목록을 보여준다.
 */
let defaultBaseCache
function defaultBase() {
  if (defaultBaseCache !== undefined) return defaultBaseCache
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (head.status === 0) {
    const name = head.stdout.trim().replace(/^origin\//, '')
    if (name) return (defaultBaseCache = name)
  }
  for (const cand of ['main', 'master', 'trunk', 'develop']) {
    for (const ref of [cand, `origin/${cand}`]) {
      if (git(['rev-parse', '--verify', `${ref}^{commit}`]).status === 0) return (defaultBaseCache = cand)
    }
  }
  return (defaultBaseCache = null)
}

/**
 * base 로 받아도 되는 문자열인가.
 *
 * 🔴 `-` 로 시작하는 값을 그대로 넘기면 git 이 그것을 **옵션으로 읽는다.**
 *    `?base=--upload-pack=...` 같은 값이 인자 자리에 들어가는 순간 우리가 의도한
 *    명령이 아니게 된다. spawnSync 는 셸을 안 거치므로 셸 주입은 없지만,
 *    git 자신의 옵션 파싱은 그대로 살아 있다.
 *
 *    이 뷰어는 `--auth` 로 밖에 열릴 수 있다(server 상단 주석). 그러니 입력은
 *    로컬이라고 가정하지 않는다. 애매하면 거부한다.
 */
const REF_OK = /^[A-Za-z0-9._/~^@{}-]{1,200}$/
const validRef = (s) => REF_OK.test(s) && !s.startsWith('-') && !s.includes('..')

/**
 * 저장소 루트 기준 경로를 **노드 ID 기준**으로 맞춘다.
 *
 * 🔴 `git diff --name-status` 는 저장소 루트 기준 경로를 준다. 뷰어를 하위
 *    디렉터리로 열면(`node app/server.mjs <repo>/server`) 노드 ID 는 그
 *    디렉터리 기준이라 하나도 안 맞는다. 그대로 두면 "바뀐 파일이 그래프에
 *    하나도 없다" 는 틀린 결론이 나온다 — cochange.mjs 가 같은 자리에서
 *    같은 처리를 한다.
 *
 *    `--relative` 를 쓰면 git 이 대신 해주지만, 그러면 **범위 밖 파일이 몇 개
 *    잘렸는지**를 알 수 없다. 그 수를 화면에 말해야 하므로 직접 자른다.
 */
function scopeToRoot(files) {
  const prefix = git(['rev-parse', '--show-prefix']).stdout?.trim() ?? ''
  if (!prefix) return { files, outside: 0 }
  const kept = []
  let outside = 0
  for (const f of files) {
    if (f.path.startsWith(prefix)) kept.push({ ...f, path: f.path.slice(prefix.length) })
    else outside++
  }
  return { files: kept, outside }
}

/** `git diff --name-status` 한 줄을 {path, code} 로. 이름변경은 새 이름을 쓴다. */
function parseNameStatus(out) {
  const files = []
  for (const line of (out ?? '').split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0].trim()
    // R100 old new / C75 old new — 새 경로가 마지막이다
    const p = parts[parts.length - 1].trim()
    if (!p) continue
    files.push({ path: p, code: code[0], where: 'diff' })
  }
  return files
}

/**
 * diff 대상을 정한다.
 *
 * 🔴 git 이 없거나 base 가 없으면 **조용히 빈 결과를 내지 않는다.**
 *
 * 이 화면의 답이 "빠진 것 없음" 인지 "판정하지 못함" 인지가 전부다.
 * 빈 목록을 결과처럼 내놓으면 사용자는 확인했다고 믿는다 — 그 착각을
 * 만드는 것이 이 도구가 할 수 있는 가장 나쁜 실패다 (D5).
 */
function prChanges(baseArg) {
  if (!fs.existsSync(path.join(ROOT, '.git')) && git(['rev-parse', '--git-dir']).status !== 0) {
    return { error: `git 저장소가 아닙니다 (${ROOT}) — PR 화면은 diff 로 답하므로 git 없이는 아무 말도 할 수 없습니다.` }
  }
  if (git(['rev-parse', '--verify', 'HEAD']).status !== 0) {
    return { error: '커밋이 하나도 없습니다 — 비교할 기준(HEAD)이 없습니다. 첫 커밋 뒤에 다시 열어주세요.' }
  }

  // 작업트리 변경은 언제나 본다. "올리기 전" 화면이므로 아직 커밋 안 한 것이
  // 오히려 주인공이다. ?worktree=0 으로 끌 수 있다.
  const st = git(['status', '--porcelain=v1', '-uall'])
  // 상태를 못 읽으면 "작업트리에 변경 없음" 으로 보이게 된다. 그건 조용한 거짓말이다.
  if (st.status !== 0) {
    return { error: `git status 실패: ${(st.stderr ?? '').trim().split('\n')[0] || '알 수 없는 오류'}` }
  }
  const work = []
  for (const line of (st.stdout ?? '').split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2).trim()
    const raw = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '')
    work.push({ path: raw, code: code[0] === '?' ? 'A' : code[0], where: 'worktree' })
  }

  // 'default' 는 "이 저장소의 기본 브랜치" 라는 뜻이다. 화면이 main 을 박아 보내면
  // master 를 쓰는 저장소에서 매번 에러가 난다.
  const asked = String(baseArg ?? 'default')
  const wantBase = asked === 'default' ? defaultBase() : asked
  // 작업트리만 보고 싶을 때. 커밋 전 마지막 확인이 이 모드다.
  if (['working', 'worktree', 'none', ''].includes(String(wantBase))) {
    return { base: null, mode: 'worktree', diff: [], worktree: work }
  }
  if (!wantBase) {
    const brs = (git(['for-each-ref', '--format=%(refname:short)', '--count=12', 'refs/heads', 'refs/remotes']).stdout ?? '')
      .split('\n').map((s) => s.trim()).filter(Boolean)
    return {
      error: '기본 브랜치를 정하지 못했습니다 (origin/HEAD 도 main·master·trunk·develop 도 없습니다).',
      hint: brs.length ? `이 저장소에 있는 것: ${brs.join(', ')}` : 'branch 가 하나도 없습니다.',
    }
  }
  if (!validRef(wantBase)) {
    return { error: `base 로 쓸 수 없는 값입니다: ${wantBase}` }
  }

  // 로컬에 없으면 origin/ 을 한 번 더 본다. 클론한 저장소는 `main` 이 로컬
  // 브랜치로 없고 `origin/main` 만 있는 경우가 흔하다 (fetchrepo.mjs 로 받은 것 포함).
  let ref = null
  for (const cand of [wantBase, `origin/${wantBase}`]) {
    if (git(['rev-parse', '--verify', `${cand}^{commit}`]).status === 0) { ref = cand; break }
  }
  if (!ref) {
    const brs = (git(['for-each-ref', '--format=%(refname:short)', '--count=12', 'refs/heads', 'refs/remotes']).stdout ?? '')
      .split('\n').map((s) => s.trim()).filter(Boolean)
    return {
      error: `'${wantBase}' 라는 ref 가 없습니다 (origin/${wantBase} 도 없습니다).`,
      hint: brs.length ? `이 저장소에 있는 것: ${brs.join(', ')}` : 'branch 가 하나도 없습니다.',
    }
  }

  // PR 이 묻는 것은 "이 브랜치가 base 에서 갈라진 뒤 무엇을 했나" 다.
  // 그래서 두 점(base..HEAD)이 아니라 공통 조상 기준이다 — base 쪽에서 그 뒤에
  // 일어난 일은 이 PR 이 한 일이 아니다.
  const mb = git(['merge-base', ref, 'HEAD'])
  if (mb.status !== 0) {
    return { error: `'${ref}' 와 HEAD 의 공통 조상을 찾지 못했습니다 — 관계 없는 히스토리일 수 있습니다.` }
  }
  const base = mb.stdout.trim()
  const d = git(['diff', '--name-status', '-M', base, 'HEAD'])
  if (d.status !== 0) {
    return { error: `git diff 실패: ${(d.stderr ?? '').trim().split('\n')[0] || '알 수 없는 오류'}` }
  }
  const ahead = Number((git(['rev-list', '--count', `${base}..HEAD`]).stdout ?? '0').trim()) || 0

  return {
    base, ref, ahead, mode: 'branch',
    diff: parseNameStatus(d.stdout),
    worktree: work,
  }
}

// 작성자 이력은 git log 를 훑어야 해서 비싸다. 파일이 바뀔 때만 다시 계산한다.
let authorCache = null
function authors() {
  if (!authorCache) authorCache = authorMap(ROOT)
  return authorCache
}

/**
 * 장부를 원격에서 당겨온다.
 *
 * 🔴 서버는 지금까지 **로컬 장부만 읽었다.** CLI 는 claim/status 때마다
 *    fetch 하는데(bin/axmap.mjs syncLedger) 서버는 안 했다. 그래서 다른
 *    컴퓨터에서 일하는 사람이 잡은 것이 **감시 화면에 영영 안 뜬다.**
 *    두 대로 협업을 시작하자마자 드러난 구멍이다.
 *
 * 🔴 `reset --hard` 를 조건 없이 하지 않는다.
 *
 *    CLI 는 그렇게 한다 — claim 이 CAS 로 즉시 push 되므로 로컬에 안 밀린
 *    것이 없다고 전제할 수 있기 때문이다. 서버는 그 전제를 세울 수 없다.
 *    push 가 실패한 직후일 수도 있고, 그때 reset 하면 **남의 락이 아니라
 *    내 락이 조용히 사라진다.** 그건 두 사람이 같은 코드를 고치게 만드는
 *    바로 그 실패다. 그러니 빨리 감기가 되는 경우에만 옮기고,
 *    갈라졌으면 옮기지 않고 **갈라졌다고 말한다.**
 *
 * 🔴 `fetch` 는 반드시 장부 worktree **안에서** 돌린다. `FETCH_HEAD` 는
 *    worktree 별로 따로 보관되므로 메인에서 fetch 하면 장부 쪽에서 못 본다.
 */
const LEDGER_DIR = path.join(ROOT, '.axmap', 'ledger')
const LEDGER_SYNC_MS = 8000
let ledgerSync = { at: null, ok: null, why: '아직 시도 안 함' }
let ledgerSyncing = false

function syncLedgerSoon() {
  if (ledgerSyncing) return
  if (ledgerSync.at && Date.now() - ledgerSync.at < LEDGER_SYNC_MS) return
  if (!fs.existsSync(LEDGER_DIR)) { ledgerSync = { at: Date.now(), ok: null, why: '장부가 없습니다' }; return }
  ledgerSyncing = true
  // 화면을 막지 않는다. 이번 요청은 디스크에 있는 것으로 답하고, 다음
  // 요청이 새 것을 본다. 8초 안에 두 번 당기지 않는다.
  const p = spawn('git', ['fetch', '--quiet', 'origin', 'axmap/claims'],
    { cwd: LEDGER_DIR, stdio: 'ignore', windowsHide: true })
  p.on('error', (e) => { ledgerSyncing = false; ledgerSync = { at: Date.now(), ok: false, why: e.message } })
  p.on('exit', (code) => {
    ledgerSyncing = false
    if (code !== 0) { ledgerSync = { at: Date.now(), ok: false, why: '원격 장부에 닿지 못했습니다' }; return }
    const ff = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'],
      { cwd: LEDGER_DIR, windowsHide: true })
    if (ff.status !== 0) {
      // 갈라졌다. 옮기면 내 락이 사라질 수 있으므로 옮기지 않는다.
      ledgerSync = { at: Date.now(), ok: false, why: '로컬 장부가 원격과 갈라졌습니다 — 화면이 오래됐을 수 있습니다' }
      return
    }
    const r = spawnSync('git', ['reset', '--hard', '--quiet', 'FETCH_HEAD'],
      { cwd: LEDGER_DIR, windowsHide: true })
    ledgerSync = r.status === 0
      ? { at: Date.now(), ok: true, why: null }
      : { at: Date.now(), ok: false, why: '장부를 옮기지 못했습니다' }
  })
}

function liveState() {
  syncLedgerSoon()
  const { available: ledger, claims } = readClaims(ROOT, Date.now(), ME)
  const { available: git, files } = modifiedFiles(ROOT)
  // 그래프 노드 목록을 넘겨야 디렉터리 claim 이 그 아래 파일까지 물든다
  const ov = overlay(claims, files, graph().nodes.map((n) => n.id))
  return {
    ledgerAvailable: ledger,
    gitAvailable: git,
    me: ME,
    /**
     * 🔴 장부를 못 읽었으면 빈 배열이 아니라 null 이다.
     *
     * 벤치마크에서 텍스트만 보는 신입이 `claims: []` 를 읽고
     * "아무도 안 잡고 있다" 고 확신 있게 틀린 답을 냈다.
     * 빈 배열은 "없다" 이고 null 은 "모른다" 다. 섞으면 안 된다.
     */
    claims: ledger ? claims : null,
    modified: files,
    overlay: ledger ? Object.fromEntries(ov) : null,
    summary: liveSummary(claims, files, ov, ledger),
    // 🔴 언제 마지막으로 원격을 봤나. 이걸 안 내면 오래된 화면이 최신인 척한다 —
    //    선점 화면에서 그건 "아무도 안 잡고 있다" 는 거짓말이 된다.
    sync: ledgerSync,
  }
}

const clients = new Set()
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) res.write(payload)
}

const watcher = watch(ROOT, () => {
  graphCache = null // 구조가 바뀌었을 수 있다
  authorCache = null // 커밋이 늘었을 수 있다
  featureCache = null // 커밋이 늘면 클러스터도 달라진다
  newFileCache = null // 새 파일이 추가되면 등록 지점도 달라진다
  broadcast('live', liveState())
})
if (!watcher.ok) console.error(`파일 감시 실패 (수동 새로고침 필요): ${watcher.error}`)

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  /**
   * 🔴 `.mjs` 가 빠져 있었다. 그리고 그 결과가 조용하지 않고 **치명적**이다.
   *
   * 브라우저는 ES 모듈을 **JS MIME 이 아니면 실행을 거부한다**(strict MIME
   * checking). `text/plain` 으로 주면 `import` 가 통째로 실패하고, 그 예외가
   * 부트스트랩 체인을 끊어 화면이 백지가 된다. 파일은 200 으로 잘 내려가므로
   * 네트워크 탭만 보면 멀쩡해 보인다.
   *
   * `app/lib/*.mjs` 를 화면에 주기 시작하면서 처음 드러났다. 연기 검사가
   * 잡았다 — 그게 없었으면 "코드가 왜 안 도나" 를 한참 팠을 것이다.
   */
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

function json(res, body, code = 200) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(s)
}

function safeJoin(base, rel) {
  const p = path.resolve(base, rel)
  return p.startsWith(path.resolve(base)) ? p : null
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const q = url.searchParams

  try {
    // ── 인증 ──────────────────────────────────────────────────────────────
    // 🔴 다른 어떤 분기보다 먼저다. 라우트 사이에 두면 그 위의 라우트는 그냥 뚫린다.
    //
    // 실제로 뚫려 있었다. 게이트가 정적 분기와 `/api/graph` **아래** 있어서
    // 인증 없이 `/` 는 200 을 주고 `/api/graph` 는 파일 경로·줄수를 전부 내줬다.
    // 주석에는 "모든 요청에 건다" 라고 적혀 있었고 코드는 아니었다 —
    // 락에서 금지한 fail-open 과 같은 종류다.
    //
    // 새 라우트를 이 블록 위에 추가하면 그 라우트만 조용히 열린다.
    // 그래서 게이트를 try 의 첫 문장으로 고정한다.
    if (AUTH && !sameSecret(req.headers.authorization ?? '', AUTH)) {
      res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="axmap", charset="UTF-8"',
        'content-type': 'application/json; charset=utf-8',
      })
      return res.end(JSON.stringify({ error: '인증이 필요합니다' }))
    }

    /**
     * `/_bm/` 을 `/api/` 로 되돌린다 (위 API_ALIAS 주석 참조).
     *
     * 🔴 정적 분기보다 **먼저**다.
     *
     * 아래 정적 분기의 조건은 `!pathname.startsWith('/api/')` 다. 별칭을
     * 나중에 풀면 `/_bm/flow` 는 그 조건을 통과해 **정적 파일로 취급되어
     * 404** 가 된다. 화면은 언제나 `_bm/` 로 부르므로(overlay.js 의 api()),
     * 이 순서가 뒤집혀 있던 동안 뷰어는 데이터를 하나도 못 받았다.
     * 리버스 프록시 뒤에서만 깨지는 줄 알았는데 로컬에서도 깨져 있었다.
     *
     * 인증 뒤에 두는 것은 유지한다 — 별칭으로 인증을 우회할 수 있으면 안 된다.
     */
    if (url.pathname.startsWith(API_ALIAS)) {
      url.pathname = `/api/${url.pathname.slice(API_ALIAS.length)}`
    }

    // ── 정적 ──────────────────────────────────────────────────────────────
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      /**
       * 화면은 하나다 — `shell.html`.
       *
       * 🔴 예전 화면(`index.html` · `overlay.js`)은 지웠다. 한동안 `/classic` 으로
       * 남겨 뒀는데, 남겨 두는 것 자체가 "저기 있으니 나중에 가져다 쓰자" 는
       * 여지를 만든다. 재활용할 것이 아니면 여지를 남기지 않는다.
       *
       * 벤치 3회차의 측정 대상은 **git 에 그대로 있다** — `git show <커밋>:app/web/overlay.js`
       * 로 언제든 꺼내서 그 시점 그대로 돌릴 수 있다. 작업 트리에서 지운 것이
       * 기준선을 없앤 것은 아니다.
       */
      const rel = url.pathname === '/' ? 'shell.html' : url.pathname.slice(1)
      /**
       * 🔴 `app/lib/` 의 **순수 모듈**은 브라우저에도 그대로 준다.
       *
       * `reveal.mjs` 는 fs 도 git 도 안 만지는 순수 함수뿐이다. 그것을 화면
       * 쪽에 다시 구현하면 두 벌이 되고, 한쪽만 고치면 조용히 갈린다 —
       * 이 저장소가 `LANG` 표에서 이미 한 번 당한 실패다.
       *
       * 같은 파일이 서버에서 테스트되고 브라우저에서 돌아간다. `test/` 가
       * 검증하는 그 코드가 화면에서도 그대로 도는 것이 요점이다.
       */
      const file = rel.startsWith('lib/')
        ? safeJoin(path.join(ROOT_DIR_OF_APP, 'lib'), rel.slice(4))
        : safeJoin(WEB, rel)
      if (!file || !fs.existsSync(file)) {
        res.writeHead(404).end('not found')
        return
      }
      /**
       * 🔴 화면 파일은 캐시하지 않는다.
       *
       * 캐시 헤더가 아예 없었다. 그러면 브라우저가 휴리스틱으로 알아서 캐시하고,
       * axMap 을 고쳐도 **옛 화면이 계속 뜬다.**
       *
       * 실제로 이것 때문에 반나절을 잃을 뻔했다 — 물리 정지 코드를 넣고 몇 번을
       * 고쳐도 화면이 안 변해서 코드를 의심했는데, 서버는 새 파일을 주고 있었고
       * 브라우저가 옛 `graph.js` 를 쓰고 있었다. HTML 에 `?cb=` 를 붙여도 모듈
       * URL 은 그대로라 안 바뀐다.
       *
       * 이건 로컬 개발 뷰어다. 대역폭보다 **지금 고친 것이 지금 보이는 것**이
       * 훨씬 중요하다.
       */
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'text/plain',
        'cache-control': 'no-store, must-revalidate',
      })
      fs.createReadStream(file).pipe(res)
      return
    }

    // ── 그래프 ────────────────────────────────────────────────────────────
    if (url.pathname === '/api/graph') {
      const g = graph()
      json(res, { root: ROOT, ...g })
      return
    }

    // 읽기전용이면 상태를 바꾸는 요청을 전부 막는다. 개별 라우트에 흩어 놓으면
    // 새 엔드포인트를 추가할 때 빠뜨린다 — 한 곳에서 막아야 빠뜨릴 수 없다.
    if (READONLY && req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, { error: '읽기 전용으로 열린 서버입니다 (--readonly)' }, 403)
    }

    if (url.pathname === '/api/overlay') {
      const { co: _co, ...o } = overlayGraph() // co 는 서버 내부용 (Map 이라 직렬화 안 된다)
      json(res, { root: ROOT, ...o })
      return
    }

    // 기능 범위 — "사진 업로드만 보여줘"
    // 이름으로는 못 찾는다. 커밋 메시지(사람이 남긴 의도)와 공변경으로 넓힌다.
    if (url.pathname === '/api/scope') {
      const query = q.get('q') ?? ''
      const o = overlayGraph()
      if (!o.co) { json(res, { error: 'git 히스토리가 없어 기능 범위를 만들 수 없습니다' }, 400); return }
      const s = featureScope(ROOT, query, {
        ids: new Set(o.nodes.map((n) => n.id)), freq: o.co.freq, coEdges: o.co.edges,
      })
      json(res, s ?? { error: '질의가 비었습니다' }, s ? 200 : 400)
      return
    }

    // 진입점 — "어디서부터 읽어야 하나".
    // 점수 하나로 줄 세우지 않고, 서로 다른 질문에 답하는 목록 넷을 준다 (entry.mjs).
    if (url.pathname === '/api/entry') {
      const o = overlayGraph()
      const core = coreSubset(o.nodes, o.edges, o.freq)
      json(res, {
        ...entryPoints({ nodes: o.nodes }, o.edges, o.freq),
        core: core.ids ? { ids: [...core.ids], seeds: core.seeds, reason: core.reason } : null,
      })
      return
    }

    /**
     * 기본 흐름 — 다섯 걸음 (D15).
     *
     * 🔴 `/api/entry` 와 다르다. entry 는 **질문 넷에 각각 답하는 병렬 목록**이고,
     *    여기는 **따라가는 순서**다. 둘 다 있어야 한다 —
     *    처음 온 사람에게는 순서가, 목적이 있는 사람에게는 목록이 맞다.
     *
     * ④는 entry 의 결과를 그대로 재사용한다. 같은 숫자를 두 번 계산하면
     * 두 화면이 서로 다른 답을 하게 된다.
     */
    /**
     * 기능 단위 그래프 — 파일이 아니라 사람의 말 (featuregraph.mjs).
     *
     * 🔴 파일 그래프를 대신하는 것이 아니라 **다른 축**이다.
     *    코드를 읽을 줄 아는 사람에게는 파일이, 그렇지 않은 사람에게는
     *    모듈 이름이 맞다. 화면이 오갈 수 있게 둘 다 준다.
     */
    if (url.pathname === '/api/featuregraph') {
      const o = overlayGraph()
      const { available, commits } = commitFiles(ROOT, { since: '10 years ago', maxCommits: 4000 })
      let readme = null
      for (const f of ['README.md', 'README.rst', 'readme.md', 'README']) {
        try { readme = fs.readFileSync(path.join(ROOT, f), 'utf8'); break } catch { /* 다음 후보 */ }
      }
      const fg = featureGraph({
        paths: o.nodes.map((n) => n.id),
        commits: available ? commits : [],
        readme,
        edges: o.edges,
      })
      // 파일 줄수를 모듈에 합쳐 넣는다 — 화면이 노드 크기로 쓴다.
      const lines = new Map(o.nodes.map((n) => [n.id, n.lines ?? 0]))
      for (const n of fg.nodes) n.lines = n.paths.reduce((a, p) => a + (lines.get(p) ?? 0), 0)
      json(res, { ...fg, historyAvailable: available })
      return
    }

    if (url.pathname === '/api/flow') {
      const o = overlayGraph()
      const live = liveState()
      const f = basicFlow(ROOT, { nodes: o.nodes, edges: o.edges }, {
        entry: entryPoints({ nodes: o.nodes }, o.edges, o.freq),
        claims: live.claims,
        newFile: newFileForFlow(o.nodes),
      })

      /**
       * ③걸음이 "중심까지 가는 길" 을 **먼저 답한다.**
       *
       * 🔴 세 변형을 재고 나온 결론이다. ①(사슬)만 M3 를 앞당겼고, ②(사다리)와
       *    ③(질의 상자)은 **보고서에 이름조차 안 나왔다.** 기본 배치로 뒀는데도,
       *    걸음 안에 넣었는데도 그랬다. 신입은 번호 매긴 걸음을 따라갈 뿐
       *    **옆에 놓인 것을 발견하지 않는다.**
       *
       *    그런데 ③ 회차가 가장 완전한 답을 냈다 — ②가 "모른다" 로 끝낸
       *    연결을 끝까지 이었다. 도구가 나빠서가 아니라 **묻게 만들어서**
       *    느렸던 것이다. 그러니 묻기를 기다리지 말고 먼저 답한다.
       *
       * 🔴 "중심" 은 추측이 아니라 관측이다 — **가장 많은 파일이 부르는 파일**.
       *    테스트·예제는 뺀다. 그것들은 많이 부르지 많이 불리지 않는다.
       */
      const s3 = f.steps.find((s) => s.n === 3)
      if (s3?.answer?.chain?.start) {
        const inDeg = new Map()
        for (const e of o.edges) {
          if (e.hub || e.origin === 'cochange') continue
          if (isAux(e.target)) continue
          inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
        }
        const [center, deg] = [...inDeg.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? []
        // 중심이 시작점 자신이거나 부르는 곳이 한 줌이면 말할 것이 없다.
        if (center && center !== s3.answer.chain.start && deg >= 5) {
          s3.answer.toCenter = {
            ...pathBetween(o.nodes, o.edges, s3.answer.chain.start, center),
            calledBy: deg,
          }
        }
      }

      /**
       * ④걸음의 날 숫자를 코퍼스 분포에 댄다.
       *
       * 🔴 `go.mod 865회` 를 보고 신입이 할 수 있는 판단은 없다. 865가 많은
       *    건지 원래 그런 건지 알 방법이 없기 때문이다. 같은 언어·규모
       *    저장소 수천 개의 분포와 대면 그제야 객관적 진술이 된다.
       *
       * 🔴 `hot`(커밋 수)만 붙인다. `risk`(숨은 이웃 수)에 대응하는 코퍼스
       *    지표가 무엇인지 확실하지 않다. 어긋난 지표로 등수를 매기면 그건
       *    없는 근거를 만들어내는 것이고, 여기서 가장 나쁜 종류의 실패다.
       */
      const cell = cellFor(BASELINE, {
        lang: dominantLang(o.nodes.map((n) => n.id)),
        commits: o.stats?.commits ?? null,
      })
      const hot = f.steps.find((s) => s.n === 4)?.answer?.hot
      if (cell?.fileCommits && hot?.rows) {
        for (const r of hot.rows) r.band = bandOf(cell.fileCommits, r.freq)
        hot.corpus = {
          cell: cell.key, repos: cell.repos, at: BASELINE?.at ?? null,
          metric: '파일당 커밋 수', n: cell.fileCommits.n ?? null,
        }
      }
      json(res, f)
      return
    }

    /**
     * 사다리 — 힘 그래프를 대신하는 배치 (변형 ②).
     *
     * 🔴 `/api/flow` 의 ③걸음과 **같은 데이터**를 다르게 자른다. 안내록은
     *    "몇 겹에 몇 개" 를 요약하고, 여기는 오른쪽 넓은 자리에 전부 편다.
     *    두 곳의 도달 판정이 어긋나면 안 되므로 `test/ladder.test.mjs` 가
     *    `layersFrom` 과 도달 수가 같은지 못박는다.
     */
    /**
     * ── 하위 프로젝트 ─────────────────────────────────────────────────────
     *
     * 모노레포에서 "어디서부터 읽나" 의 **첫 답은 파일이 아니라 프로젝트**다.
     * 왜 필요한지는 `app/lib/roots.mjs` 머리말 (실측 포함).
     */
    if (url.pathname === '/api/roots') {
      const g = graph()
      const roots = findRoots(ROOT, g.nodes)
      json(res, { roots, ...splitNeeded(roots, g.nodes) })
      return
    }

    if (url.pathname === '/api/ladder') {
      const o = overlayGraph()
      /**
       * `?root=FE/bbiyong-react` — 그 하위 프로젝트 안에서만 겹을 만든다.
       *
       * 🔴 진입점도 **그 안에서** 다시 찾는다. 저장소 최상위 기준으로 찾으면
       * 모노레포에서 엉뚱한 것이 잡힌다 — 실측에서 JIRA 자동화 스크립트가
       * 잡혀 549개 중 14개만 닿았다.
       */
      const sub = (q.get('root') ?? '').replace(/^\/+|\/+$/g, '')
      if (sub) {
        const nodes = o.nodes.filter((n) => n.id === sub || n.id.startsWith(`${sub}/`))
        const ids = new Set(nodes.map((n) => n.id))
        const edges = o.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
        const starts = entryStarts(ROOT, nodes, edges, { prefix: sub })
        return json(res, {
          root: sub,
          ...ladder(nodes, edges, starts, {
            perGroup: Number(q.get('perGroup')) || 8,
            maxGroups: Number(q.get('maxGroups')) || 6,
          }),
        })
      }
      // ③걸음과 **같은** 시작점을 쓴다. 따로 뽑으면 두 화면이 다른 말을 한다.
      const num = (k, d, max) => {
        const v = Number(q.get(k))
        // 이상한 입력은 안전한 값으로 치환하지 않고 기본값으로 되돌린다.
        return Number.isFinite(v) && v > 0 ? Math.min(v, max) : d
      }
      json(res, ladder(o.nodes, o.edges, entryStarts(ROOT, o.nodes, o.edges), {
        perGroup: num('perGroup', 8, 400),
        maxGroups: num('maxGroups', 6, 60),
      }))
      return
    }

    /**
     * 두 파일 사이 경로 (변형 ③).
     *
     *   /api/path?from=a.go&to=b.go
     *   /api/path?to=b.go            from 을 비우면 진입점 전부에서 시도한다
     *
     * 🔴 `from` 을 생략할 수 있게 한 것이 중요하다. 신입은 출발점을 모른다 —
     *    "이 기능이 어디서 시작되나" 를 묻고 싶은 것이지 "A 에서 B" 를 묻고
     *    싶은 게 아니다. 진입점은 ②걸음이 이미 알고 있다.
     */
    if (url.pathname === '/api/path') {
      const o = overlayGraph()
      const to = q.get('to')
      if (!to) { json(res, { found: false, why: '도착 파일을 지정해주세요' }); return }
      const from = q.get('from')
      if (from) { json(res, pathBetween(o.nodes, o.edges, from, to)); return }
      // 진입점마다 시도하고 **가장 짧은** 것을 낸다. import 로 이어지는 것이
      // 있으면 그것이 우선이다 (pathBetween 안의 판단과 같은 이유).
      const starts = entryStarts(ROOT, o.nodes, o.edges)
      const tries = starts.map((s) => pathBetween(o.nodes, o.edges, s, to)).filter((r) => r.found)
      const best = tries.sort((a, b) =>
        (a.via === 'import' ? 0 : 1) - (b.via === 'import' ? 0 : 1) || a.hops.length - b.hops.length)[0]
      json(res, best ?? {
        from: null, to, found: false, triedStarts: starts,
        why: `진입점 ${starts.length}개 어디서도 ${to} 로 이어지지 않습니다.`
          + ' 정적 파싱이 못 보는 연결이거나, 진입점이 더 있습니다.',
      })
      return
    }

    /**
     * PR — 작업을 올리기 전에 "뭘 바꿨고 어디까지 갔나" (D2 · F2).
     *
     *   /api/pr              base=main (기본)
     *   /api/pr?base=HEAD~1  직전 커밋과 비교
     *   /api/pr?base=working 아직 커밋 안 한 것만
     *   /api/pr?worktree=0   커밋된 것만
     *
     * 🔴 `/api/flow` 와 짝이다. flow 는 작업 **전**(이해), 여기는 작업 **후**(검증).
     *    같은 오버레이 데이터를 쓰지만 묻는 것이 다르다.
     */
    if (url.pathname === '/api/pr') {
      const c = prChanges(q.get('base'))
      if (c.error) {
        // 🔴 200 에 빈 목록을 실어 보내지 않는다. 화면이 "빠진 것 없음" 으로
        //    그리게 되고, 그 착각이 이 화면을 없는 것보다 나쁘게 만든다.
        json(res, { error: c.error, hint: c.hint ?? null, base: q.get('base') ?? 'default' }, 400)
        return
      }
      const useWork = q.get('worktree') !== '0'
      const raw = [...c.diff, ...(useWork ? c.worktree : [])]
      const { files: changed, outside } = scopeToRoot(raw)

      const o = overlayGraph()
      /**
       * Q4 의 "평소" 는 **이번 변경 이전**의 히스토리다.
       *
       * 🔴 merge-base 까지만 본다. 이번 커밋들을 표본에 넣으면 이번 커밋과
       *    이번 커밋을 포함한 평균을 비교하게 되어, 넓은 변경일수록 "평소와
       *    비슷하다" 는 답이 나온다 — 정확히 거꾸로다.
       */
      /**
       * 창을 넓게 잡는다 (30년 · 20,000커밋).
       *
       * 🔴 featuregraph 는 10년 · 4,000 을 쓰는데, 그건 "요즘 무슨 일이
       *    있었나" 를 묻기 때문이다. Q4 는 반대로 **전체 분포**를 물어야 한다 —
       *    창이 좁으면 오래된 저장소에서 "평소" 가 최근 몇 년만 뜻하게 되고,
       *    그 사실이 화면 어디에도 안 나온다. 상한에 걸리면 아래에서 말한다.
       */
      const HIST_MAX = 20000
      const hist = commitFiles(ROOT, {
        since: '30 years ago', maxCommits: HIST_MAX, ref: c.base ?? 'HEAD',
      })

      const r = prReview({
        changed,
        nodes: o.nodes,
        edges: o.edges,
        coEdges: o.co?.edges ?? [],
        freq: o.freq,
        commits: hist.available ? hist.commits : [],
      })

      const gaps = [...r.gaps]
      if (outside) {
        gaps.push({ q: 1, text: `보고 있는 폴더 밖에서 ${outside}개가 함께 바뀌었습니다 — 이 화면은 그것들을 못 봅니다` })
      }
      if (!hist.available) gaps.push({ q: 4, text: 'git log 를 읽지 못해 "평소" 를 비교하지 못했습니다' })
      else if (hist.commits.length >= HIST_MAX) {
        gaps.push({ q: 4, text: `히스토리를 ${HIST_MAX.toLocaleString()}커밋까지만 봤습니다 — 그보다 오래된 것은 "평소" 에 안 들어갔습니다` })
      }

      /**
       * 🔴 PR 이 "이것도 봐야 한다" 고 지목한 파일을 **지금 누가 잡고 있는지** 붙인다.
       *
       * 온보딩 실험에서 에이전트가 짚었다 — PR 이 경고한 누락 파일이 정확히
       * 어떤 동료의 작업 영역이었는데, *"이 인과 연결은 화면이 한 문장으로
       * 안 이어줘서 두 화면을 내가 대조해 추론했다"* 고 적었다.
       *
       * ⑤(새로 만들 곳)에는 이미 붙였다. 같은 원칙을 여기에도 적용한다 —
       * 판정하는 화면과 사람을 아는 화면이 따로 있으면 겹치는 일이 사람 몫이 된다.
       * 거부가 아니라 알림이다. 프로토콜은 건드리지 않는다.
       */
      const nowClaims = liveState().claims
      const holderOf = (p) => {
        const owner = nowClaims.find((cl) => coversPath(cl.paths ?? [], p))
        return owner
          ? { agent: owner.agent ?? null, task: owner.task ?? null, intent: owner.intent ?? null }
          : null
      }
      for (const qq of r.questions ?? []) {
        for (const row of qq.answer?.rows ?? []) {
          const h = holderOf(row.path)
          if (h) row.heldBy = h
          /**
           * 🔴 짝이 되는 쪽도 본다.
           *
           * Q3("같이 바뀌었어야 하는데 안 바뀐 것")의 한 줄은 두 파일 이야기다 —
           * 바뀐 `from` 과 안 바뀐 `path`. 에이전트가 실제로 이은 연결은
           * **바뀐 쪽이 남의 작업 영역**이라는 것이었다. 그쪽을 안 보면
           * 정작 사람이 필요한 정보를 빠뜨린다.
           */
          if (row.from) {
            const hf = holderOf(row.from)
            if (hf) row.heldByFrom = hf
          }
        }
      }

      json(res, {
        ...r,
        gaps,
        source: {
          mode: c.mode,
          base: c.base,
          ref: c.ref ?? null,
          asked: q.get('base') ?? 'default',
          ahead: c.ahead ?? 0,
          diffFiles: c.diff.length,
          worktreeFiles: useWork ? c.worktree.length : 0,
          worktreeIncluded: useWork,
          outside,
          historyCommits: hist.available ? hist.commits.length : 0,
        },
      })
      return
    }

    // 선점 현황 + 기능 인접 경고.
    // 경로는 안 겹치는데 공변경으로 이어진 claim 쌍을 찾는다 (adjacent.mjs).
    // 🔴 경고일 뿐이다. 프로토콜의 판정은 건드리지 않는다.
    if (url.pathname === '/api/watch') {
      // 실시간 상태는 liveState() 가 이미 만든다. 두 벌로 만들면 두 화면이
      // 서로 다른 답을 하게 된다 — 여기서는 기능 인접 경고만 얹는다.
      const live = liveState()
      const o = overlayGraph()
      json(res, {
        ...live,
        available: live.ledgerAvailable,
        adjacency: featureAdjacency(live.claims, o.co?.edges ?? [], o.nodes.map((n) => n.id)),
      })
      return
    }

    /**
     * "여기에 새로 만들려면 어디를 고치나".
     *
     * 온보딩 실험에서 도구가 답하지 못한 유일한 질문이다. 신입이 가장 오래
     * 막히는 자리이기도 하다 — 무엇을 하는 물건인지는 README 가 말하지만
     * "내가 뭘 건드려야 하나" 는 코드를 다 읽은 사람만 안다.
     */
    if (url.pathname === '/api/newfile') {
      const scope = q.get('scope')
      // 경로는 저장소 안이어야 한다. `..` 로 밖을 보게 두지 않는다.
      if (scope && (scope.includes('..') || path.isAbsolute(scope))) {
        return json(res, { error: '범위로 쓸 수 없는 경로입니다' }, 400)
      }
      const commits = newFileCommits(scope)
      if (commits === null) {
        return json(res, { answered: false, why: 'git 히스토리를 읽지 못했습니다', scope, points: [] })
      }
      const r = registrationPoints(commits)
      return json(res, {
        ...r,
        scope: scope ?? null,
        sentence: sayNewFile(r, scope),
        // 🔴 어디까지 봤는지 같이 낸다. 상한에 걸렸는데 말하지 않으면
        //    "전부 봤다" 로 읽힌다 (SPEC 의 조용한 절단 금지와 같은 이유).
        capped: commits.length >= MAX_ADD_COMMITS ? MAX_ADD_COMMITS : null,
      })
    }

    if (url.pathname === '/api/depths') {
      const start = q.get('start')
      const g = graph()
      if (!g) return json(res, { depths: {} })
      const node = g.nodes.find((n) => n.id === start)
      if (!node) return json(res, { depths: {} })
      const withHubs = q.get('hubs') === '1'
      const opts = { includeHubEdges: withHubs }

      // 방향은 화면이 고르지 않는다. 기본값의 근거가 analyze.mjs 의 askOf 에 있고,
      // 두 곳에서 따로 정하면 화면 설명과 계산이 갈라진다.
      const asked = q.get('dir')
      const direction = ['in', 'out', 'both'].includes(asked) ? asked : askOf(node)

      // 양쪽 수를 함께 준다. "내가 쓰는 것 2 · 나를 쓰는 것 23" 을 보여줘야
      // 사용자가 뒤집을지 판단할 수 있다. 한 방향만 주면 뒤집을 이유를 모른다.
      json(res, {
        start,
        direction,
        role: node.role,
        reach: {
          out: depths(g, start, { ...opts, direction: 'out' }).size - 1,
          in: depths(g, start, { ...opts, direction: 'in' }).size - 1,
        },
        depths: Object.fromEntries(depths(g, start, { ...opts, direction })),
      })
      return
    }

    if (url.pathname === '/api/coupling') {
      json(res, coupling(graph()))
      return
    }

    // ── 기능 ──────────────────────────────────────────────────────────────

    // ── 대분류 · 색인 ─────────────────────────────────────────────────────
    // POST 를 먼저 본다. 아래 GET 분기에 메서드 조건이 없어서 순서를 바꾸면
    // 저장 요청이 조회로 처리되고 조용히 아무 일도 안 일어난다.
    if (url.pathname === '/api/taxonomy' && req.method === 'POST') {
      const { categories } = await readBody(req)
      if (!Array.isArray(categories) || !categories.length) {
        return json(res, { error: '분류 목록이 비었습니다' }, 400)
      }
      fs.mkdirSync(path.dirname(TAXONOMY), { recursive: true })
      fs.writeFileSync(TAXONOMY, `${JSON.stringify({ categories }, null, 2)}\n`, 'utf8')
      indexCache = null // 목록이 바뀌면 색인은 무효다
      json(res, indexState())
      return
    }

    if (url.pathname === '/api/taxonomy') {
      // prompt=1 이면 큰 모델에 붙여넣을 재료를 준다. 도구가 API 키를 들지 않는다.
      if (q.get('prompt') === '1') return json(res, { prompt: taxonomyPrompt() })
      json(res, indexState())
      return
    }

    if (url.pathname === '/api/index' && req.method === 'POST') {
      json(res, { ...(await buildIndex()), ...indexState() })
      return
    }


    // ── 파일 ──────────────────────────────────────────────────────────────
    if (url.pathname === '/api/detail') {
      const rel = q.get('path')
      const abs = rel && safeJoin(ROOT, rel)
      if (!abs || !fs.existsSync(abs)) return json(res, { error: '없는 파일' }, 404)
      json(res, detail(ROOT, rel))
      return
    }

    /**
     * ── 대화(= CLI 프로세스) ──────────────────────────────────────────────
     *
     * 화면에서는 채팅이지만 여기서는 자식 프로세스다. 세션을 **서버가** 들고
     * 있으므로 창이 느려지거나 닫혀도 진행 중인 작업은 계속 돈다.
     * 자세한 이유는 `app/lib/session.mjs` 머리말.
     */
    /**
     * ── 지금 도는 것이 어느 빌드인가 ──────────────────────────────────────
     *
     * 🔴 이 화면이 없어서 한 번 헤맸다.
     *
     * 바탕화면 아이콘은 **마지막으로 빌드한 것**을 가리킨다. 그런데 그 뒤로 코드를
     * 고치고 커밋해도 다시 빌드하지 않으면 아이콘은 옛것을 계속 연다. 실제로
     * 53분 전 빌드가 열려서 "새로 만든 온보딩이 왜 안 뜨지" 로 시간을 썼다.
     *
     * 화면에 적어 두면 그 혼란이 다시 안 생긴다. git 이 있으면 커밋을,
     * 없으면(패키징된 앱은 `.git` 이 없다) 코드 파일의 시각을 쓴다.
     */
    if (url.pathname === '/api/version') {
      let label = null
      try {
        const r = spawnSync('git', ['-C', HERE, 'rev-parse', '--short', 'HEAD'],
          { encoding: 'utf8', windowsHide: true })
        if (r.status === 0 && r.stdout.trim()) {
          const d = spawnSync('git', ['-C', HERE, 'status', '--porcelain'],
            { encoding: 'utf8', windowsHide: true })
          label = r.stdout.trim() + (d.stdout?.trim() ? ' (고친 것 있음)' : '')
        }
      } catch { /* git 이 없으면 아래로 */ }
      if (!label) {
        // 패키징된 앱. 코드가 언제 만들어졌는지가 곧 빌드 시각이다.
        try {
          const t = fs.statSync(fileURLToPath(import.meta.url)).mtime
          label = `빌드 ${t.toISOString().slice(0, 16).replace('T', ' ')}`
        } catch { label = '알 수 없음' }
      }
      json(res, { label })
      return
    }

    if (url.pathname === '/api/open/status') {
      const j = fetchJobs.get(q.get('job'))
      if (!j) return json(res, { error: '없는 작업입니다' }, 404)
      // 로그는 뒤쪽 몇 줄만. 전부 보내면 받는 쪽이 느려지고, 앞줄은 이미 지나갔다.
      json(res, { ...j, log: j.log.slice(-6) })
      return
    }

    /**
     * ── 저장소 열기 ───────────────────────────────────────────────────────
     *
     * git 주소면 받아 오고, 로컬 경로면 확인만 한다. **그리고 여기서 끝난다.**
     *
     * 🔴 대상을 이 프로세스 안에서 바꾸지 않는 이유.
     *
     * `ROOT` 는 45곳에서 읽히고 그 위에 캐시가 8개(그래프·오버레이·기능·색인·
     * 새 파일·기준선·작성자…)와 파일 감시자가 얹혀 있다. 하나라도 안 비우면
     * **A 저장소의 데이터를 B 라고 보여준다** — 에러도 안 나고, 화면은 그럴듯하다.
     * D5 가 "확신 있게 틀린 답이 가장 해롭다" 고 적은 바로 그 실패다.
     *
     * 그래서 여기서는 무거운 일(클론)만 하고, 대상을 바꾸는 것은 **프로세스를
     * 갈아끼우는 쪽**에 맡긴다. 데스크톱 셸이 그 일을 한다(`desktop/main.mjs`).
     * 캐시 세대(generation)를 붙여 안전하게 갈아끼우는 것은 별도 작업으로 남긴다.
     */
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const { target } = await readBody(req)
      if (typeof target !== 'string' || !target.trim()) {
        return json(res, { error: '주소나 경로를 넣어 주세요' }, 400)
      }
      const t = target.trim()
      try {
        if (isRemote(t)) {
          /**
           * 🔴 클론은 **자식 프로세스**에 넘기고 즉시 답한다.
           *
           * `fetchRepo` 는 `execFileSync` 로 git 을 부르므로 여기서 그대로 부르면
           * 클론이 끝날 때까지 이벤트 루프가 통째로 멈춘다 — 그동안 화면도 대화도
           * 전부 죽는다. 실제로 처음에 그렇게 만들었다가 요청이 타임아웃으로 끊겼다.
           * 세션을 서버에 둔 이유와 정면으로 어긋나는 동작이었다.
           */
          return json(res, { job: startFetch(t), current: ROOT })
        }
        const p = path.resolve(t)
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
          return json(res, { error: `그런 폴더가 없습니다: ${p}` }, 400)
        }
        // git 저장소가 아니면 공변경도 감시도 못 한다. 미리 말한다.
        const isGit = fs.existsSync(path.join(p, '.git'))
        return json(res, { root: p, url: null, cached: true, git: isGit, current: ROOT })
      } catch (e) {
        return json(res, { error: e.message }, 400)
      }
    }

    if (url.pathname === '/api/agents') {
      const found = detectAgents()
      json(res, { agents: found, preferred: preferredAgent(found)?.id ?? null })
      return
    }

    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const { agent, title } = await readBody(req)
      try {
        // cwd 는 항상 지금 보고 있는 저장소다. 화면이 고르게 두지 않는다 —
        // 엉뚱한 디렉터리에서 에이전트가 파일을 고치는 것이 최악의 사고다.
        json(res, sess.create({ agent, cwd: ROOT, title }))
      } catch (e) { json(res, { error: e.message }, 400) }
      return
    }

    if (url.pathname === '/api/sessions') {
      json(res, { sessions: sess.list() })
      return
    }

    if (url.pathname.startsWith('/api/session/')) {
      const [, , , id, verb] = url.pathname.split('/')
      const s = sess.get(id)
      if (!s) return json(res, { error: '없는 세션입니다' }, 404)

      if (verb === 'send' && req.method === 'POST') {
        const { prompt } = await readBody(req)
        if (typeof prompt !== 'string' || !prompt.trim()) {
          return json(res, { error: '빈 프롬프트' }, 400)
        }
        try { json(res, sess.send(id, prompt)) } catch (e) { json(res, { error: e.message }, 409) }
        return
      }
      if (verb === 'stop' && req.method === 'POST') { sess.stop(id); return json(res, sess.view(s)) }
      if (verb === 'close' && req.method === 'POST') { sess.remove(id); return json(res, { ok: true }) }

      // 화면은 `?since=` 로 밀린 것만 받아 간다. 매번 전부 보내면 앱이 느려진다.
      json(res, sess.view(s, Number(q.get('since') ?? -1)))
      return
    }

    // ── 실시간 ────────────────────────────────────────────────────────────
    if (url.pathname === '/api/live') {
      json(res, liveState())
      return
    }

    // ── 작성자 이력 ───────────────────────────────────────────────────────
    if (url.pathname === '/api/authors') {
      const a = authors()
      // 목록만 필요할 때는 파일 목록을 빼서 가볍게 준다
      if (q.get('files') === '1') return json(res, a)
      json(res, {
        available: a.available,
        me: ME,
        authors: a.authors.map(({ files, ...rest }) => rest),
      })
      return
    }

    if (url.pathname === '/api/authors/files') {
      const name = q.get('name')
      const a = authors().authors.find((x) => x.name === name)
      if (!a) return json(res, { error: '없는 작성자' }, 404)
      json(res, { name, paths: a.files.map((f) => f.path), touches: a.files })
      return
    }

    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`event: live\ndata: ${JSON.stringify(liveState())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    // ── LLM ───────────────────────────────────────────────────────────────
    if (url.pathname === '/api/llm/status') {
      json(res, await llm.status())
      return
    }

    // 스트리밍이 기본이다. 첫 글자가 빨리 나오는 것이 체감을 좌우한다.
    if (url.pathname === '/api/llm/summarize' && req.method === 'POST') {
      const { path: rel } = await readBody(req)
      const abs = rel && safeJoin(ROOT, rel)
      if (!abs || !fs.existsSync(abs)) return json(res, { error: '없는 파일' }, 404)

      const text = fs.readFileSync(abs, 'utf8')
      let started = false
      try {
        const meta = await llm.summarizeStream(rel, text, (chunk) => {
          if (!started) {
            started = true
            res.writeHead(200, {
              'content-type': 'text/plain; charset=utf-8',
              'x-accel-buffering': 'no',
            })
          }
          res.write(chunk)
        })
        if (!started) {
          // 한 글자도 안 나온 경우 — LLM 이 없거나 빈 응답
          return json(res, meta.available ? { available: true, summary: '' } : { available: false })
        }
        res.end()
      } catch (e) {
        if (started) res.end(`\n\n(중단: ${e.message})`)
        else json(res, { available: false, error: e.message }, 200)
      }
      return
    }

    if (url.pathname === '/api/llm/key' && req.method === 'POST') {
      const { path: rel } = await readBody(req)
      const abs = rel && safeJoin(ROOT, rel)
      if (!abs || !fs.existsSync(abs)) return json(res, { error: '없는 파일' }, 404)
      json(res, await llm.keyLines(rel, fs.readFileSync(abs, 'utf8')))
      return
    }

    if (url.pathname === '/api/llm/edges' && req.method === 'POST') {
      const { path: rel } = await readBody(req)
      const abs = rel && safeJoin(ROOT, rel)
      if (!abs || !fs.existsSync(abs)) return json(res, { error: '없는 파일' }, 404)
      json(res, await llm.readEdges(rel, fs.readFileSync(abs, 'utf8')))
      return
    }

    // ── 터미널 ────────────────────────────────────────────────────────────
    // pty 가 아니라 spawn 이다. 대화형 TUI(vim 등)는 안 되지만
    // git·테스트·ros2 명령을 돌리고 출력을 보는 데는 충분하고 네이티브 의존성이 없다.
    json(res, { error: 'unknown endpoint' }, 404)
  } catch (e) {
    json(res, { error: e.message }, 500)
  }
})

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    /**
     * 🔴 그 포트에 무엇이 떠 있는지 반드시 말한다.
     *
     * 관찰자가 이것 때문에 5분을 날렸다. 직전 세션의 다른 저장소가 같은 포트에
     * 떠 있었고, "이미 켜져 있다면 접속하세요" 를 그대로 따랐더니 **남의 저장소**가
     * 보였다. 화면에 대상 경로가 있긴 하지만 처음 보는 사람은 그게 자기가 연
     * 저장소라고 믿는다. 30분을 엉뚱한 코드에 쓸 수 있었다.
     */
    let who = null
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/overlay`, { signal: AbortSignal.timeout(3000) })
      who = (await r.json()).root
    } catch { /* axMap 이 아닌 다른 서버일 수 있다 */ }

    console.error(`\n  포트 ${PORT} 이 이미 쓰이는 중입니다.`)
    if (who && path.resolve(who) !== ROOT) {
      console.error(`  🔴 거기 떠 있는 것은 **다른 저장소**입니다:`)
      console.error(`       떠 있는 것 : ${who}`)
      console.error(`       열려던 것  : ${ROOT}`)
      console.error(`     그대로 접속하면 엉뚱한 저장소를 보게 됩니다.`)
    } else if (who) {
      console.error(`  같은 저장소가 이미 떠 있습니다 — http://127.0.0.1:${PORT} 로 접속하세요.`)
    } else {
      console.error(`  axMap 이 아닌 다른 프로그램일 수 있습니다.`)
    }
    console.error(`  다른 포트로 실행:  node app/server.mjs "${ROOT}" ${PORT + 1}\n`)
    process.exit(1)
  }
  throw e
})

server.listen(PORT, '127.0.0.1', async () => {
  const g = graph()
  const s = await llm.status()
  console.log(`\n  axMap 뷰어`)
  console.log(`  대상   ${CLONED ? `${CLONED.url}
         ${ROOT}` : ROOT}`)
  console.log(`  파일   ${g.stats.files}개 (${g.stats.totalLines.toLocaleString()}줄), 백업 ${g.stats.skippedBackups}개 제외`)
  console.log(`  그래프 노드 ${g.nodes.length} · 엣지 ${g.edges.length} · 허브 ${g.hubs.length} · ${g.stats.buildMs}ms`)
  // 문턱값의 출처를 시작할 때 말한다. 어떤 기준으로 그린 그림인지 모르면
  // 화면의 숫자는 해석할 수가 없다.
  const basis = g.ssot
  if (basis.cell) {
    console.log(`  기준   ${basis.cell} · 저장소 ${basis.repos}개 · 긴 파일 ${basis.splitOver}줄 · 허브 ${basis.hubCap}`
      + `${basis.fetchedFrom === 'cache' ? ' (캐시 — 원격에 못 닿음)' : ''}`)
  } else {
    console.log(`  기준   코퍼스 미적용 — ${basis.why} · 눈으로 고른 값(${basis.splitOver}줄 / ${basis.hubCap}) 사용`)
  }
  if (basis.why && basis.cell) console.log(`         보류: ${basis.why}`)
  console.log(`  LLM    ${s.available ? `${s.model} (${s.host})` : '없음 — 요약은 비활성, 나머지는 정상'}`)
  console.log(`\n  http://127.0.0.1:${PORT}\n`)

  // 모델을 미리 올려 첫 클릭이 콜드 스타트를 만나지 않게 한다
  if (s.available && s.modelReady) {
    const t0 = Date.now()
    llm.warmup().then(() => console.log(`  모델 준비 완료 (${((Date.now() - t0) / 1000).toFixed(0)}초)`))
  }
})

process.on('SIGINT', () => {
  watcher.close()
  // 대화 세션의 자식 프로세스를 남기지 않는다. 남으면 다음 실행에서
  // 누가 띄운 건지 모르는 CLI 가 백그라운드에 떠 있게 된다.
  sess.shutdown()
  process.exit(0)
})
