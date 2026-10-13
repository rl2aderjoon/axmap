/**
 * 히스토리만 있는 파일을 노드로 만든다.
 *
 * 🔴 이 도구의 존재 이유에 해당하는 결합을 구조적으로 못 잡고 있었다.
 *
 * baritone(Minecraft 봇, Java) 에서 실측된 상황이다. 가장 중요한 숨은 결합은
 * 이것이었다 —
 *
 *   src/launch/resources/mixins.baritone.json  을 건드린 커밋      67개
 *   그중 Mixin*.java 도 함께 건드린 커밋                           53개 (79%)
 *
 * Mixin 클래스를 추가·삭제하면 **반드시** 이 JSON 의 `client` 배열도 고쳐야 한다.
 * 코드 어디에도 그 규칙이 적혀 있지 않다. 정확히 "코드를 읽어서는 안 보이는 연결"이고,
 * 이 도구가 잡아야 하는 것의 표본이다.
 *
 * 그런데 노드가 `.java` 363개뿐이라 통째로 사라졌다. `scan()` 이 코드 확장자만
 * 노드로 만들기 때문이다. 같은 이유로 —
 *   · axMap 자신의 `docs/` 1,306줄이 그래프에 없다 (1회차 관찰의 미해결 항목)
 *   · `bin/axmap.mjs → docs/SPEC.md` 같은 규약 결합이 안 잡힌다
 *   · `build.gradle` · `fabric.mod.json` · `package.json` 도 전부 없다
 *
 * **정적 파싱이 안 되는 파일이라도 git 공변경은 언어와 무관하게 계산된다.**
 * 노드로만 넣으면 된다.
 *
 * 🔴 다만 전부 넣으면 안 된다.
 *
 * 저장소에는 lock 파일·생성 파일·에셋이 수천 개 있고, 그것들을 다 넣으면
 * 그래프가 노이즈로 덮인다. 그래서 **히스토리가 실제로 있는 것만** 넣는다 —
 * 커밋에 여러 번 등장했다는 것은 사람이 반복해서 손댔다는 뜻이고,
 * 그게 곧 "이 파일은 작업의 일부다" 라는 증거다.
 *
 * 그리고 이 노드들은 **정적 엣지를 절대 갖지 않는다.** 출처를 속이지 않기 위해
 * `confidence: 'history-only'` 로 표시하고 화면이 구분해 그린다.
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 노드로 만들 수 있는 비코드 파일.
 *
 * 규약·설정·문서만 넣는다. 이미지·폰트·바이너리는 사람이 "읽는" 대상이 아니므로
 * 그래프에 있어도 할 일이 없다.
 */
const DATA_EXT = /\.(json|ya?ml|toml|ini|cfg|conf|properties|gradle|gradle\.kts|md|rst|adoc|txt|sql|proto|graphql|tf|dockerfile|mod)$/i
const DATA_NAME = /^(dockerfile|makefile|justfile|procfile|\.gitattributes|\.gitignore|\.env\.example)$/i

/** 노이즈. 사람이 손으로 고치는 파일이 아니다. */
const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$/i

export const isDataFile = (p) => {
  if (NOISE.test(p)) return false
  const base = p.slice(p.lastIndexOf('/') + 1)
  return DATA_EXT.test(base) || DATA_NAME.test(base)
}

/** 코드 노드와 같은 모양이어야 GraphView 가 그대로 쓴다. */
function makeNode(root, rel, commits) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  let lines = 0
  try {
    lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n').length
  } catch { /* 읽을 수 없으면 0 — 크기는 부차적이다 */ }
  return {
    id: rel,
    name: rel.slice(rel.lastIndexOf('/') + 1),
    dir,
    lang: 'data',
    lines,
    big: false,
    group: rel.split('/')[0],
    kind: 'other',
    role: 'connector',
    deg: { in: 0, out: 0, undirected: 0 },
    badges: [],
    channels: [],
    parsed: false,
    // 🔴 출처를 속이지 않는다. 이 노드는 정적으로 확인된 것이 하나도 없고
    //    오직 "커밋에 함께 나왔다" 만으로 존재한다.
    confidence: 'history-only',
    commits,
  }
}

/**
 * 히스토리에서 자주 등장한 비코드 파일을 노드로 만든다.
 *
 * @param {string} root
 * @param {string[][]} commitSets  커밋별 파일 목록 (전체 경로, 아직 안 거른 것)
 * @param {Set<string>} existing   이미 노드인 경로
 * @param {object} opts
 * @returns {{nodes: object[], stats: object}}
 */
export function historyNodes(root, commitSets, existing, {
  minCommits = 4,
  maxNodes = 400,
} = {}) {
  const count = new Map()
  for (const files of commitSets) {
    // 대량 커밋은 여기서도 뺀다. 일괄 포맷팅 한 번에 설정 파일 수백 개가
    // 딸려 들어오면 "자주 손댄 파일" 이 아니라 그냥 그 커밋의 부산물이다.
    if (files.length > 50) continue
    for (const f of new Set(files)) {
      if (existing.has(f) || !isDataFile(f)) continue
      count.set(f, (count.get(f) ?? 0) + 1)
    }
  }

  const frequent = [...count].filter(([, n]) => n >= minCommits)
  // 지워진 파일은 뺀다. 히스토리에는 있지만 지금 트리에 없으면 볼 수 없다.
  const alive = frequent.filter(([f]) => fs.existsSync(path.join(root, f)))
  const picked = alive.sort((a, b) => b[1] - a[1]).slice(0, maxNodes)

  return {
    nodes: picked.map(([f, n]) => makeNode(root, f, n)),
    stats: {
      candidates: count.size,
      frequent: frequent.length,
      deleted: frequent.length - alive.length,   // 히스토리엔 있으나 지금 없는 것
      added: picked.length,
      minCommits,
      // 예산에 걸려 잘린 개수. 위의 deleted 와 다른 것이다 —
      // 하나는 "없어서 못 넣음", 하나는 "많아서 안 넣음" 이다.
      truncated: Math.max(0, alive.length - picked.length),
    },
  }
}
