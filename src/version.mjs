/**
 * 버전 계산 — 브랜치의 **단계**가 어느 자리를 올릴지 정한다.
 *
 * 순수 로직만 둔다. git 호출도 시계도 여기 없다 (`tools/version.mjs` 가 담당).
 * 이 저장소가 `src/protocol.mjs` 와 `bin/axmap.mjs` 를 가른 것과 같은 이유다 —
 * 판정을 30분 기다리지 않고 검증할 수 있어야 한다.
 *
 * ── 왜 날짜가 아니라 병합인가 ────────────────────────────────────────────────
 *
 * 요구는 "하루가 지나면 minor, 한 주가 지나면 major" 였다. 그런데 달력으로
 * 올리면 **아무 일도 안 한 날에도 버전이 올라간다.** 금요일에 2.0.0 을 찍었는데
 * 그 주에 머지된 것이 하나도 없으면, 그 숫자는 무엇도 가리키지 않는다.
 *
 * 팀의 실제 리듬이 이미 그 주기다 — dev 는 수시로, dev→func 는 하루 한 번,
 * func→main 은 주 한 번. 그래서 **병합이 일어난 그 순간** 버전을 올린다.
 * 결과는 요구한 것과 같고(하루 지나면 1.1.0, 한 주 지나면 2.0.0), 다른 점은
 * 그 숫자가 언제나 실제로 들어간 코드를 가리킨다는 것이다.
 */

/**
 * 브랜치 이름 → 단계.
 *
 * 🔴 **최상위 `main` 은 접두사가 없는 것뿐이다.** `back/main` 은 파트 브랜치이지
 *    최상위가 아니다.
 *
 *    이 팀의 컨벤션은 파트의 중간 단계를 `<파트>/main` 으로 쓴다 (옛 저장소의
 *    `be_system/main`, 지금 실제로 만들어진 `back/main`·`front/main`).
 *    접두사를 통째로 버리면 `back/main` 이 `main` 과 같아져 **파트에 머지할 때마다
 *    major 가 올라간다.** 하루 두 번 머지하면 이틀 만에 5.0.0 이 되고,
 *    그 숫자는 아무것도 가리키지 않는다.
 *
 *    그래서 슬래시가 있으면 최상위가 아니다. 이름이 `func` 이든 `main` 이든
 *    파트의 중간 단계는 minor 다.
 *
 * @example
 *   main            → main  (major)
 *   back/main       → func  (minor)   ← 파트 브랜치
 *   fe/func         → func  (minor)
 *   back/dev        → dev   (patch)
 *   feat/S15…-144   → null  (버전을 올리지 않는다)
 */
export function levelOf(branch) {
  if (!branch || typeof branch !== 'string') return null
  const name = branch.trim()
  if (name === 'main' || name === 'master') return 'main'
  const leaf = name.replace(/^.*\//, '')
  // 접두사가 붙은 main 은 파트의 중간 단계다. func 과 같은 자리를 올린다.
  if (leaf === 'main' || leaf === 'master' || leaf === 'func') return 'func'
  if (leaf === 'dev') return 'dev'
  return null
}

/**
 * `front/dev` → `front`. 슬래시가 없으면 `null`.
 *
 * 🔴 `mrtarget.mjs` 가 여기서 **가져다 쓴다.** 거기서 다시 만들면 한 저장소에
 *    파트 판정이 둘이 되고, `levelOf` 를 공유하기로 한 이유가 그대로 무너진다.
 */
export function partOf(branch) {
  const i = String(branch ?? '').lastIndexOf('/')
  return i < 0 ? null : branch.slice(0, i)
}

/**
 * 제품 코드가 없는 파트 — **버전을 올리지 않고, 파트 브랜치 단계도 없다.**
 *
 * ── 왜 예외가 필요한가 ──────────────────────────────────────────────────────
 *
 * `levelOf` 는 이름의 **마지막 칸만** 본다. 그래서 `common/main` 은 파트 브랜치로
 * 읽히고 minor 를, `common` 의 내용이 최상위 `main` 에 들어가면 major 를 올린다.
 * 그런데 `common` 에 들어 있는 것은 문서·CI·공용 설정이다. **제품이 아니다.**
 * 문서 오타 하나를 고쳤다고 제품 버전이 오르면 그 숫자는 아무것도 가리키지 않는다 —
 * 이 파일 머리말이 "달력으로 올리면 아무 일도 안 한 날에도 올라간다" 며 날짜 방식을
 * 버린 것과 **똑같은 이유**다.
 *
 * 그리고 파트 브랜치 단계(`<파트>/main`)의 뜻은 "이 파트의 릴리스 후보" 다.
 * 릴리스할 제품이 없는 파트에는 그 자리가 없다. 그래서 `common/dev` 는
 * **최상위 `main` 으로 바로 간다** (`mrtarget.mjs` 가 그 판정을 한다).
 *
 * 🔴 **이름 목록이지 규칙이 아니다.** 파트가 제품인지 아닌지는 코드가 알 수 없다.
 *    새 파트를 여기 넣는 것은 팀의 결정이고, 넣는 순간 그 파트는 버전을 갖지 않는다.
 */
export const NON_PRODUCT_PARTS = new Set(['common'])

/** 이 브랜치가 제품이 아닌 파트에 속하는가. */
export function isNonProductPart(branch) {
  const p = partOf(branch)
  return p !== null && NON_PRODUCT_PARTS.has(p)
}

/** 단계 → 올릴 자리. */
const PART = { main: 'major', func: 'minor', dev: 'patch' }

const RE = /^v?(\d+)\.(\d+)\.(\d+)$/

/**
 * `v1.2.3` → `{major, minor, patch}`.
 *
 * 🔴 못 읽으면 **0.0.0 으로 치지 않고 null 을 준다.**
 * 태그를 잘못 읽고 0 에서 다시 시작하면 이미 나간 버전을 다시 발급하게 되고,
 * 그러면 같은 번호가 서로 다른 코드를 가리킨다. 이 저장소가 락에서 지킨 원칙과
 * 같다 — 애매하면 치환하지 말고 거부한다.
 */
export function parseVersion(s) {
  const m = RE.exec(String(s ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export const formatVersion = (v) => `${v.major}.${v.minor}.${v.patch}`

/**
 * 다음 버전. `from` 이 null 이면 첫 버전이다.
 *
 * 첫 버전은 단계와 무관하게 `1.0.0` 이다. dev 에서 시작했다고 `0.0.1` 을 주면
 * 사람이 "아직 아무것도 없다" 로 읽는데, 실제로는 첫 기능이 들어간 상태다.
 */
export function nextVersion(from, level) {
  const part = PART[level]
  if (!part) throw new Error(`알 수 없는 단계: ${level} (main | func | dev)`)
  if (!from) return { major: 1, minor: 0, patch: 0 }

  // 🔴 아래 자리를 반드시 0 으로 되돌린다. 1.2.3 에서 minor 를 올리면 1.3.0 이지
  //    1.3.3 이 아니다. 안 되돌리면 patch 자리가 영원히 남아 두 갈래의 이력이
  //    한 숫자에 섞인다.
  if (part === 'major') return { major: from.major + 1, minor: 0, patch: 0 }
  if (part === 'minor') return { major: from.major, minor: from.minor + 1, patch: 0 }
  return { major: from.major, minor: from.minor, patch: from.patch + 1 }
}

/**
 * 태그 목록에서 가장 높은 버전. 이름순이 아니라 **숫자순**으로 고른다.
 *
 * 🔴 문자열 정렬은 `v1.10.0 < v1.9.0` 이라고 답한다. `git tag --sort=-v:refname`
 *    이 대신 해주긴 하지만, 여기서 다시 세는 이유는 그 정렬 옵션이 없는 git
 *    버전과 CI 이미지가 실제로 있기 때문이다. 판정을 남에게 맡기지 않는다.
 *
 * 읽을 수 없는 태그는 **건너뛴다.** 여기서는 그것이 안전한 쪽이다 —
 * `v` 로 시작하는 아무 태그(`v-old`, `vNext`)나 붙을 수 있고, 그것 때문에
 * 릴리스 전체를 멈추는 것은 과하다. 버전 형식인 것만 후보로 센다.
 */
export function latestVersion(tags) {
  let best = null
  for (const t of tags ?? []) {
    const v = parseVersion(t)
    if (!v) continue
    if (!best || v.major > best.major
      || (v.major === best.major && v.minor > best.minor)
      || (v.major === best.major && v.minor === best.minor && v.patch > best.patch)) best = v
  }
  return best
}

/**
 * 브랜치와 태그 목록에서 다음 태그 이름까지.
 * @returns {{level: string, from: string|null, next: string, tag: string}}
 */
export function planBump(branch, tags) {
  // 🔴 제품이 아닌 파트는 **버전을 안 갖는다.** 던지지 않고 skip 을 준다 —
  //    던지면 `common/dev` 에 push 할 때마다 CI 의 version 잡이 빨개지고,
  //    그건 "고칠 것이 있다" 는 뜻이 아니라 "여긴 버전이 없다" 는 뜻이다.
  //    고장과 해당 없음을 같은 색으로 칠하면 사람이 둘을 구분하지 못한다.
  if (isNonProductPart(branch)) {
    return {
      level: levelOf(branch),
      skip: true,
      part: partOf(branch),
      reason: `${partOf(branch)} 은 제품 코드가 없는 파트라 버전을 올리지 않습니다.`,
    }
  }
  const level = levelOf(branch)
  if (!level) {
    throw new Error(
      `버전을 올리는 브랜치가 아닙니다: ${branch}\n` +
        `  main / func / dev 로 끝나는 브랜치에서만 올립니다 (fe/dev 처럼 접두사는 괜찮습니다).`,
    )
  }
  const from = latestVersion(tags)
  const next = nextVersion(from, level)
  return {
    level,
    from: from ? formatVersion(from) : null,
    next: formatVersion(next),
    tag: `v${formatVersion(next)}`,
  }
}
