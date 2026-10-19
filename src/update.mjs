/**
 * "지금 쓰는 axMap 이 최신인가" 를 **판정만** 하는 층. 아무것도 설치하지 않는다.
 *
 * ── 왜 이 파일이 따로 있나 ──────────────────────────────────────────────────
 *
 * 배포판(npm 레지스트리에 올린 꾸러미)으로 axMap 을 쓰는 사람은 `git pull` 을
 * 할 저장소가 손에 없다. 그 사람에게 "새 버전이 나왔다" 를 알릴 길이 필요하다.
 *
 * 🔴 **알리기만 하고 바꾸지는 않는다.** 사람이 모르는 사이에 도구가 바뀌면
 *    어제 되던 것이 오늘 안 되고, 원인을 찾을 실마리가 없다 — 바뀐 것이 자기
 *    코드가 아니기 때문이다. 적용은 사람이 `axmap update` 를 읽고 한 줄을
 *    직접 실행하는 것으로만 일어난다.
 *
 * ── 🔴 벤더링된 사본에서는 아무것도 하지 않는다 ─────────────────────────────
 *
 * 팀 저장소의 `ci/axmap/` 은 이 코드의 **사본**이고(팀 CLAUDE.md 0.3),
 * 그 사본이 최신인지는 npm 이 아니라 `tools/vendor.mjs` 가 정한다. 사본이
 * 레지스트리를 쳐다보면 두 가지가 한꺼번에 나빠진다.
 *
 *   1. 팀 CI 가 매 파이프라인마다 바깥 네트워크에 의존하게 된다 — 벤더링이
 *      끊으려고 했던 바로 그 연결이다
 *   2. "새 버전이 있다" 는 안내가 팀원에게 뜨는데, 그 팀원이 할 수 있는 일은
 *      없다. 사본은 axMap 저장소에서 `vendor.mjs` 를 다시 돌려야만 바뀐다
 *
 * 사본인지 아닌지는 **옆에 `SOURCE.json` 이 있는가**로 가른다. 그 파일은
 * `tools/vendor.mjs` 가 사본에만 써 넣는다(원본 저장소 루트에는 없다).
 */

import fs from 'node:fs'
import path from 'node:path'
import { stateDir } from './state.mjs'

/**
 * 꾸러미 이름. **`package.json` 의 `name` 과 반드시 같아야 한다.**
 *
 * 🔴 그냥 `axmap` 이 아닌 이유: npm 의 `axmap` 은 2022년부터 **남이 쓰고 있는 다른
 *    꾸러미**다(어떤 Map 라이브러리, 1.1.2). `npx axmap` 이라고 안내하면 사람들이
 *    우리 것이 아닌 코드를 받아 실행한다. 스코프를 붙여 소유를 분명히 한다.
 *    사람이 치는 **명령** 이름은 그대로 `axmap` 이다(`package.json` 의 `bin`).
 *
 * 이 상수가 있는 자리가 하나뿐이어야 한다 — 안내문의 `npx ...` 한 줄도 여기서 나온다.
 */
export const PACKAGE_NAME = 'axmap-cli'

/** 기본 레지스트리. `AXMAP_REGISTRY` 로 갈아끼운다 — 시험과 사내 레지스트리를 위해서다. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** 하루에 한 번만 묻는다. 도구를 부를 때마다 네트워크를 치면 그게 더 나쁜 버그다. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 레지스트리가 안 답할 때 기다리는 한계. 넘으면 그냥 포기한다 — 이건 편의지 판정이 아니다. */
export const FETCH_TIMEOUT_MS = 3000

export const registryUrl = (env = process.env) =>
  String(env.AXMAP_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '')

/**
 * 버전 비교. `a` 가 크면 1, 같으면 0, 작으면 -1.
 *
 * 🔴 `'1.10.0' > '1.9.0'` 이 문자열 비교로는 거짓이다. 숫자 칸으로 끊어 센다.
 *    사전배포(`1.2.0-rc.1`)는 같은 자리의 정식판보다 **낮다** — semver 의 규칙이고,
 *    안 그러면 rc 를 올린 날 모두에게 "내려가라" 는 안내가 뜬다.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const core = String(v).trim().replace(/^v/, '').split('+')[0]
    const [num, pre = ''] = core.split('-')
    return { nums: num.split('.').map((n) => Number(n) || 0), pre }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d > 0 ? 1 : -1
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1 // 정식판이 사전배포보다 높다
  if (!y.pre) return -1
  return x.pre > y.pre ? 1 : -1
}

/**
 * 이 axMap 이 **벤더링된 사본**인가. 사본이면 갱신 확인을 통째로 건너뛴다.
 *
 * @param {string} axmapRoot  `bin/` · `src/` 를 담고 있는 폴더
 */
export const isVendored = (axmapRoot) => fs.existsSync(path.join(axmapRoot, 'SOURCE.json'))

/**
 * 확인을 하지 말아야 하는 자리인가.
 *
 * `CI` 는 거의 모든 CI 가 스스로 켜 주는 환경변수다. 파이프라인 안에서 바깥
 * 네트워크를 치는 것은 느려지기만 하고 아무도 그 안내를 못 읽는다.
 */
export const checkDisabled = (env = process.env) =>
  Boolean(env.AXMAP_NO_UPDATE_CHECK || env.CI)

/** 마지막 확인 결과를 두는 자리. 저장소가 아니라 홈이다 — 이건 이 PC 의 사실이다. */
export const cacheFile = () => path.join(stateDir(), 'update.json')

/**
 * 마지막 확인 결과. 못 읽으면 `null`.
 *
 * 🔴 던지지 않는다. 이 값은 편의를 위한 것이라, 캐시 파일 하나가 깨졌다고
 *    CLI 전체가 죽을 이유가 없다.
 */
export function readCache() {
  try {
    const rec = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))
    if (!rec || typeof rec !== 'object') return null
    if (typeof rec.latest !== 'string' || typeof rec.checkedAt !== 'number') return null
    return rec
  } catch {
    return null
  }
}

/** 확인 결과를 적는다. 실패해도 던지지 않는다 — 못 적으면 다음에 다시 물으면 된다. */
export function writeCache(rec) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true })
    fs.writeFileSync(cacheFile(), JSON.stringify(rec, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

/** 다시 물어볼 때가 됐는가. 기록이 없으면 언제나 그렇다. */
export const isStale = (rec, nowMs, interval = CHECK_INTERVAL_MS) =>
  !rec || typeof rec.checkedAt !== 'number' || nowMs - rec.checkedAt >= interval

/**
 * 사람에게 보여줄 안내. 알릴 것이 없으면 `null`.
 *
 * 🔴 부르는 쪽은 이것을 **stderr 로** 낸다. stdout 은 `--json` 이 쓰는 자리라,
 *    여기에 사람이 읽는 글을 섞으면 그 출력을 파싱하는 쪽이 조용히 깨진다.
 *
 * 🔴 **두 줄을 다 낸다 (2026-09-12).** 이 PC 에 판이 두 군데 있기 때문이다 —
 *    `axmap` 명령(전역 설치)과 git 훅이 부르는 사본(`~/.axmap/app`). 서로 안
 *    따라간다.
 *
 *    전에는 `npx … setup` 한 줄만 안내했다. 그런데 **`setup` 은 전역 설치를 전혀
 *    건드리지 않는다** (`tools/setup.mjs` 에 `npm i` 가 0건이다 — 거기 있는
 *    `--commands global` 의 "global" 은 슬래시 명령을 어디 둘지이지 전역 설치가
 *    아니다). 그래서 그 안내를 그대로 따르면 **사본만 새 판이 되고 `axmap` 명령은
 *    옛 판으로 남는다.**
 *
 *    그건 이 명령이 1.2.4 에서 고친 문제(사본이 낡았는데 "최신입니다" 라고 한 것)를
 *    **안내가 스스로 만들어 내는 것**이다. 반쪽짜리 안내는 틀린 안내보다 낫지
 *    않다 — 시킨 대로 했는데 안 고쳐지면 사람은 도구를 안 믿게 된다.
 */
export function noticeLine(current, latest) {
  if (!current || !latest) return null
  if (compareVersions(latest, current) <= 0) return null
  return `새 버전이 있습니다: ${current} → ${latest}\n`
    + `  받으려면:  npm i -g ${PACKAGE_NAME}@latest\n`
    + `             npx -y ${PACKAGE_NAME}@latest setup\n`
    + '  🔴 두 줄 다 필요합니다 — 앞은 axmap 명령을, 뒤는 git 훅이 부르는 사본을\n'
    + '     올립니다. 서로 안 따라갑니다.'
}

/**
 * 레지스트리에 최신 버전을 묻는다.
 *
 * npm 레지스트리는 `GET <registry>/<이름>/latest` 에 `{ "version": ... }` 을 답한다.
 * 인증도 의존성도 필요 없는 평범한 HTTPS GET 하나다 — 그래서 이 저장소의
 * "의존성 없음" 을 깨지 않고 쓸 수 있다.
 *
 * @returns {Promise<string>} 최신 버전 문자열
 * @throws  못 물어봤을 때. 부르는 쪽이 **조용히 넘어갈지**를 정한다.
 */
export async function fetchLatest({
  registry = registryUrl(),
  name = PACKAGE_NAME,
  timeoutMs = FETCH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('이 node 에는 fetch 가 없습니다 (node 18+ 필요)')
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(`${registry}/${encodeURIComponent(name)}/latest`, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`레지스트리가 ${res.status} 를 냈습니다`)
    const body = await res.json()
    const v = body?.version
    if (typeof v !== 'string' || !v.trim()) throw new Error('레지스트리 응답에 version 이 없습니다')
    return v.trim()
  } finally {
    clearTimeout(timer)
  }
}
