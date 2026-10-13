/**
 * "여기에 새로 하나 만들려면, 그 밖에 어디를 고쳐야 하나"
 *
 * 🔴 온보딩 실험에서 도구가 답하지 못한 유일한 질문이 이것이었다.
 *
 * 맥락 없는 에이전트에게 theHarvester 를 이해시켰더니 M1(무엇을 하나)·M2(진입점)·
 * M5(위험한 곳)는 전부 맞혔는데, **"새 데이터 소스를 추가하려면 어디를 고치나"** 에서
 * 이렇게 적었다:
 *
 * > 도구는 "새 소스를 어디에 등록하는지" 를 명시적 문장으로 말해준 적은 없다 —
 * > 이건 숨은 결합 점수들을 조합해서 내가 추론한 것이다.
 *
 * 신입이 실제로 막히는 자리가 정확히 거기다. 무엇을 하는 물건인지는 README 가
 * 말해주고, 위험한 곳은 커밋 수가 말해준다. 그런데 **"내가 뭘 건드려야 하나"** 는
 * 아무도 안 알려준다. 코드를 다 읽은 사람만 안다.
 *
 * ## 답은 이미 히스토리에 있다
 *
 * 누군가 전에 같은 일을 했다. `discovery/` 에 새 파일을 만든 커밋들이 있고,
 * 그 커밋들이 **함께 고친 기존 파일**이 곧 등록 지점이다.
 *
 *   discovery/ 에 새 파일을 추가한 커밋 23건
 *     lib/core.py             19건 (83%)   ← 여기 등록한다
 *     __main__.py             17건 (74%)   ← CLI 에 붙인다
 *     discovery/constants.py  11건 (48%)
 *
 * 추측이 아니라 관측이다. 그리고 **언어를 타지 않는다** — 파서가 못 읽는 루비에서도
 * 히스토리는 똑같이 읽힌다. 코퍼스가 히스토리 기반 지표를 모든 언어에 쓰는 것과 같은 이유다.
 *
 * ## 여기는 순수 함수만 둔다
 *
 * git 호출은 server.mjs 가 한다. 그래야 커밋 목록을 손으로 만들어 경계를 검증할 수 있다.
 */

/** 이 수보다 적은 커밋으로는 답하지 않는다. 두세 번은 우연이다. */
export const MIN_COMMITS = 5

/** 이 비율보다 드물게 나오는 파일은 등록 지점이라고 부르지 않는다. */
export const MIN_SHARE = 0.3

/**
 * 새 파일을 추가한 커밋들에서 함께 고쳐진 기존 파일을 찾는다.
 *
 * @param {Array<{sha: string, added: string[], touched: string[]}>} commits
 *   `added` 는 이 커밋이 대상 범위 안에 **새로 만든** 파일,
 *   `touched` 는 그 커밋이 건드린 **모든** 파일.
 * @param {object} opts
 *   minCommits  표본 하한 (기본 MIN_COMMITS)
 *   minShare    등록 지점으로 부를 최소 비율 (기본 MIN_SHARE)
 *   limit       최대 몇 개까지 낼지
 * @returns {{answered: boolean, n: number, points: Array<{path,support,share}>,
 *            why: string|null, considered: number}}
 */
export function registrationPoints(commits, { minCommits = MIN_COMMITS, minShare = MIN_SHARE, limit = 8 } = {}) {
  const usable = (commits ?? []).filter((c) => c && c.added?.length && c.touched?.length)

  if (usable.length < minCommits) {
    return {
      answered: false,
      n: usable.length,
      points: [],
      considered: 0,
      // 🔴 모른다고 말한다. 한 번 거짓말한 지침은 그 다음부터 전부 무시당한다.
      why: usable.length === 0
        ? '이 범위에 파일이 새로 추가된 적이 없습니다'
        : `새 파일을 추가한 커밋이 ${usable.length}건뿐입니다 (하한 ${minCommits})`,
    }
  }

  const support = new Map()
  for (const c of usable) {
    // 🔴 그 커밋이 새로 만든 파일 자신은 제외한다.
    // 안 그러면 "새 파일을 만들려면 새 파일을 만들어야 합니다" 가 1위로 나온다.
    const born = new Set(c.added)
    // 같은 커밋에 같은 파일이 두 번 세어지지 않게 한 번 접는다.
    for (const p of new Set(c.touched)) {
      if (born.has(p)) continue
      support.set(p, (support.get(p) ?? 0) + 1)
    }
  }

  const points = [...support]
    .map(([path, s]) => ({ path, support: s, share: s / usable.length }))
    .filter((p) => p.share >= minShare)
    // 같은 비율이면 경로 이름으로 갈라 답을 결정론적으로 만든다.
    .sort((a, b) => b.support - a.support || (a.path < b.path ? -1 : 1))
    .slice(0, limit)

  return {
    answered: points.length > 0,
    n: usable.length,
    considered: support.size,
    points,
    why: points.length
      ? null
      : `${usable.length}건을 봤지만 ${Math.round(minShare * 100)}% 이상 함께 바뀐 파일이 없습니다`
        + ' — 추가할 때 정해진 등록 지점이 없는 구조일 수 있습니다',
  }
}

/**
 * 경로가 대상 범위 안인가.
 *
 * 디렉터리는 `/` 로 끝나는 접두사로 본다. `discovery` 가 `discovery_old/` 를
 * 삼키면 안 되므로 경계를 명시한다.
 */
export function inScope(path, scope) {
  if (!scope) return true
  const s = scope.endsWith('/') ? scope : `${scope}/`
  return path === scope || path.startsWith(s)
}

/**
 * 한 문장으로 말한다.
 *
 * 🔴 숫자만 주면 사람은 그것을 해석하지 못한다. 온보딩 실험에서 에이전트가
 * "숨은 결합 5 n=22" 의 5 가 뭔지 모르겠다고 한 것이 같은 문제였다.
 * 그래서 여기서 만드는 문장에는 **무엇을 몇 건 중 몇 건 봤는지**가 들어간다.
 */
export function say(result, scope) {
  const where = scope ? `${scope} 에` : '이 저장소에'
  if (!result.answered) return `${where} 새로 만들 때 어디를 고치는지 아직 말할 수 없습니다 — ${result.why}`
  const top = result.points[0]
  return `${where} 새 파일을 추가한 커밋 ${result.n}건 중 ${top.support}건(${Math.round(top.share * 100)}%)이`
    + ` ${top.path} 를 함께 고쳤습니다`
}
