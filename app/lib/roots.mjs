/**
 * 저장소 안의 **하위 프로젝트**를 찾는다.
 *
 * 🔴 왜 필요한가 — 실측으로 드러난 것.
 *
 * SSAFY 팀 저장소(`S15P11E101`, 파일 531개)를 열었더니 이렇게 나왔다:
 *
 *     14 / 549 개가 진입점에서 닿습니다 · 최대 1겹 · 안 닿는 파일 535개
 *
 * 그래프가 빈 것이 아니었다. 엣지는 1,267개나 있었다. 문제는 **진입점**이었다.
 * 그 저장소는 한 프로젝트가 아니라 넷이다:
 *
 *     BE_system   java 208    build.gradle
 *     BE_robot    python 128  (매니페스트 없음 — ROS 작업공간)
 *     FE          ts/js 149   FE/bbiyong-react/package.json
 *     AI          python 39   requirements.txt
 *
 * 그런데 `entryCandidates` 는 **저장소 최상위에서만** 매니페스트를 읽는다
 * (`path.join(root, 'package.json')`). 최상위에는 아무것도 없으니 1등급을 못
 * 찾고 하위 근거로 떨어졌고, `if __name__ == '__main__'` 이 있는 **JIRA 자동화
 * 스크립트 8개**를 진입점으로 골랐다. 거기서 Java 208개와 React 149개로 가는
 * 길은 당연히 없다. 그래서 14개만 닿았다.
 *
 * 🔴 이건 군집화로 못 고친다. 531개를 아무리 잘 묶어도 출발점이 틀린 채로
 * 묶이는 것뿐이다. **먼저 "여기 프로젝트가 몇 개인가" 를 답해야 한다.**
 * 주니어가 모노레포 앞에서 하는 첫 질문이 정확히 그것이기도 하다.
 *
 * ── 무엇을 근거로 가르나 ────────────────────────────────────────────────
 *
 * **매니페스트가 있는 디렉터리.** 저자가 "여기가 프로젝트다" 라고 이미 선언해
 * 둔 것이므로 추측할 이유가 없다 (`flow.mjs` 가 1등급을 다루는 것과 같은 원칙 —
 * 선언이 곧 저자의 답이다).
 *
 * 매니페스트가 없는 것도 있다. 위의 `BE_robot` 이 그렇다. 그래서 **소스가 충분히
 * 많은 최상위 디렉터리**를 뒤에 덧붙인다. 다만 그건 추측이므로 `kind: 'dir'` 로
 * 표시해서 화면이 근거를 구분해 보여줄 수 있게 한다.
 */

import fs from 'node:fs'
import path from 'node:path'

/** 이 파일이 있으면 그 디렉터리는 프로젝트다. 저자의 선언이다. */
export const MANIFESTS = [
  ['package.json', 'node'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'java'],
  ['pyproject.toml', 'python'],
  ['setup.py', 'python'],
  ['requirements.txt', 'python'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['package.xml', 'ros'],
  ['CMakeLists.txt', 'cmake'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
]

/** 들어가지 않는 곳. 남의 코드이거나 산출물이다. */
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'coverage', '.gradle',
])

/**
 * 매니페스트가 없어도 프로젝트로 쳐 주는 최소 소스 파일 수.
 *
 * 눈으로 고른 값이다. 너무 낮으면 `scripts/` 같은 잡동사니가 프로젝트가 되고,
 * 너무 높으면 진짜 하위 프로젝트를 놓친다. 실측에서 `BE_robot`(128개)은 잡고
 * `scripts`(1개) · `ref`(2개)는 안 잡는 자리를 골랐다.
 */
export const MIN_FILES = 12

/** 매니페스트를 찾아 내려간다. 깊이를 제한하는 이유는 아래 주석. */
function manifestDirs(repoRoot, maxDepth) {
  const out = []
  const walk = (rel, depth) => {
    if (depth > maxDepth) return
    let ents
    try { ents = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true }) } catch { return }

    for (const [file, kind] of MANIFESTS) {
      if (ents.some((e) => e.isFile() && e.name === file)) { out.push({ dir: rel, kind, manifest: file }); break }
    }
    for (const e of ents) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue
      walk(rel ? `${rel}/${e.name}` : e.name, depth + 1)
    }
  }
  walk('', 0)
  return out
}

const under = (id, dir) => (dir === '' ? true : id === dir || id.startsWith(`${dir}/`))

/**
 * 하위 프로젝트 목록.
 *
 * @param repoRoot 저장소 절대 경로 (매니페스트를 읽는 데 쓴다)
 * @param nodes    그래프 노드. `id` 는 저장소 기준 상대 경로다
 * @returns [{ dir, kind, manifest, files, langs }] — 파일 많은 순
 */
export function findRoots(repoRoot, nodes, { maxDepth = 4, minFiles = MIN_FILES } = {}) {
  const code = (nodes ?? []).filter((n) => n.lang && n.lang !== 'data')

  const roots = manifestDirs(repoRoot, maxDepth).map((d) => ({ ...d, files: 0 }))

  /**
   * 매니페스트가 없는 덩어리. 추측이므로 `kind: 'dir'` 로 표시한다 —
   * 화면이 "선언된 것" 과 "우리가 짐작한 것" 을 구분해 보여줄 수 있어야 한다
   * (D5: 도구는 자기 확신 수준을 속이지 않는다).
   *
   * 🔴 최상위 한 칸으로 묶지 않는다.
   *
   * 처음에 그렇게 했더니 `BE_robot` 이 그 아래의 `BE_robot/ros2_ws/src/*`
   * (각각 `setup.py` 를 가진 진짜 패키지들)와 **겹쳤다.** 같은 파일이 두 곳에
   * 세어져서 "몇 개인가" 가 거짓말이 됐다. 두 칸까지 내려가면 실제로 남는 덩어리
   * (`BE_robot/orin_dashboard`)를 집으면서 아래의 패키지들과 안 겹친다.
   */
  /**
   * 🔴 저장소 루트 자체가 프로젝트면(루트에 매니페스트가 있으면) **덧붙일 것이
   * 없다.** 모든 파일이 이미 그 프로젝트 소속이다.
   *
   * 처음에 루트(`''`)를 이 검사에서 빼놨다가 axMap 자신이 깨졌다 —
   * `test/` · `app/lib/` · `tools/` 가 각각 "프로젝트" 로 올라왔고, 가장 큰 것이
   * `test`(25개)라 거기서 진입점을 찾다가 못 찾고 화면이 통째로 비었다.
   * 그것들은 프로젝트가 아니라 **한 프로젝트 안의 디렉터리**다.
   */
  const covered = (id) => roots.some((r) => under(id, r.dir))
  const loose = new Map()
  for (const n of code) {
    if (covered(n.id)) continue
    const seg = n.id.split('/').slice(0, -1)   // 파일 이름을 뺀 디렉터리
    if (!seg.length) continue                  // 최상위에 흩어진 파일은 프로젝트가 아니다
    const key = seg.slice(0, 2).join('/')
    loose.set(key, (loose.get(key) ?? 0) + 1)
  }
  for (const [dir, n] of loose) {
    if (n < minFiles) continue
    roots.push({ dir, kind: 'dir', manifest: null, files: 0 })
  }

  /**
   * 🔴 파일은 **자기를 담는 가장 안쪽 프로젝트**에 속한다.
   *
   * 처음에는 "매니페스트를 품은 조상은 뺀다" 로 했다. 그랬더니 axMap 자신이
   * 깨졌다 — 저장소 루트에 `package.json` 이 있고 `desktop/package.json` 도
   * 있는데, 루트가 조상이라는 이유로 통째로 빠져서 **본체 70여 개가 어느
   * 프로젝트에도 안 속했다.** 화면에는 카드가 하나도 안 그려졌다.
   *
   * 조상이라고 지우는 것이 아니라 **안쪽에 넘겨준 만큼만 빼면** 된다.
   * 그러면 겹치지도 않고 빠지지도 않는다 — 합계가 정확히 맞는다.
   */
  const deepest = [...roots].sort((a, b) => b.dir.length - a.dir.length)
  const mine = new Map(roots.map((r) => [r.dir, []]))
  for (const n of code) {
    const owner = deepest.find((r) => under(n.id, r.dir))
    if (owner) mine.get(owner.dir).push(n)
  }

  // 개수와 언어는 **같은 목록**으로 센다. 따로 세면 화면의 두 숫자가 어긋난다.
  for (const r of roots) {
    const list = mine.get(r.dir)
    r.files = list.length
    const tally = new Map()
    for (const n of list) tally.set(n.lang, (tally.get(n.lang) ?? 0) + 1)
    r.langs = [...tally].sort((a, b) => b[1] - a[1]).map(([lang, k]) => ({ lang, n: k }))
  }

  return roots.filter((r) => r.files > 0).sort((a, b) => b.files - a.files)
}

/**
 * 프로젝트가 정말 여럿인가.
 *
 * 🔴 하나짜리 저장소에서 "프로젝트를 고르세요" 를 띄우면 걸음이 하나 늘 뿐이다.
 * 둘 이상일 때만 물어본다. 그리고 **덮이지 않은 파일이 많으면** 그것도 알린다 —
 * 조용히 빼놓으면 사용자는 그 코드가 없는 줄 안다.
 */
export function splitNeeded(roots, nodes) {
  const code = (nodes ?? []).filter((n) => n.lang && n.lang !== 'data')
  const inside = code.filter((n) => roots.some((r) => under(n.id, r.dir))).length
  return { multi: roots.length > 1, covered: inside, total: code.length, outside: code.length - inside }
}

export { under }
