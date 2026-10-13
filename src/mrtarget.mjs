/**
 * MR(**Merge Request** — 내 브랜치의 변경을 다른 브랜치로 합쳐 달라는 요청)이
 * **한 칸씩만 올라가게** 하는 판정.
 *
 * 순수 로직만 둔다. git 호출도 환경변수도 여기 없다 (`tools/mr-target.mjs` 가 담당).
 *
 * ── 왜 설정이 아니라 코드인가 ────────────────────────────────────────────────
 *
 * 이 GitLab 은 Community Edition(무료판)이라 **"이 브랜치로는 MR 을 못 연다"
 * 는 설정이 없다.** 대상 브랜치를 제한하는 기능 자체가 없고, 있는 것은
 * 기본 대상 브랜치를 정해 두는 것뿐이다 — 사람이 드롭다운에서 바꾸면 그만이다.
 *
 * 그래서 잡(job — 파이프라인이 돌리는 작업 하나)으로 만든다. 루트 `CLAUDE.md`
 * 3절이 말하는 그대로다: 권한은 사람의 목록이고 파이프라인은 코드의 조건이다.
 *
 * ── 왜 단계 판정을 새로 안 만드는가 ───────────────────────────────────────────
 *
 * 🔴 `levelOf` 를 `src/version.mjs` 에서 **가져다 쓴다.** 여기서 다시 만들면
 *    한 저장소에 브랜치 단계 판정이 둘이 되고, 그러면 `back/main` 이 최상위인지
 *    파트인지를 **버전 자동화와 MR 검사가 서로 다르게 답할 수 있다.**
 *    거버넌스가 경로 매칭을 새로 안 만들고 `protocol.mjs` 의 `coversPath` 를
 *    그대로 쓴 것과 같은 이유다.
 */

import { levelOf, partOf, isNonProductPart } from './version.mjs'

// 🔴 `partOf` 는 `version.mjs` 로 옮겼다. 여기서 다시 내보내는 것은 이미 이 모듈에서
//    가져다 쓰는 곳(`src/promote.mjs`, `test/mrtarget.test.mjs`)을 깨지 않기 위해서다.
export { partOf }

/**
 * 종료 코드. 선점 프로토콜·거버넌스와 같은 관례다.
 *
 * 🔴 **2 와 1 을 가르는 것이 핵심이다.**
 *    2 는 "대상 브랜치를 바꾸면 되는 일", 1 은 "내가 판정을 못 했다".
 *    뭉치면 AI 에이전트가 고장을 **고치면 되는 일**로 읽고 엉뚱한 곳을 고친다.
 */
export const EXIT = {
  OK: 0,
  /** 규칙 위반 — 사람이 MR 대상을 바꾸면 풀린다 */
  BLOCKED: 2,
  /** 판정 불가 — 브랜치 이름을 못 받았다. 환경을 고쳐야 한다 */
  UNDECIDABLE: 1,
}

/**
 * MR 의 소스도 대상도 될 수 없는 브랜치.
 *
 * 장부(`axmap/claims`)와 표(`axmap/votes`)는 **코드와 이력을 공유하지 않는
 * 고아 브랜치**(orphan branch — 부모 커밋이 없어 코드 브랜치와 아예 갈라져 있는
 * 브랜치)다. 도구가 직접 쓰고 읽는 자리이지 사람이 합치는 자리가 아니다.
 *
 * 이름만 보면 `axmap/claims` 는 "axmap 파트의 claims 브랜치" 처럼 생겼다.
 * 그래서 규칙에 안 걸리고 기능 브랜치로 취급돼 **`<파트>/dev` 로 올릴 수 있게
 * 된다.** 명시적으로 막지 않으면 그 길이 열려 있다.
 */
const RESERVED = new Set(['axmap/claims', 'axmap/votes', 'axmap/bus'])

/**
 * 긴급 수정 브랜치인가 — `hotfix/…` 로 시작하는가.
 *
 * ── 🔴 이 판정은 사다리에 **구멍을 낸다.** 그 대가를 알고 낸 것이다 ──────────
 *
 * 사다리(기능 → `<파트>/dev` → `<파트>/main` → `main`)의 요점은 "아래 관문을
 * 지난 것만 위로 간다" 이다. 여기만 그 규칙을 어긴다. 왜 어기는가.
 *
 * **고장 난 것이 `main` 자신일 때 사다리가 막다른 길이 되기 때문이다.**
 * 2026-08-26 에 실제로 그랬다 — `main` 의 `.gitlab-ci.yml` 이 무효라 모든
 * 파이프라인이 잡 0개로 죽었는데, 그것을 고치는 MR 이 `verify:mr-target` 에
 * 걸려 `main` 으로 갈 수 없었다(S15P21E201-22). `Pipelines must succeed` 가
 * 켜져 있었다면 **팀 전체가 CI 를 영영 못 고쳤을 것이다.**
 *
 * 탈출구가 없으면 사람은 시스템 밖에서 탈출한다 — 스위치를 잠깐 내리거나
 * `main` 에 직접 push 한다. 둘 다 흔적이 안 남는다. **탈출구를 시스템 안에 두는
 * 편이 낫다.** 보이고, 기록되고, 규칙으로 다듬을 수 있다.
 *
 * 남는 브레이크가 둘 있어서 이 구멍이 공짜 통과가 되지는 않는다.
 *   · `main` 으로 가는 MR 은 `governance` 가 정족수를 요구한다 (표 없이는 못 간다)
 *   · 브랜치 이름이 `hotfix/…` 라 diff 목록과 이력에 그대로 남는다
 *
 * 🔴 이름만 보고 판정한다 — 내용이 정말 긴급한지는 코드가 알 수 없다.
 *    그 판단은 표를 던지는 사람의 몫이고, 여기서 하려 들면 못 하는 판정을
 *    하는 척하게 된다.
 *
 * 규약에는 원래부터 있던 타입이다 — `docs/git-convention.md` 의
 * *"`hotfix`: 운영 중인 `main`의 긴급 수정"*. 게이트만 그것을 몰랐다.
 */
function isHotfix(branch) {
  return /^hotfix\//.test(branch)
}

/**
 * 이 브랜치가 무엇인지 사람이 읽는 말로.
 *
 * `levelOf` 가 주는 `main`·`func`·`dev`·`null` 을 그대로 노출하지 않는 이유는
 * `null` 이 "기능 브랜치" 라는 뜻인데 그 말이 어디에도 안 적혀 있어서다.
 */
export function describeBranch(branch) {
  const name = String(branch ?? '').trim()
  if (!name) return '이름 없음'
  if (RESERVED.has(name)) return '도구 전용 브랜치'
  switch (levelOf(name)) {
    case 'main': return '최상위'
    case 'func': return '파트 브랜치'
    case 'dev': return '파트 개발 브랜치'
    default: return '기능 브랜치'
  }
}

/**
 * 이 브랜치를 어디로 올릴 수 있나 — 사람이 읽는 한 줄.
 *
 * 목록이 아니라 문장인 이유: 기능 브랜치가 갈 수 있는 곳은 "존재하는 모든 파트의
 * dev" 라 목록으로 적으려면 파트 목록을 알아야 하고, 그건 순수 판정이 알 수 없다.
 */
export function allowedTargetsOf(branch) {
  const name = String(branch ?? '').trim()
  if (RESERVED.has(name)) return '없다 — 도구가 직접 쓰는 브랜치라 MR 로 합치지 않는다'
  switch (levelOf(name)) {
    case 'main': return '없다 — 최상위가 종점이다'
    case 'func':
      return isNonProductPart(name)
        ? '없다 — 이 파트에는 파트 브랜치 단계가 없다. `<파트>/dev` 에서 바로 올린다'
        : '최상위 `main`'
    case 'dev': {
      // 제품이 아닌 파트는 파트 단계를 건너뛴다 — 갈 곳이 최상위뿐이다.
      if (isNonProductPart(name)) return '최상위 `main` — 이 파트에는 파트 브랜치 단계가 없다'
      const part = partOf(name)
      return part ? `같은 파트의 \`${part}/main\` (= \`${part}/func\`)` : '같은 파트의 파트 브랜치'
    }
    default:
      return isHotfix(name)
        ? '`<파트>/dev`, 또는 `main` 이 그 자체로 고장 났다면 최상위 `main`'
        : '`<파트>/dev` — 예: `front/dev` · `back/dev`'
  }
}

/**
 * 이 MR 이 한 칸씩 올라가는가.
 *
 * @param {string} source 합쳐 달라고 내미는 쪽 브랜치
 * @param {string} target 합쳐 받는 쪽 브랜치
 * @returns {{ok:boolean, exit:number, code:string, message:string, source?:string, target?:string}}
 */
export function checkTarget(source, target) {
  const s = String(source ?? '').trim()
  const t = String(target ?? '').trim()

  // 🔴 이름을 못 받은 것은 통과가 아니다. 못 재면 막는다 — 락에서 최악은 조용한 통과다.
  if (!s || !t) {
    return {
      ok: false,
      exit: EXIT.UNDECIDABLE,
      code: 'branch-unknown',
      message:
        '소스 또는 대상 브랜치 이름을 받지 못했습니다.\n' +
        '  추측하지 않습니다 — 단계를 잘못 읽으면 막아야 할 MR 을 통과시킵니다.',
    }
  }

  const bad = (code, message) => ({ ok: false, exit: EXIT.BLOCKED, code, message, source: s, target: t })
  const good = (message) => ({ ok: true, exit: EXIT.OK, code: 'ok', message, source: s, target: t })

  if (s === t) return bad('same-branch', '소스와 대상이 같은 브랜치입니다.')
  if (RESERVED.has(s)) return bad('reserved-source', `\`${s}\` 는 도구가 직접 쓰는 브랜치라 MR 의 소스가 될 수 없습니다.`)
  if (RESERVED.has(t)) return bad('reserved-target', `\`${t}\` 는 도구가 직접 쓰는 브랜치라 MR 의 대상이 될 수 없습니다.`)

  const from = levelOf(s)
  const to = levelOf(t)

  // 기능 브랜치 → 파트 dev. 그리고 hotfix 만 최상위로도 갈 수 있다.
  if (from === null) {
    if (to === 'dev') return good('기능 브랜치 → 파트 개발 브랜치')
    if (to === 'main' && isHotfix(s)) return good('긴급 수정 → 최상위 (사다리를 건너뛴다)')
    return bad(
      'feature-must-target-dev',
      '기능 브랜치는 파트 개발 브랜치(`<파트>/dev`)로만 올립니다.\n' +
        '  한 칸씩 올라가야 아래 관문을 지난 것만 위로 갑니다 — 건너뛰면 그 관문이 없는 것과 같습니다.\n' +
        '  `main` 이 그 자체로 고장 났을 때만 `hotfix/…` 로 바로 올립니다.',
    )
  }

  // 파트 dev → 같은 파트의 파트 브랜치.
  if (from === 'dev') {
    // 🔴 제품이 아닌 파트(`common` 등)에는 파트 브랜치 단계가 **없다.**
    //
    //    `<파트>/main` 의 뜻은 "이 파트의 릴리스 후보" 다. 릴리스할 제품이 없는
    //    파트에는 그 자리가 비어 있고, 비어 있는 칸을 지나가라고 요구하면 사다리가
    //    **막다른 길**이 된다 — 2026-08-27 에 실제로 그랬다. 팀 문서가 `common/dev`
    //    까지 올라온 뒤, `common/main` 이 없어서 `main` 으로 갈 길이 사라졌다.
    //    그래서 문서는 clone 하면 딸려오는 `main` 에 영영 못 들어갔다.
    //
    //    🔴 **통과가 늘어난다.** 그 대가를 알고 늘린다 — `main` 으로 가는 MR 은
    //    `governance` 가 정족수를 요구하므로 표 없이는 여전히 못 간다.
    //    사다리가 지키려던 것("아래 관문을 지난 것만 위로")은 그대로 있고,
    //    없는 칸을 요구하지 않을 뿐이다.
    if (isNonProductPart(s)) {
      if (to === 'main') return good('제품이 아닌 파트의 개발 브랜치 → 최상위 (파트 단계가 없다)')
      return bad(
        'nonproduct-must-target-top',
        `\`${partOf(s)}\` 는 제품 코드가 없는 파트라 **파트 브랜치 단계가 없습니다.**\n` +
          '  문서·CI·공용 설정 자리이고, 버전도 갖지 않습니다.\n' +
          '  최상위 `main` 으로 바로 올립니다.',
      )
    }
    if (to !== 'func') {
      return bad(
        'dev-must-target-part',
        `\`${s}\` 는 같은 파트의 파트 브랜치로만 올립니다.`,
      )
    }
    const a = partOf(s)
    const b = partOf(t)
    // 🔴 파트를 대조하지 않으면 `front/dev → back/main` 이 통과한다.
    //    프론트에서 검토된 적 없는 코드가 백엔드 파트의 릴리스 후보로 들어간다.
    if (a === null || b === null || a !== b) {
      return bad(
        'part-mismatch',
        `파트가 다릅니다 — \`${a ?? '?'}\` 에서 \`${b ?? '?'}\` 로 건너뛸 수 없습니다.`,
      )
    }
    return good('파트 개발 브랜치 → 같은 파트의 파트 브랜치')
  }

  // 파트 브랜치 → 최상위.
  if (from === 'func') {
    // 🔴 제품이 아닌 파트에 파트 브랜치가 있다는 것 자체가 실수다. 막고 알린다 —
    //    조용히 통과시키면 `common/main` 이 다시 생기고, 그 브랜치는 아무도
    //    무엇에 쓰는지 모른 채 사다리 한 칸을 더 만든다.
    if (isNonProductPart(s)) {
      return bad(
        'nonproduct-has-no-part-branch',
        `\`${s}\` 는 만들지 않습니다 — \`${partOf(s)}\` 에는 파트 브랜치 단계가 없습니다.\n` +
          '  `<파트>/dev` 에서 최상위 `main` 으로 바로 올립니다.',
      )
    }
    if (to === 'main') return good('파트 브랜치 → 최상위')
    return bad('part-must-target-main', `\`${s}\` 는 최상위 \`main\` 으로만 올립니다.`)
  }

  // 최상위에서 나가는 MR 은 없다.
  return bad('top-is-terminal', '최상위 `main` 은 종점입니다. 여기서 나가는 MR 은 없습니다.')
}

/**
 * 사람과 에이전트가 함께 읽는 출력.
 *
 * 메시지를 순수 로직에 두는 것은 이 저장소의 관례다 (`protocol.mjs` 의
 * `formatBlocks`, `governance.mjs` 의 `formatVerdict`). 덕분에 **"거부당했을 때
 * 어디로 가야 하는지가 출력에 있는가" 를 테스트로 고정할 수 있다.**
 */
export function formatCheck(result) {
  const L = []
  if (result.exit === EXIT.UNDECIDABLE) {
    L.push('MR 대상 검사 불가 — 브랜치 이름을 읽지 못했습니다.')
    L.push('')
    L.push(`  ${result.message.split('\n').join('\n  ')}`)
    L.push('')
    L.push('환경 문제입니다. 대상 브랜치를 바꿔도 풀리지 않습니다.')
    return L.join('\n')
  }

  const { source, target } = result
  if (result.ok) {
    L.push(`MR 대상 통과 — ${result.message}`)
    L.push(`  ${source} → ${target}`)
    return L.join('\n')
  }

  L.push('MR 대상 거부 — 한 칸씩만 올라갑니다.')
  L.push('')
  L.push(`  올린 곳   : ${source} (${describeBranch(source)})`)
  L.push(`  올린 대상 : ${target} (${describeBranch(target)})`)
  L.push('')
  L.push(`  ${result.message.split('\n').join('\n  ')}`)
  L.push('')
  // 🔴 거부하면서 **갈 수 있는 곳을 함께 말한다.** 선점 프로토콜이 거부할 때
  //    점유자·작업·남은 시간을 함께 주는 것과 같은 규칙이다 — 이유 없는 거부는
  //    같은 요청을 다시 보내게 만든다.
  L.push(`  \`${source}\` 가 갈 수 있는 곳: ${allowedTargetsOf(source)}`)
  L.push('')
  L.push('MR 의 대상 브랜치를 바꾸고 다시 여세요. 코드를 고칠 일이 아닙니다.')
  return L.join('\n')
}
