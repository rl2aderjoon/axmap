/**
 * 합의제 MR(**Merge Request — 내 브랜치의 변경을 다른 브랜치로 합쳐 달라는 요청**)의
 * 순수 판정. 이 층이 답하는 질문은 **하나뿐**이다.
 *
 *   "이 변경은 정족수(**통과에 필요한 최소 찬성 수**)를 채웠는가?"
 *
 * 리뷰 코멘트·담당자 배정·라벨은 GitLab 이 이미 한다. 여기서는 숫자 하나만 센다.
 * 그 숫자가 무엇인지, 어떤 표가 왜 안 세졌는지를 사람과 에이전트가 함께 읽을 수
 * 있는 형태로 돌려주는 것까지가 이 파일의 일이다.
 *
 * 🔴 여기에는 git 도 파일시스템도 `Date.now()` 도 없다. 시각은 인자로 받는다.
 *    `src/protocol.mjs` / `src/version.mjs` 와 같은 이유다 — 판정을 검증하려고
 *    저장소를 만들거나 90일을 기다릴 수는 없다. 부수효과는 게이트
 *    (`governance/gate.mjs` — git 에서 재료를 모아 이 파일의 `judge()` 를 부르는
 *    쪽. 2026-08-26 에 만들어졌다)가 전담한다.
 *
 * ── 왜 GitLab 이 아니라 저장소 안의 파일인가 ──────────────────────────────
 *
 * 표를 GitLab 의 Approve 버튼으로 세면, 이 저장소를 다른 곳으로 clone 한 사람에게는
 * 이 층이 **존재하지 않는다.** 원격이 셋(`origin`·`personal`·`aws`)이고 오픈소스
 * 이식이 목표인 저장소에서 그건 치명적이다. 파일로 두면 `git clone` 이 곧 이관이고,
 * 표의 이력이 서버가 아니라 저장소에 남는다. 근거는 docs/DECISIONS.md 의 D18.
 *
 * ── 이 층이 지키는 성질 (G1~G5) ──────────────────────────────────────────
 *
 *   G1  자기 표는 세지 않는다 — 소스 브랜치 커밋의 author 인 사람의 표는 무효
 *       (누구까지를 "author" 로 볼지는 정책의 `self_vote` 가 정한다. 기본은 전부)
 *   G2  정책은 언제나 **타깃 브랜치**에서 읽는다 (이 파일의 밖 — 게이트의 책임)
 *   G3  표는 커밋(sha)에 묶인다 — 헤드가 바뀌면 효력을 잃는다. 사라지지는 않는다
 *   G4  한 사람은 한 표 — email 이 유일 키다
 *   G5  못 세면 통과가 아니다 — 판정 불가는 언제나 빨강
 *
 * G2 만 이 파일에 없다. 어느 브랜치에서 정책을 읽어오는가는 git 을 만지는 일이라
 * 게이트가 한다. 대신 여기서는 **읽어온 정책이 성립하는가**만 본다.
 */

import { normalizePath, pathsOverlap, coversPath } from './protocol.mjs'

/**
 * 정책 파일의 **기본** 자리. `amendment.paths` 가 이 경로를 덮는지 검사하는 데 쓴다.
 *
 * 🔴 왜 `axmap/` 안이 아니라 저장소 루트인가 — **도구는 나가고 데이터는 남는다.**
 *    axMap 은 곧 자기 저장소로 떨어져 나가고, 그때 팀 저장소에서 `axmap/` 폴더는
 *    사라진다. 그런데 "누가 투표권자인가" 는 도구가 정하는 것이 아니라 팀이
 *    정하는 것이라 팀 저장소에 남아야 한다 — 장부 브랜치(`axmap/claims`)와
 *    표 브랜치(`axmap/votes`)를 팀 저장소에 남기는 것과 같은 이유다.
 *
 * axMap 은 이제 범용 도구이므로 남의 저장소는 정책을 다른 자리에 둘 수 있다.
 * 그래서 이것은 **기본값**이고, 실제 경로는 부르는 쪽이 정한다:
 * `--policy <경로>` 플래그 → 환경변수 `AXMAP_POLICY_PATH` → 이 기본값.
 * 이 층에서는 `validatePolicy(policy, { policyPath })` 로 받는다.
 *
 * 🔴 옛 자리를 자동으로 대신 찾아보는 폴백은 **없다.** 두 자리를 다 보면 어느
 *    것이 진짜인지 아무도 모르게 된다 — 이 저장소가 "장부가 둘" 로 한 번 아프게
 *    배운 모양이다. 못 찾으면 멈추고 어디를 봤는지 말한다.
 */
export const DEFAULT_POLICY_PATH = 'governance/policy.json'

/**
 * 종료 코드. SPEC.md §8 의 관례를 잇는다 (0 성공 / 1 환경 / 2 거부 / 4 깨짐).
 *
 * 🔴 **2 와 1 을 가르는 것이 이 층의 핵심이다.**
 *    2 는 "사람이 아직 안 눌렀다" — 정상적인 상태다. 투표를 요청하면 된다.
 *    1 은 "내가 판정을 못 했다" — 환경이 고장 났다. 고쳐야 한다.
 *    둘을 뭉치면 에이전트가 고장을 "기다리면 되는 일" 로 읽고 영원히 기다린다.
 */
export const EXIT = {
  OK: 0, // 정족수 충족
  UNDECIDABLE: 1, // 판정 불가 — 정책 못 읽음, 타깃 브랜치 모름, JSON 깨짐
  SHORT: 2, // 정족수 미달 — 사람에게 투표를 요청한다
  POLICY_BROKEN: 4, // 정책 자체가 깨짐 — 계층 위반, email 중복, threshold 상한 초과
}

/** 승계 설정을 안 적어 두었을 때의 기본값. D18 에서 정한 값이다. */
export const DEFAULT_SUCCESSION = { window_days: 90, top: 3 }

/**
 * 판정을 **끝까지 못 간** 경우에만 던진다. 미달(2)은 예외가 아니라 정상 결과다.
 *
 * `exit` 를 예외에 붙여 두는 이유: 부르는 쪽(게이트)이 메시지를 다시 해석해서
 * 코드를 고르면, 문구가 바뀌는 순간 판정이 조용히 달라진다.
 */
export class GovernanceError extends Error {
  constructor(message, { exit = EXIT.UNDECIDABLE, code = 'undecidable' } = {}) {
    super(message)
    this.name = 'GovernanceError'
    this.exit = exit
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 비교용 정규화
//
// 🔴 정규화한 값은 **비교에만** 쓰고 절대 되돌려 쓰지 않는다. 출력에는 언제나
//    원본이 나간다. 이 저장소가 락에서 지킨 "치환하지 말고 거부한다" 와 방향이
//    반대로 보이지만 그렇지 않다 — 락에서 치환이 위험했던 이유는 서로 다른 두
//    소유자를 하나로 만들기 때문이었다. 여기서는 대소문자만 접고, 접힌 두 신원이
//    실제로 존재하면 `validatePolicy` 가 **정책 단계에서 거부**한다(G4). 즉
//    충돌은 판정이 아니라 정책에서 터진다.
// ---------------------------------------------------------------------------

const fold = (v) => String(v ?? '').trim().toLowerCase()
const isInt = (v) => Number.isInteger(v)
const isStr = (v) => typeof v === 'string' && v.trim() !== ''

// ---------------------------------------------------------------------------
// 자기 표 배제(G1)의 **범위** — 정책의 `self_vote`
// ---------------------------------------------------------------------------

/**
 * `self_vote` 에 적을 수 있는 값. **G1 을 끄는 스위치가 아니라 범위를 정하는 값**이다.
 *
 *   `"authors"`  소스 브랜치의 **모든** 커밋 author 를 배제한다 — 지금까지의 동작
 *   `"tip"`      소스 브랜치 **맨 위 커밋(tip)의 author 한 명만** 배제한다.
 *                맨 위 커밋은 표가 묶이는 sha 자신이다 (G3), 즉 "이번에 머지될
 *                커밋을 만든 사람" 이다
 *   `"off"`      아무도 배제하지 않는다
 *
 * 🔴 **필드가 없으면 `"authors"` 다.** 이 옵션이 없던 시절에 쓰던 저장소의 판정이
 *    조용히 바뀌면 안 된다. 거버넌스에서 조용한 변화는 우회로와 구분되지 않는다.
 *
 * 🔴 **왜 필요했나 — 실측.** 오래 쌓는 `<파트>/dev` 브랜치에서는 시간이 갈수록
 *    커밋한 사람이 늘어 던질 수 있는 사람이 0 으로 수렴한다. 팀 저장소의
 *    `common/dev` 는 투표권자 4명 중 3명이 커밋해서 **던질 수 있는 사람 1명 <
 *    필요 2표** 였다. 이건 "아직 표가 모자라다"(미달)가 아니라 **영구히 잠긴 것**
 *    이고, 표를 더 모아도 풀리지 않는다.
 *
 * 🔴 그래도 `"off"` 를 기본으로 두지 않는 이유: G1 이 실제로 막는 것은 **"혼자
 *    올리고 혼자 통과"** 하나다. `"tip"` 은 그것을 여전히 막는다 — 머지될 커밋을
 *    만든 사람은 못 던진다. `"off"` 는 그 마지막 한 겹까지 없앤다.
 */
export const SELF_VOTE_MODES = ['authors', 'tip', 'off']

/** `self_vote` 를 안 적어 두었을 때의 값. **바꾸면 기존 저장소의 판정이 바뀐다.** */
export const DEFAULT_SELF_VOTE = 'authors'

const selfVoteList = () => SELF_VOTE_MODES.map((m) => `"${m}"`).join(' · ')

/** 값 하나가 `self_vote` 로 성립하는가. 없는 것(`undefined`/`null`)은 성립으로 친다. */
const isSelfVoteValue = (v) => v === undefined || v === null || (typeof v === 'string' && SELF_VOTE_MODES.includes(v))

/**
 * 정책에서 자기 표 배제 범위를 읽는다. **없으면 기본값, 이상하면 던진다.**
 *
 * 🔴 이상한 값을 조용히 기본값으로 떨어뜨리지 않는다. 오타 하나가 배제 범위를
 *    바꾸면 그건 "표가 모자란다" 가 아니라 **틀린 답을 자신 있게 낸 것**이다.
 *    정상 경로에서는 `validatePolicy` 가 먼저 잡으므로 여기까지 오지 않는다 —
 *    이 함수의 throw 는 정책 검증을 건너뛰고 부르는 쪽을 위한 마지막 문이다.
 */
export function selfVoteMode(policy) {
  const raw = policy?.self_vote
  if (raw === undefined || raw === null) return DEFAULT_SELF_VOTE
  if (!isSelfVoteValue(raw)) {
    throw new GovernanceError(
      `\`self_vote\` 는 ${selfVoteList()} 중 하나여야 합니다: ${JSON.stringify(raw)}`,
      { code: 'self-vote-invalid' },
    )
  }
  return raw
}

/**
 * 이번 판정에서 **표를 못 던지는 사람들**의 email 집합 (비교용으로 접은 값).
 *
 * 🔴 **`majorityThreshold`(분모)와 `countVotes`(분자)가 이 함수 하나만 쓴다.**
 *    둘이 다른 기준으로 세면 "필요한 표" 와 "센 표" 의 분모가 어긋나고, 그때는
 *    아무 에러 없이 판정만 틀린다 — 이 층에서 제일 나쁜 실패 모양이다.
 *
 * @param {string}   mode           `selfVoteMode()` 가 돌려준 값
 * @param {string[]} authorEmails   소스 브랜치 커밋들의 author email
 * @param {string|null} tipAuthorEmail 맨 위 커밋의 author email (`"tip"` 에서만 쓴다)
 */
function excludedAuthors(mode, authorEmails, tipAuthorEmail) {
  if (mode === 'off') return new Set()
  if (mode === 'tip') {
    if (!isStr(tipAuthorEmail)) {
      // 맨 위 커밋의 author 를 모르면 **누구를 빼야 하는지 자체를 모른다.**
      // 미달이 아니라 판정 불가다 (G5 — 못 세면 통과가 아니다).
      throw new GovernanceError(
        'self_vote 가 "tip" 인데 소스 브랜치 맨 위 커밋의 author email 을 받지 못했습니다.\n'
        + '  누구를 빼야 하는지 모르면 세지 않습니다 (G1).',
        { code: 'tip-author-missing' },
      )
    }
    return new Set([fold(tipAuthorEmail)])
  }
  return new Set(authorEmails.map(fold))
}

/**
 * `authorEmails` 가 배제에 쓸 만한 모양인가. **`"off"` 일 때만 없어도 된다.**
 *
 * 🔴 이 가드를 `"tip"` 에서도 유지하는 이유: `"tip"` 은 배제 범위를 좁힐 뿐
 *    G1 을 끄지 않는다. 소스에 새 커밋이 하나도 없는(= author 를 못 모은) 상태는
 *    `"tip"` 에서도 여전히 "셀 수 없는" 상태다 — 그때 무엇을 머지하는지 자체가
 *    불분명하다.
 */
const authorsUsable = (authorEmails) =>
  Array.isArray(authorEmails) && authorEmails.length > 0 && authorEmails.every(isStr)

// ---------------------------------------------------------------------------
// 표에 이유를 요구한다 — 정책의 `vote_note` (선택 필드)
// ---------------------------------------------------------------------------

/**
 * `vote_note` — **"이유 없는 표는 안 센다"** 를 정책이 켜는 자리.
 *
 * ```json
 * "vote_note": { "min_chars": 20, "since": "2026-09-01" }
 * ```
 *
 * | 칸 | |
 * |---|---|
 * | `min_chars` | `note` 를 몇 글자 이상 적어야 하는가. 안 적으면 `1`(= 뭐든 한 글자) |
 * | `since` | **시행일.** 이 시각 **이후**에 던져진 표(`at` 기준)에만 요구한다 |
 *
 * 🔴 **필드가 없으면 아무것도 요구하지 않는다.** `self_vote` 와 같은 불변식이다 —
 *    이 옵션이 없던 시절의 저장소가 판정이 조용히 바뀌는 것을 겪으면 안 된다.
 *    거버넌스에서 조용한 변화는 우회로와 구분되지 않는다.
 *
 * 🔴 **`since` 가 있는 이유는 소급 금지 하나다.** 이미 던져진 표는 그때의 규칙으로
 *    유효해야 한다. 규칙을 바꾸는 순간 지난 표가 무효가 되면, 그건 규칙을 고치는
 *    사람이 **남의 표를 지울 수 있다**는 뜻이 된다. `since` 를 안 적으면 시행일
 *    제한이 없다(= 모든 표에 요구) — 새 저장소가 처음부터 켜는 경우다.
 *
 * 🔴 **왜 세는 쪽에도 두는가.** 쓰는 쪽(`governance/vote.mjs`)만 막으면
 *    `git pull` 을 안 한 사람의 옛 `vote.mjs` 가 이 규칙을 모른 채 이유 없는 표를
 *    그냥 쓴다. 쓰는 쪽의 거부는 **친절함**이고, 진짜 문은 CI 에서 도는 이 층이다.
 */
export const DEFAULT_VOTE_NOTE_MIN_CHARS = 1

/**
 * `vote_note` 를 읽어 규칙 하나로 만든다. **문제는 모아서 돌려준다** —
 * `validatePolicy` 가 한 번에 다 보여줄 수 있게 (그 함수의 관례 그대로).
 *
 * @returns {{rule: {minChars:number, sinceMs:number|null, since:string|null}|null,
 *            problems: Array<{code:string,message:string}>}}
 */
function parseVoteNote(raw) {
  const problems = []
  const bad = (code, message) => problems.push({ code, message })

  if (raw === undefined || raw === null) return { rule: null, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    bad('vote-note-malformed', `\`vote_note\` 는 객체여야 합니다 (안 적으면 이유를 요구하지 않습니다): ${JSON.stringify(raw)}`)
    return { rule: null, problems }
  }

  let minChars = DEFAULT_VOTE_NOTE_MIN_CHARS
  if (raw.min_chars !== undefined && raw.min_chars !== null) {
    if (!isInt(raw.min_chars) || raw.min_chars < 1) {
      // 0 은 "길이 제한 없음" 이 아니라 **규칙이 꺼진 것**이다. 끄고 싶으면
      // `vote_note` 자체를 지우는 것이 정직하고, 그건 정책 diff 에 남는다.
      bad('vote-note-min-chars', `\`vote_note.min_chars\` 는 1 이상의 정수여야 합니다 (안 적으면 ${DEFAULT_VOTE_NOTE_MIN_CHARS}): ${JSON.stringify(raw.min_chars)}`)
    } else {
      minChars = raw.min_chars
    }
  }

  let sinceMs = null
  if (raw.since !== undefined && raw.since !== null) {
    if (!isStr(raw.since)) {
      bad('vote-note-since', `\`vote_note.since\` 는 시각 문자열이어야 합니다: ${JSON.stringify(raw.since)}`)
    } else {
      const t = Date.parse(raw.since)
      if (Number.isNaN(t)) {
        // 못 읽는 시행일을 "제한 없음" 으로 떨어뜨리지 않는다. 오타 하나가
        // 지난 표 전부를 무효로 만들 수 있는 자리다 (G5 와 같은 이유).
        bad('vote-note-since', `\`vote_note.since\` 를 시각으로 읽을 수 없습니다: ${JSON.stringify(raw.since)}`)
      } else {
        sinceMs = t
      }
    }
  }

  if (problems.length) return { rule: null, problems }
  return { rule: { minChars, sinceMs, since: raw.since ?? null }, problems }
}

/**
 * 정책에서 이유 규칙을 읽는다. **없으면 `null`(요구 안 함), 이상하면 던진다.**
 *
 * `selfVoteMode` 와 같은 모양이다 — 정상 경로에서는 `validatePolicy` 가 먼저
 * 잡으므로 여기까지 오지 않는다. 이 throw 는 정책 검증을 건너뛰고 부르는 쪽을
 * 위한 마지막 문이다.
 */
export function voteNoteRule(policy) {
  const { rule, problems } = parseVoteNote(policy?.vote_note)
  if (problems.length) {
    throw new GovernanceError(problems.map((p) => p.message).join('\n'), { code: problems[0].code })
  }
  return rule
}

/**
 * 표 한 장이 이유 규칙을 어겼는가. **안 어겼으면 `null`.**
 *
 * 🔴 쓰는 쪽(`governance/vote.mjs`)과 세는 쪽(`countVotes`)이 **이 함수 하나**를
 *    쓴다. 두 곳이 길이를 다르게 세면, 던질 때는 통과하고 셀 때는 무효가 되는
 *    표가 생긴다 — 던진 사람은 던졌다고 믿고 아무도 안 센다.
 *
 * 길이는 **앞뒤 공백을 뗀 뒤의 코드 포인트 수**다. 공백으로 길이를 채우는 것을
 * 이유로 치지 않기 위해서다. 이모지 하나는 한 글자로 센다.
 *
 * @param {{note:*, at:*, rule:object|null}} args `at` 은 표에 적힌 시각(소급 금지용)
 * @returns {{reason:'note-missing'|'note-short', detail:string|null}|null}
 */
export function voteNoteProblem({ note, at, rule }) {
  if (!rule) return null
  // 소급 금지 — 시행일 **이전**에 던져진 표는 그때의 규칙으로 유효하다.
  if (rule.sinceMs !== null && toMs(at, 'votes[].at') < rule.sinceMs) return null

  const text = typeof note === 'string' ? note.trim() : ''
  if (text === '') return { reason: 'note-missing', detail: null }
  const n = [...text].length
  if (n < rule.minChars) return { reason: 'note-short', detail: `${n}자 — 최소 ${rule.minChars}자` }
  return null
}

// ---------------------------------------------------------------------------
// 과반(majority) 문턱
// ---------------------------------------------------------------------------

/**
 * `threshold` 자리에 숫자 대신 적을 수 있는 값. **활성 투표권자의 과반**을 뜻한다.
 *
 *   문턱 = floor((작성자를 제외한 유효 투표권자 수) / 2) + 1
 *
 * 🔴 **분모에서 작성자를 뺀다.** 자기 표는 어차피 안 세는데(G1) 분모에 남겨 두면
 *    투표권자가 둘일 때 과반이 2 라서 **영원히 못 채운다** — 한 명은 작성자라
 *    셀 수 없기 때문이다. 명단이 둘인 팀에서는 첫날부터 막힌다.
 *
 * 🔴 승계로 들어온 사람은 **분모에 넣지 않는다.** 넣으면 "모자라서 부른 사람" 이
 *    자기가 넘어야 할 문턱을 같이 올린다. 승계는 문턱을 채우는 쪽만 돕는다.
 *
 * 고정 숫자 대신 이것을 쓰는 이유: 명단이 늘고 줄 때마다 숫자를 손으로 고치면
 * **고치는 것을 잊은 날** 문턱이 조용히 틀린 값이 된다.
 */
export const MAJORITY = 'majority'

/** 정책에 적을 수 있는 문턱 값인가. 1 이상의 정수이거나 `"majority"`. */
const isThresholdValue = (v) => v === MAJORITY || (isInt(v) && v >= 1)

/**
 * 계층 비교(개정 ≥ 기본 ≥ 규칙)에서의 크기.
 * `"majority"` 는 **가장 높은 값**으로 친다 — 명단이 커지면 실제로 어떤 고정
 * 숫자보다도 커질 수 있고, 계층 검사는 fail-closed 여야 하기 때문이다.
 */
const thresholdRank = (v) => (v === MAJORITY ? Infinity : v)

/**
 * 과반 문턱을 실제 숫자로 만든다.
 *
 * 🔴 세 번째 인자는 **기본값이 있다.** 두 인자로 부르던 기존 호출은 `"authors"` 로
 *    돌아가므로 판정이 바뀌지 않는다. 새 옵션을 넣는 것이 옛 저장소의 답을 바꾸면
 *    안 된다는 것이 이 변경의 첫 번째 불변식이다.
 *
 * @param {Array} voters 정책 명단. 승계로 들어온 사람은 넣지 않는다 (위 주석)
 * @param {string[]} authorEmails 소스 브랜치 커밋의 author email
 * @param {{selfVote?: string, tipAuthorEmail?: string|null}} [opts]
 *        `selfVote` 는 `selfVoteMode(policy)` 가 돌려준 값을 그대로 넣는다 —
 *        `countVotes` 와 **같은 값**이어야 분자와 분모가 어긋나지 않는다
 */
export function majorityThreshold(voters, authorEmails, { selfVote = DEFAULT_SELF_VOTE, tipAuthorEmail = null } = {}) {
  if (!Array.isArray(voters) || voters.length === 0) {
    throw new GovernanceError('정책에 투표권자가 없어 과반을 셀 수 없습니다.', { exit: EXIT.POLICY_BROKEN, code: 'voters-missing' })
  }
  if (!isSelfVoteValue(selfVote) || selfVote === undefined || selfVote === null) {
    // 부르는 쪽이 이상한 값을 줬다. 안전한 값으로 치환하면 분모가 조용히 틀린다.
    throw new GovernanceError(
      `\`self_vote\` 는 ${selfVoteList()} 중 하나여야 합니다: ${JSON.stringify(selfVote)}`,
      { code: 'self-vote-invalid' },
    )
  }
  if (selfVote !== 'off' && !authorsUsable(authorEmails)) {
    // 작성자를 모르면 분모를 정할 수 없다. 미달이 아니라 판정 불가다 (G5).
    throw new GovernanceError(
      '과반을 세려면 소스 브랜치 커밋의 author email 이 필요합니다. 작성자를 못 빼면 문턱이 틀립니다.',
      { code: 'authors-missing' },
    )
  }
  const authors = excludedAuthors(selfVote, authorEmails, tipAuthorEmail)
  const eligible = voters.filter((v) => !authors.has(fold(v?.email)))
  // 명단이 전부 작성자라도 **0 으로 내려가지 않는다.** 문턱 0 은 문턱이 아니라
  // 이 층이 없는 것이다. 그때는 승계로 들어온 남이 한 표를 줘야 통과한다.
  return Math.floor(eligible.length / 2) + 1
}

/** 이 정책이 어디에서든 `"majority"` 를 쓰는가. */
function usesMajority(policy) {
  if (policy?.default?.threshold === MAJORITY) return true
  if (policy?.amendment?.threshold === MAJORITY) return true
  return (policy?.rules ?? []).some((r) => r?.threshold === MAJORITY)
}

/** git 이 주는 커밋 해시. 축약형(7자)부터 전체(40자)까지 받는다. */
const SHA_RE = /^[0-9a-f]{7,40}$/

/**
 * 두 sha 가 같은 커밋을 가리키는가.
 *
 * 표 파일 이름에는 8자만 들어가고(`<voter>-<sha8>.json`) 파이프라인이 주는 값은
 * 40자 전체다. 그래서 접두사 비교를 허용하되 **8자 미만은 안 받는다** — 7자
 * 접두사는 큰 저장소에서 실제로 충돌한 적이 있고, 표가 엉뚱한 커밋에 붙는 것은
 * G3 가 막으려던 바로 그 일이다.
 */
export function shaMatches(a, b) {
  const x = fold(a)
  const y = fold(b)
  if (!SHA_RE.test(x) || !SHA_RE.test(y)) return false
  if (x === y) return true
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 8 && long.startsWith(short)
}

/** ISO 문자열이든 ms 숫자든 ms 로. 못 읽으면 **0 으로 치지 않고 던진다.** */
function toMs(v, what) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const t = Date.parse(String(v ?? ''))
  if (Number.isNaN(t)) {
    throw new GovernanceError(`시각을 읽을 수 없습니다 (${what}): ${JSON.stringify(v)}`)
  }
  return t
}

// ---------------------------------------------------------------------------
// 1. validatePolicy — 정책 자체가 성립하는가
// ---------------------------------------------------------------------------

/**
 * 정책 검사. 문제를 **하나 찾고 멈추지 않고 전부 모아서** 돌려준다.
 * 한 번에 하나씩 고치게 하면 사람이 네 번 왕복한다.
 *
 * @param {object} policy 타깃 브랜치에서 읽어온 정책 객체 (G2 는 게이트가 지킨다)
 * @param {{policyPath?: string}} [opts]
 * @returns {{ok: boolean, exit: number, problems: Array<{code:string,message:string,exit:number}>}}
 */
export function validatePolicy(policy, { policyPath = DEFAULT_POLICY_PATH } = {}) {
  const problems = []
  const add = (code, message, exit = EXIT.POLICY_BROKEN) => problems.push({ code, message, exit })
  const done = () => {
    // 🔴 "못 읽었다"(1) 가 "깨졌다"(4) 보다 근본적이다. 정책이 아예 없으면
    //    계층이 맞는지 따지는 것 자체가 무의미하므로 1 이 이긴다.
    const exit = problems.length === 0
      ? EXIT.OK
      : (problems.some((p) => p.exit === EXIT.UNDECIDABLE) ? EXIT.UNDECIDABLE : EXIT.POLICY_BROKEN)
    return { ok: problems.length === 0, exit, problems }
  }

  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    add('policy-missing', `정책이 객체가 아닙니다: ${JSON.stringify(policy)}`, EXIT.UNDECIDABLE)
    return done()
  }

  // ── 투표권자 ──────────────────────────────────────────────────────────
  //
  // 🔴 **명단은 없어도 된다.** 비어 있는 것은 "투표권자가 없다" 가 아니라
  //    **"저장소에 커밋한 사람이 곧 명단이다"** 라는 뜻이다 (`deriveVoters`).
  //    손으로 적는 명단은 이메일 한 글자만 틀려도 그 사람이 영영 표를 못 던지는데,
  //    틀렸다는 사실은 표가 모자랄 때까지 안 보인다. 적을 것이 없으면 틀릴 것도 없다.
  //
  //    적어 두는 길은 남긴다 — 저장소에 커밋하지 않는 사람에게 표를 주려면
  //    커밋 이력으로는 표현할 수 없기 때문이다.
  const voters = policy.voters
  let voterCount = null
  if (voters != null && !Array.isArray(voters)) {
    add('voters-malformed', `\`voters\` 가 배열이 아닙니다: ${JSON.stringify(voters)}`)
  } else if (Array.isArray(voters) && voters.length > 0) {
    voterCount = voters.length
    const seenId = new Map()
    const seenEmail = new Map()
    voters.forEach((v, i) => {
      if (!v || typeof v !== 'object' || !isStr(v.id) || !isStr(v.email)) {
        add('voter-malformed', `voters[${i}] 에 id 나 email 이 없습니다: ${JSON.stringify(v)}`)
        return
      }
      if (!v.email.includes('@')) {
        add('voter-email-malformed', `voters[${i}] 의 email 이 email 이 아닙니다: ${v.email}`)
      }
      const id = fold(v.id)
      const email = fold(v.email)
      // G4 · 한 사람은 한 표. 같은 사람이 두 줄로 들어가 있으면 두 표가 된다.
      // 대소문자만 다른 중복도 잡는다 — git 신원은 대소문자가 흔들린다.
      if (seenId.has(id)) add('voter-id-duplicate', `투표권자 id 가 중복입니다: ${v.id} (voters[${seenId.get(id)}] 과 voters[${i}])`)
      else seenId.set(id, i)
      if (seenEmail.has(email)) add('voter-email-duplicate', `투표권자 email 이 중복입니다: ${v.email} (voters[${seenEmail.get(email)}] 과 voters[${i}])`)
      else seenEmail.set(email, i)
    })
  }

  // ── 문턱 세 자리 ──────────────────────────────────────────────────────
  const readThreshold = (label, holder) => {
    if (!holder || typeof holder !== 'object') {
      add('threshold-missing', `\`${label}\` 이 없습니다.`)
      return null
    }
    const t = holder.threshold
    // `"majority"` 는 명단에서 계산되는 값이라 여기서 상한을 따질 것이 없다.
    if (t === MAJORITY) {
      // 🔴 분모가 없으면 과반은 셀 수 없다. 명단을 안 둔 저장소에서는 투표권자가
      //    커밋과 함께 늘어나므로, 같은 MR 이 어제와 오늘 다른 문턱을 갖는다.
      //    그건 문턱이 아니다.
      if (voterCount === null) {
        add('majority-without-roster', `\`${label}.threshold\` 가 "majority" 인데 \`voters\` 명단이 없습니다. 과반은 고정된 분모가 있어야 셉니다 — 숫자로 적거나 명단을 두세요.`)
        return null
      }
      return t
    }
    if (!isInt(t) || t < 1) {
      // 정족수 0 은 정족수가 아니라 **이 층이 없는 것**이다. 그렇게 하고 싶으면
      // CI 잡을 지우는 것이 정직하고, 그건 이력에 남는다. 조용히 0 으로 두면
      // 아무도 이 층이 꺼진 줄 모른 채 보호받고 있다고 믿는다.
      add('threshold-invalid', `\`${label}.threshold\` 는 1 이상의 정수이거나 "majority" 여야 합니다: ${JSON.stringify(t)}`)
      return null
    }
    if (voterCount !== null && t > voterCount) {
      // 채울 수 없는 문턱은 "아직 아니다" 가 아니라 "영원히 아니다" 다.
      add('threshold-over-voters', `\`${label}.threshold\` (${t}) 가 투표권자 수(${voterCount})보다 큽니다. 채울 수 없는 문턱입니다.`)
      return null
    }
    return t
  }

  const dflt = readThreshold('default', policy.default)
  const amendment = readThreshold('amendment', policy.amendment)

  // ── 파트별 규칙 ──────────────────────────────────────────────────────
  const rules = policy.rules ?? []
  const ruleThresholds = []
  if (!Array.isArray(rules)) {
    add('rules-malformed', '`rules` 는 배열이어야 합니다.')
  } else {
    rules.forEach((r, i) => {
      if (!r || typeof r !== 'object' || !Array.isArray(r.paths) || r.paths.length === 0) {
        add('rule-malformed', `rules[${i}] 에 paths 가 없습니다: ${JSON.stringify(r)}`)
        return
      }
      if (!r.paths.every(isStr)) {
        add('rule-path-malformed', `rules[${i}].paths 에 문자열이 아닌 항목이 있습니다: ${JSON.stringify(r.paths)}`)
      }
      const t = readThreshold(`rules[${i}]`, r)
      if (t !== null) ruleThresholds.push({ i, t })
    })
  }

  // ── amendment.paths 는 정책 파일 자신을 덮어야 한다 ────────────────────
  //
  // 안 덮으면 정책을 고치는 MR 이 **기본 문턱**으로 통과한다. threshold 를 1 로
  // 낮추는 변경이 1표로 지나가면 이 층은 그 순간 끝난다.
  const aPaths = policy.amendment?.paths
  if (!Array.isArray(aPaths) || aPaths.length === 0 || !aPaths.every(isStr)) {
    add('amendment-paths-missing', '`amendment.paths` 가 비어 있거나 문자열이 아닌 항목이 있습니다.')
  } else if (!coversPath(aPaths, policyPath)) {
    add(
      'amendment-not-self-covering',
      `\`amendment.paths\` 가 정책 파일 자신(${policyPath})을 덮지 않습니다: ${JSON.stringify(aPaths)}\n`
      + '  정책을 고치는 변경이 기본 문턱으로 통과하게 됩니다.',
    )
  }

  // ── 계층: amendment ≥ default ≥ rules ─────────────────────────────────
  //
  // default 가 어떤 규칙보다 낮으면 **새 폴더를 만드는 것이 기존 폴더를 고치는
  // 것보다 쉬워진다.** 규칙이 붙지 않은 새 경로는 기본값으로 판정되기 때문이다.
  if (amendment !== null && dflt !== null && thresholdRank(amendment) < thresholdRank(dflt)) {
    add('hierarchy-amendment', `\`amendment.threshold\` (${amendment}) 가 \`default.threshold\` (${dflt}) 보다 낮습니다.`)
  }
  if (dflt !== null) {
    for (const { i, t } of ruleThresholds) {
      if (thresholdRank(t) > thresholdRank(dflt)) {
        add('hierarchy-rule', `\`rules[${i}].threshold\` (${t}) 가 \`default.threshold\` (${dflt}) 보다 높습니다. 그러면 규칙 없는 새 경로가 더 싸집니다.`)
      }
    }
  }

  // ── 규칙이 개정 경로에 걸치면 거부한다 ─────────────────────────────────
  //
  // 판정은 최댓값을 쓰므로 실제로 뚫리지는 않는다. 그런데 정책을 읽는 사람은
  // "이 경로는 이 규칙의 문턱이다" 라고 믿는다. **거버넌스에서 믿음과 동작이
  // 어긋나면 그것이 곧 우회로다.** 순서에 기대지 않고 정책 단계에서 막는다.
  if (Array.isArray(aPaths) && Array.isArray(rules)) {
    rules.forEach((r, i) => {
      if (!r || !Array.isArray(r.paths)) return
      for (const rp of r.paths) {
        if (!isStr(rp)) continue
        for (const ap of aPaths) {
          if (!isStr(ap)) continue
          if (pathsOverlap(rp, ap)) {
            add('rule-overlaps-amendment', `rules[${i}].paths 의 ${rp} 가 개정 경로 ${ap} 와 겹칩니다. 개정 문턱이 이기므로 규칙이 거짓말을 하게 됩니다.`)
          }
        }
      }
    })
  }

  // ── 자기 표 배제 범위 (선택 필드) ─────────────────────────────────────
  //
  // 🔴 **판정 불가(1)로 올린다. 깨진 정책(4)이 아니다.**
  //    threshold 가 이상한 것은 "정책이 틀리게 적혀 있다" 지만, `self_vote` 가
  //    이상한 것은 **누구를 빼야 하는지 자체를 모른다** 는 뜻이다. 그 상태에서
  //    센 숫자는 미달인지 충족인지조차 알 수 없다 — G5(못 세면 통과가 아니다)가
  //    말하는 바로 그 자리다. 조용히 기본값으로 떨어뜨리는 것이 최악이다.
  if (!isSelfVoteValue(policy.self_vote)) {
    add(
      'self-vote-invalid',
      `\`self_vote\` 는 ${selfVoteList()} 중 하나여야 합니다 (안 적으면 "${DEFAULT_SELF_VOTE}"): ${JSON.stringify(policy.self_vote)}`,
      EXIT.UNDECIDABLE,
    )
  }

  // ── 표에 이유를 요구하는 규칙 (선택 필드) ──────────────────────────────
  //
  // 🔴 `self_vote` 와 **같은 자리·같은 등급**이다. 판정 불가(1)로 올리고 깨진
  //    정책(4)으로 올리지 않는 이유도 같다: 이 값이 이상하면 **어떤 표가 유효한지
  //    자체를 모른다.** 그 상태에서 센 숫자는 미달인지 충족인지조차 알 수 없다
  //    (G5 — 못 세면 통과가 아니다).
  for (const p of parseVoteNote(policy.vote_note).problems) {
    add(p.code, p.message, EXIT.UNDECIDABLE)
  }

  // ── 승계 설정 ────────────────────────────────────────────────────────
  const s = policy.succession
  if (s !== undefined && s !== null) {
    if (typeof s !== 'object' || Array.isArray(s)) {
      add('succession-malformed', '`succession` 은 객체여야 합니다.')
    } else {
      if (!isInt(s.window_days) || s.window_days < 1) {
        add('succession-window', `\`succession.window_days\` 는 1 이상의 정수여야 합니다: ${JSON.stringify(s.window_days)}`)
      }
      if (!isInt(s.top) || s.top < 0) {
        add('succession-top', `\`succession.top\` 은 0 이상의 정수여야 합니다: ${JSON.stringify(s.top)}`)
      }
    }
  }

  return done()
}

// ---------------------------------------------------------------------------
// 2. rulesFor — 이 변경에는 몇 표가 필요한가
// ---------------------------------------------------------------------------

/**
 * 경로 하나에 걸리는 문턱.
 *
 * 🔴 경로 매칭을 새로 만들지 않는다. `protocol.mjs` 의 `coversPath` 를 쓴다 —
 *    "규칙 경로가 이 파일을 덮는가" 는 pre-commit 이 "claim 이 이 파일을 덮는가"
 *    를 묻는 것과 **같은 질문**이다. 한 저장소에 경로 규칙이 둘이면 어느 쪽이
 *    맞는지 아무도 모르게 된다.
 */
function thresholdForPath(p, policy, majority) {
  const candidates = []
  const matched = []

  /**
   * `"majority"` 를 실제 숫자로 바꾼다. 여기서 바꾸는 이유: 최댓값 비교를 숫자와
   * 문자열이 섞인 채로 하면 규칙 하나가 문자열이라는 이유로 이기거나 지는,
   * 아무도 설명 못 할 판정이 나온다.
   */
  const resolve = (t) => (t === MAJORITY ? majority : t)

  const aPaths = policy.amendment?.paths ?? []
  const isAmendment = coversPath(aPaths, p)
  if (isAmendment) {
    candidates.push(resolve(policy.amendment.threshold))
    // 개정 경로에서는 기본값도 함께 센다. 검증을 안 거친 정책이 개정 문턱을
    // 기본값 아래로 적어 두더라도 기본값 밑으로는 안 내려가게 하기 위해서다.
    if (isThresholdValue(policy.default?.threshold)) candidates.push(resolve(policy.default.threshold))
  }

  for (const r of policy.rules ?? []) {
    if (!r || !Array.isArray(r.paths)) continue
    if (coversPath(r.paths, p)) {
      candidates.push(resolve(r.threshold))
      matched.push(r)
    }
  }

  // 아무것도 안 걸리면 기본값. 규칙이 걸리면 **걸린 것들의 최댓값**이다.
  // 최솟값이 아니라 최댓값인 이유가 fail-closed(**판단이 갈리면 안전한 쪽으로
  // 닫는다**) 다 — 규칙 둘이 겹칠 때
  // 싼 쪽을 고르면, 규칙을 하나 더 얹는 것이 문턱을 낮추는 수단이 된다.
  if (candidates.length === 0) candidates.push(resolve(policy.default?.threshold))

  const valid = candidates.filter(isInt)
  if (valid.length === 0) {
    throw new GovernanceError(
      `${p} 에 적용할 문턱을 찾지 못했습니다. 정책의 default.threshold 를 확인하세요.`,
      { exit: EXIT.POLICY_BROKEN, code: 'threshold-unresolved' },
    )
  }
  const threshold = Math.max(...valid)
  const source = isAmendment && threshold === resolve(policy.amendment.threshold)
    ? 'amendment'
    : (matched.length ? 'rules' : 'default')
  return { path: normalizePath(p), threshold, source, matched }
}

/**
 * 이 MR 에 필요한 찬성 수. 바뀐 경로 전부를 보고 **가장 높은 문턱**을 고른다.
 *
 * @param {string[]} paths 바뀐 파일 경로들 (`git diff --name-only`)
 * @param {object} policy
 * @param {{majority?: number|null}} [opts] `"majority"` 를 대신할 숫자.
 *   `judge` 가 `majorityThreshold()` 로 미리 계산해서 넣어 준다. 정책이
 *   `"majority"` 를 안 쓰면 필요 없다.
 * @returns {{threshold:number, source:string, top:object, perPath:object[], amendment:boolean}}
 */
export function rulesFor(paths, policy, { majority = null } = {}) {
  if (!policy || typeof policy !== 'object') {
    throw new GovernanceError('정책이 없어 문턱을 정할 수 없습니다.', { code: 'policy-missing' })
  }
  if (!Array.isArray(paths)) {
    throw new GovernanceError('바뀐 경로 목록이 배열이 아닙니다.', { code: 'changed-missing' })
  }
  if (paths.length === 0) {
    // 🔴 빈 diff 를 "아무 규칙도 안 걸림 → 기본값" 으로 처리하지 않는다.
    //    실무에서 목록이 비는 원인은 "안 바뀐 MR" 이 아니라 **게이트가 타깃
    //    브랜치를 못 찾아 diff 를 못 뜬 것**이다. 그건 판정 불가(1)지 미달(2)이
    //    아니다. 환경을 고치라고 말해야 사람이 고친다.
    throw new GovernanceError(
      '바뀐 경로가 하나도 없습니다. 게이트가 타깃 브랜치를 못 찾아 diff 를 못 떴을 수 있습니다.',
      { code: 'empty-diff' },
    )
  }

  if (usesMajority(policy) && !isInt(majority)) {
    // 과반을 쓰는 정책인데 분모를 못 받았다. 그럴듯한 숫자로 때우지 않는다 —
    // 문턱이 틀리면 그 판정은 아무것도 지키지 않는다 (G5).
    throw new GovernanceError(
      '정책이 "majority" 를 쓰는데 과반 인원을 받지 못했습니다. rulesFor(paths, policy, { majority }) 로 넘기세요.',
      { code: 'majority-unresolved' },
    )
  }
  const perPath = paths.map((p) => thresholdForPath(p, policy, majority))
  let top = perPath[0]
  for (const e of perPath) if (e.threshold > top.threshold) top = e
  return {
    threshold: top.threshold,
    source: top.source,
    amendment: perPath.some((e) => e.source === 'amendment'),
    // 과반으로 정해졌다는 사실은 출력에 드러나야 한다. 숫자만 보면 왜 2 표인지
    // 아무도 모르고, 명단이 바뀌면 그 숫자가 조용히 달라진다.
    majority: usesMajority(policy) ? majority : null,
    top,
    perPath,
  }
}

// ---------------------------------------------------------------------------
// 3. deriveVoters — 승계
// ---------------------------------------------------------------------------

/**
 * 유효 투표권자를 정한다. 길이 둘이다.
 *
 * 🔴 **명단(`policy.voters`)이 비어 있으면 저장소에 커밋한 사람이 곧 명단이다.**
 *    최근 `window_days` 안에 커밋한 사람 **전원**이 투표권자가 된다. 상위 몇 명으로
 *    자르지 않는다 — 자르는 것은 승계(빈자리를 임시로 메우는 것)의 일이고, 여기서는
 *    그 사람들이 명단 자체이기 때문이다.
 *
 * 명단이 있으면: 살아 있는 사람이 필요 표보다 적을 때 **승계**가 돈다.
 * 승계 = 최근 `window_days` 안에 커밋한 author 상위 `top` 명이 임시 투표권을 갖는 것.
 *
 * 🔴 **승계가 발동한 사실은 반드시 출력에 드러난다** (`formatVerdict` 가 찍는다).
 *    조용히 발동하는 승계는 승계가 아니라 우회로다. 그래서 이 함수는 `triggered`
 *    를 결과에 넣고, 포맷터에는 그 줄을 빼는 길을 두지 않았다.
 *
 * 🔴 정책에 적힌 사람은 **살아 있지 않아도 투표권을 잃지 않는다.** 생사는 승계를
 *    켤지만 정한다. 두 달 자리를 비운 사람이 돌아와 던진 표가 안 세지면, 그건
 *    fail-closed 가 아니라 그냥 틀린 판정이다.
 *
 * 자기 표 배제(G1)는 여기서 하지 않는다 — `countVotes` 한 곳에만 둔다.
 * 규칙이 두 군데 있으면 한 쪽만 고쳐지는 날이 온다.
 *
 * @param {object}   args.policy
 * @param {Array|null} args.contributors 커밋 하나가 항목 하나: `{email, name?, at}`.
 *   승계가 필요한데 `null` 이면 판정 불가(1) 다 — 모르면서 넘기지 않는다.
 * @param {number|string} args.now
 * @param {number|null} [args.threshold] 이번 MR 의 필요 표. 없으면 `default.threshold`
 */
export function deriveVoters({ policy, contributors, now, threshold = null }) {
  const base = Array.isArray(policy?.voters) ? policy.voters : []
  const need = threshold ?? policy?.default?.threshold
  if (!isInt(need) || need < 1) {
    throw new GovernanceError(`필요 표를 정할 수 없습니다: ${JSON.stringify(need)}`, { exit: EXIT.POLICY_BROKEN, code: 'threshold-unresolved' })
  }

  const cfg = policy.succession ?? DEFAULT_SUCCESSION
  const windowDays = isInt(cfg.window_days) ? cfg.window_days : DEFAULT_SUCCESSION.window_days
  const topN = isInt(cfg.top) ? cfg.top : DEFAULT_SUCCESSION.top
  const nowMs = toMs(now, 'now')
  const since = nowMs - windowDays * 86400000

  /** 창 안에 커밋이 있는 사람. `contributors` 를 못 받았으면 판단을 미룬다. */
  const recent = new Map() // fold(email) -> {email, name, commits, lastAt}
  if (Array.isArray(contributors)) {
    for (const c of contributors) {
      if (!c || !isStr(c.email)) {
        throw new GovernanceError(`기여 이력 항목에 email 이 없습니다: ${JSON.stringify(c)}`, { code: 'contributor-malformed' })
      }
      const at = toMs(c.at, 'contributors[].at')
      if (at < since || at > nowMs) continue
      const k = fold(c.email)
      const hit = recent.get(k) ?? { email: c.email, name: c.name ?? null, commits: 0, lastAt: 0 }
      hit.commits += 1
      if (at > hit.lastAt) hit.lastAt = at
      if (!hit.name && c.name) hit.name = c.name
      recent.set(k, hit)
    }
  }

  /**
   * 커밋 수 → 최근순 → email 순. 마지막 두 단계는 **결과를 결정론적으로** 만들기
   * 위한 것이다. 같은 입력에 다른 답이 나오는 거버넌스는 못 쓴다.
   */
  const byActivity = (a, b) =>
    (b.commits - a.commits) || (b.lastAt - a.lastAt) || (fold(a.email) < fold(b.email) ? -1 : 1)

  // 🔴 명단이 없으면 **저장소에 커밋한 사람이 곧 명단이다.**
  //    승계는 돌지 않는다 — 메울 빈자리가 없다. 여기 들어오는 사람은 전부 창 안에
  //    커밋이 있으므로 `alive` 와 같은 목록이다.
  if (base.length === 0) {
    if (!Array.isArray(contributors)) {
      // 이력을 못 받은 것을 "커밋한 사람이 없다" 로 읽으면 살아 있는 저장소가
      // 죽은 것으로 보인다. 못 세면 통과가 아니다 (G5).
      throw new GovernanceError(
        '명단이 없어 기여 이력으로 투표권자를 정해야 하는데 이력을 받지 못했습니다 (contributors=null).',
        { code: 'contributors-missing' },
      )
    }
    const derived = [...recent.values()]
      .sort(byActivity)
      .map((c) => ({ id: c.name ?? c.email, email: c.email, via: 'contributors', commits: c.commits }))
    return {
      voters: derived,
      base: [],
      alive: derived,
      succeeded: [],
      triggered: false,
      derived: true,
      need,
      short: Math.max(0, need - derived.length),
      // `top` 은 null 이다 — 여기서는 자르지 않았다. 숫자를 넣어 두면 읽는 쪽이
      // "상위 몇 명만 들어왔다" 고 잘못 읽는다.
      window: { days: windowDays, since: new Date(since).toISOString(), top: null },
    }
  }

  const roster = base.map((v) => ({ id: v.id, email: v.email, via: 'policy' }))
  const byEmail = new Set(roster.map((v) => fold(v.email)))

  const alive = roster.filter((v) => recent.has(fold(v.email)))
  const triggered = alive.length < need

  let succeeded = []
  if (triggered) {
    if (!Array.isArray(contributors)) {
      // 승계를 따져야 하는데 이력이 없다. 넘겨받지 못한 것을 "이력이 없다" 로
      // 읽으면(= bus.mjs 의 `catch { return [] }`) 살아 있는 저장소가 죽은 것으로
      // 보인다. 못 세면 통과가 아니다(G5) — 그리고 이건 미달이 아니라 판정 불가다.
      throw new GovernanceError(
        '승계를 판정해야 하는데 최근 기여 이력을 받지 못했습니다 (contributors=null).',
        { code: 'contributors-missing' },
      )
    }
    succeeded = [...recent.values()]
      .filter((c) => !byEmail.has(fold(c.email)))
      .sort(byActivity)
      .slice(0, topN)
      .map((c) => ({ id: c.name ?? c.email, email: c.email, via: 'succession', commits: c.commits }))
  }

  const voters = [...roster, ...succeeded]
  const reachable = alive.length + succeeded.length
  return {
    voters,
    base: roster,
    alive,
    succeeded,
    triggered,
    derived: false,
    need,
    // 승계로도 못 채운 몫. 0 이 아니면 이 저장소는 **막혀 있다.**
    // 탈출구를 만들지 않는다 — 오픈소스에서 그 상태의 정답은 fork 다.
    short: Math.max(0, need - reachable),
    window: { days: windowDays, since: new Date(since).toISOString(), top: topN },
  }
}

// ---------------------------------------------------------------------------
// 4. countVotes — 유효 찬성 수와 무효 사유
// ---------------------------------------------------------------------------

/**
 * 무효 사유 → 사람이 읽는 한 줄.
 *
 * committer — **그 커밋을 실제로 기록한 git 신원.** 표에 적힌 email 과 대조하는 값이라
 * 표를 쓰는 사람이 채우면 대조가 아니라 자기 신고가 된다. 그래서 게이트가 채운다.
 */
export const REASONS = {
  'wrong-branch': '다른 브랜치의 표',
  'stale-sha': '헤드가 바뀐 뒤라 효력 없음 (G3)',
  'not-a-voter': '투표권자가 아님',
  'identity-mismatch': '표의 이름과 email 이 명단과 어긋남',
  'committer-unknown': '표를 만든 커밋의 committer 를 확인 못 함',
  'committer-mismatch': '표의 email 과 커밋 committer 가 다름 (위조 의심)',
  'self-vote': '자기 표 (G1)',
  'future-dated': '미래 시각으로 적힌 표',
  duplicate: '같은 사람의 두 번째 표 (G4)',
  // 🔴 정책이 `vote_note` 를 켰을 때만 난다. 안 켰으면 이 사유는 존재하지 않는다.
  'note-missing': '이유(note)를 안 적은 표 — 정책이 이유를 요구한다',
  'note-short': '이유(note)가 정책의 최소 길이보다 짧음',
}

/** 시계가 조금 어긋난 것까지 위조로 몰지 않는다. 하루면 충분히 넉넉하다. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000

/**
 * 표를 센다.
 *
 * @param {object}   args.policy      `voters` 를 따로 안 넘길 때의 명단 출처
 * @param {Array}    args.votes       표 레코드들. **파일 하나 = 표 하나**
 * @param {string[]} args.authorEmails 소스 브랜치 커밋들의 author email (G1 용)
 * @param {string}   args.sha         머지 대상 커밋
 * @param {number|string} args.now
 * @param {Array|null} [args.voters]  `deriveVoters` 결과. 없으면 `policy.voters`
 * @param {string|null} [args.branch] 소스 브랜치 이름. 주면 표의 branch 와 대조한다
 * @param {string|null} [args.tipAuthorEmail] 맨 위 커밋의 author email.
 *        `self_vote: "tip"` 일 때만 쓰이고, 그때는 **없으면 판정 불가**다
 * @param {number|null} [args.threshold] 이번 판정의 정족수. **주면** 자기 표 배제가
 *        판정을 불가능하게 만드는지 볼 수 있다 (아래 waiver). 안 주면 해제는
 *        영영 안 걸린다 — 모르면 안 푸는 쪽이 fail-closed 다. `judge` 가 넣어 준다
 * @returns {{approvals:number, counted:Array, rejections:Array, invalid:Array,
 *            g1Waived:boolean, eligibleCount:number, threshold:number|null, selfVoted:Array}}
 */
export function countVotes({
  policy, votes, authorEmails, sha, now, voters = null, branch = null, tipAuthorEmail = null, threshold = null,
}) {
  const roster = voters ?? policy?.voters ?? null
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new GovernanceError('투표권자 명단이 없습니다.', { exit: EXIT.POLICY_BROKEN, code: 'voters-missing' })
  }
  if (!Array.isArray(votes)) {
    // 🔴 `tools/bus.mjs` 의 모양(파일 하나 = 레코드 하나)만 가져오고 그 파일의
    //    `catch { return [] }` 는 가져오지 않는다. 쪽지에서는 못 읽은 것과 없는
    //    것을 같게 둬도 되지만, 표에서 그건 fail-open(**애매하면 통과시킨다**) 이다
    //    — 표가 통째로 사라진
    //    MR 이 "0표" 로 보이고, 그 자리에 깨진 표가 통과할 틈이 생긴다.
    throw new GovernanceError('표 목록을 받지 못했습니다 (votes 가 배열이 아님).', { code: 'votes-missing' })
  }
  if (!SHA_RE.test(fold(sha))) {
    throw new GovernanceError(`머지 대상 커밋(sha)을 읽을 수 없습니다: ${JSON.stringify(sha)}`, { code: 'sha-missing' })
  }
  // 🔴 배제 범위는 **정책에서 읽는다.** `majorityThreshold` 에는 `judge` 가 같은
  //    `selfVoteMode(policy)` 결과를 넘긴다 — 분자와 분모가 같은 값을 보게 하는
  //    자리가 여기 하나뿐이어야 한다.
  const selfVote = selfVoteMode(policy)
  // 🔴 이유 규칙도 **정책에서** 읽는다. 없으면 `null` 이고 아무 표도 이 사유로
  //    떨어지지 않는다 — 이 필드가 없던 저장소의 판정은 그대로다.
  const noteRule = voteNoteRule(policy)
  if (selfVote !== 'off' && !authorsUsable(authorEmails)) {
    // 자기 표를 못 거르면(G1) 셀 자격이 없다. 미달이 아니라 판정 불가다.
    throw new GovernanceError(
      '소스 브랜치 커밋의 author email 을 받지 못했습니다. 자기 표를 걸러낼 수 없으면 세지 않습니다 (G1).',
      { code: 'authors-missing' },
    )
  }

  const nowMs = toMs(now, 'now')
  const authors = excludedAuthors(selfVote, authorEmails, tipAuthorEmail)
  const byEmail = new Map(roster.map((v) => [fold(v.email), v]))

  // ── G1 해제(waiver) — 자기 표 배제가 **판정 자체를 불가능하게 만들 때만** ────
  //
  // 🔴 왜 필요한가 — 실측. 오래 쌓는 `<파트>/dev` 브랜치에서는 시간이 갈수록
  //    커밋한 사람이 늘어 "던질 수 있는 사람" 이 0 으로 수렴한다. 팀 저장소의
  //    `front/main` 은 투표권자 4명이 **전원 저자**였고(정족수 2), `back/dev` 는
  //    명단 6명 전원이 저자였다. 이건 "아직 표가 모자라다"(미달, exit 2)가 아니라
  //    **표를 더 모아도 영원히 안 풀리는 교착**이다. 재시도가 답이 아닌 상태에
  //    미달 코드를 내는 것은 부르는 쪽에게 거짓말을 하는 것이다.
  //
  // 🔴 해제 조건을 좁게 잡는다. 셋을 **모두** 만족해야 한다.
  //      1. 이번 판정의 정족수를 숫자로 알고 있다 (`threshold` 를 받았다)
  //      2. G1 이 실제로 명단에서 누군가를 뺐다 (`excludedFromRoster > 0`)
  //      3. 그러고 남은 사람이 정족수보다 적다 (`eligibleCount < threshold`)
  //    2번이 없으면 "명단 자체가 정족수보다 작다"(승계로도 못 채운 막힌 저장소)
  //    까지 이 문으로 새어 나온다. 그건 G1 이 만든 교착이 아니므로 G1 을 풀어도
  //    아무도 못 던진다 — 판정문에 거짓 사유만 한 줄 남는다.
  //
  // 🔴 **정족수 숫자는 건드리지 않는다.** 문턱을 낮추면 "두 사람이 본다" 는 팀의
  //    뜻이 조용히 사라진다. 여기서 바꾸는 것은 **누가 던질 수 있는가** 하나다.
  //
  // 🔴 fail-closed 는 그대로다. 저자 목록을 못 받으면 위에서 이미 던졌다
  //    (`authors-missing`). "저자를 모를 때" 는 해제 조건이 **아니다** —
  //    모르는 것과 셀 수 없는 것을 통과로 바꾸면 이 층이 없는 것과 같다.
  const eligible = roster.filter((v) => !authors.has(fold(v?.email)))
  const eligibleCount = eligible.length
  const excludedFromRoster = roster.length - eligibleCount
  const need = isInt(threshold) && threshold >= 1 ? threshold : null
  const g1Waived = need !== null && excludedFromRoster > 0 && eligibleCount < need

  const counted = []
  const rejections = []
  const invalid = []
  // 해제 덕분에 세어진 표. **판정문에 이름까지 남긴다** — 해제가 조용히 발동하면
  // 그건 예외가 아니라 우회로다 (승계를 출력에 찍는 것과 같은 이유).
  const selfVoted = []
  const seen = new Map() // fold(email) -> 이미 센 표

  for (const raw of votes) {
    const v = readVote(raw) // 깨진 레코드는 여기서 던진다 (exit 1)
    const email = fold(v.email)
    const bad = (reason, detail = null) => invalid.push({ voter: v.voter, email: v.email, vote: v.vote, reason, detail })

    if (branch && fold(v.branch) !== fold(branch)) { bad('wrong-branch', v.branch); continue }
    // G3 · 표는 커밋에 묶인다. 만료된 claim 과 같은 취급이다 — 레코드는 남고
    //      효력만 잃는다. 그래서 지우지 않고 무효 목록에 **보여준다.**
    if (!shaMatches(v.sha, sha)) { bad('stale-sha', v.sha); continue }

    const voter = byEmail.get(email)
    if (!voter) { bad('not-a-voter'); continue }
    // 정책에 적힌 사람은 id 까지 맞아야 한다. 커밋 이력에서 나온 사람(승계·명단
    // 없음)은 정책에 id 가 없으므로 — 이름을 저장소가 정해 준 적이 없다 —
    // email 만 본다. git 의 표시 이름은 사람마다 PC 마다 흔들린다.
    if (voter.via !== 'succession' && voter.via !== 'contributors' && fold(voter.id) !== fold(v.voter)) {
      bad('identity-mismatch', `명단은 ${voter.id}`); continue
    }

    if (!isStr(v.committerEmail)) { bad('committer-unknown'); continue }
    if (fold(v.committerEmail) !== email) { bad('committer-mismatch', v.committerEmail); continue }

    // G1 · 자기 표는 안 센다. 단 해제된 판정에서는 센다 (위 waiver 주석).
    if (authors.has(email) && !g1Waived) { bad('self-vote'); continue }
    if (toMs(v.at, 'votes[].at') > nowMs + FUTURE_TOLERANCE_MS) { bad('future-dated', v.at); continue }
    // 🔴 이유 없는 표는 **찬성이든 반대든** 안 센다. 반대야말로 이유가 필요하다 —
    //    이유 없는 반대는 판정문에 "누군가 막고 있다" 만 남기고 무엇을 고쳐야
    //    하는지는 안 남긴다. 그리고 duplicate(G4)보다 **먼저** 본다: 이유 없는
    //    첫 표가 `seen` 을 차지하면, 뒤에 온 제대로 된 표가 중복으로 떨어진다.
    const noteBad = voteNoteProblem({ note: v.note, at: v.at, rule: noteRule })
    if (noteBad) { bad(noteBad.reason, noteBad.detail); continue }
    if (seen.has(email)) { bad('duplicate', `이미 센 표: ${seen.get(email).voter}`); continue } // G4

    seen.set(email, v)
    // 해제가 없었으면 여기 못 왔을 표. 판정문이 이름을 찍는다.
    if (g1Waived && authors.has(email)) selfVoted.push({ voter: v.voter, email: v.email, vote: v.vote })
    if (v.vote === 'approve') counted.push(v)
    // 반대는 정족수 계산에 들어가지 않는다. 이 층이 답하는 질문은 "찬성이 몇인가"
    // 하나뿐이고, 거부권은 다른 제도다 — 만들려면 SPEC 부터 고쳐야 한다.
    else rejections.push(v)
  }

  return {
    approvals: counted.length,
    counted,
    rejections,
    invalid,
    // ── 기계가 읽는 해제 표식 ────────────────────────────────────────────
    // `gate.mjs --json` 이 이 셋을 그대로 내보낸다. 판정문의 한 줄이 지워져도
    // 이 표식은 남는다 — 나중에 "이 판정이 예외였나" 를 사람이 아니라 코드가
    // 물어볼 수 있어야 한다.
    g1Waived,
    eligibleCount,
    threshold: need,
    selfVoted,
    // ── 🔴 G1 이 배제하는 email 들 (2026-09-12) ──────────────────────────
    //
    // 쓰는 쪽(`governance/vote.mjs`)이 *"내 표가 세어지나"* 를 **여기에 물어볼 수
    // 있게** 한다. 그러지 않으면 쓰는 쪽이 같은 규칙을 자기가 계산해야 하고,
    // 그 어긋남이 실제로 **두 번** 났다 — 2026-09-07 의 G1 해제, 2026-09-12 의
    // `self_vote` 모드. 판정자는 하나여야 한다.
    //
    // 🔴 **명단으로 거르지 않는다.** 여기 담기는 것은 `excludedAuthors` 가 낸
    //    집합 그대로다. 명단으로 좁히면 명단 밖 사람에게는 경고가 안 가고, 그
    //    사람은 **아무도 안 세는 표를 던져 놓고 기다리게 된다** — 이 저장소가
    //    자기 표를 조용히 쌓지 않기로 한 이유가 그것이다.
    //    (명단에 있나 없나는 `warnIfNotAVoter` 가 따로, 막지 않고 알린다.)
    //
    // 🔴 **해제(`g1Waived`)가 걸려도 비우지 않는다.** 이 칸은 *"이 판정에서
    //    누가 자기 표인가"* 이고, 해제는 *"그 자기 표를 그래도 세는가"* 다.
    //    둘은 다른 사실이라 따로 내야 한다 — 합쳐서 비워 버리면 읽는 쪽이
    //    "자기 표가 아니다" 와 "자기 표인데 해제됐다" 를 **구별할 수 없고**,
    //    그러면 해제로 통과한 사람에게 *왜* 그냥 써 줬는지 말해 줄 수 없다.
    //    (읽는 쪽은 이 칸과 `g1Waived` 를 같이 본다.)
    selfVoteEmails: [...authors],
    // 어느 규칙으로 위 집합을 만들었는가. 막힌 사람에게 **왜** 막혔는지 말해 주려면
    // 읽는 쪽이 이 값을 알아야 한다 — 모르면 "자기 표라서" 까지밖에 못 말한다.
    selfVoteMode: selfVote,
  }
}

/**
 * 표 레코드 한 장을 읽는다. **못 읽으면 건너뛰지 않고 전체를 중단한다.**
 * `CLAUDE.md` 의 fail-closed 규칙 그대로다 — 건너뛰면 깨진 표가 "없는 표" 가 되고,
 * 없는 표는 아무 경고도 만들지 않는다.
 */
function readVote(raw) {
  const where = () => JSON.stringify(raw)?.slice(0, 200)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GovernanceError(`표 레코드가 객체가 아닙니다: ${where()}`, { code: 'vote-malformed' })
  }
  for (const k of ['voter', 'email', 'sha', 'vote', 'at']) {
    if (!isStr(raw[k])) throw new GovernanceError(`표에 \`${k}\` 가 없습니다: ${where()}`, { code: 'vote-malformed' })
  }
  if (!raw.email.includes('@')) {
    throw new GovernanceError(`표의 email 이 email 이 아닙니다: ${raw.email}`, { code: 'vote-malformed' })
  }
  if (!SHA_RE.test(fold(raw.sha))) {
    throw new GovernanceError(`표의 sha 를 읽을 수 없습니다: ${raw.sha}`, { code: 'vote-malformed' })
  }
  if (raw.vote !== 'approve' && raw.vote !== 'reject') {
    throw new GovernanceError(`표의 vote 는 approve 나 reject 여야 합니다: ${JSON.stringify(raw.vote)}`, { code: 'vote-malformed' })
  }
  toMs(raw.at, 'votes[].at') // 못 읽으면 여기서 던진다
  if (raw.branch !== undefined && !isStr(raw.branch)) {
    throw new GovernanceError(`표의 branch 가 문자열이 아닙니다: ${JSON.stringify(raw.branch)}`, { code: 'vote-malformed' })
  }
  // 🔴 `note` 는 **비어 있어도 여기서 던지지 않는다.** 빈 이유는 "표가 깨졌다"
  //    (판정 전체 중단)가 아니라 "이 표는 안 센다"(무효표 한 장)여야 한다.
  //    여기서 던지면 이유를 안 적은 표 한 장이 MR 전체를 판정 불가로 만든다.
  //    문자열이 **아닌 것**만 깨진 것으로 친다 — 그건 손으로 쓴 오류다.
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== 'string') {
    throw new GovernanceError(`표의 note 가 문자열이 아닙니다: ${JSON.stringify(raw.note)}`, { code: 'vote-malformed' })
  }
  // `agent` 는 검사하지 않는다. 판정에 안 쓰이고, 모양이 늘어날 자리이기 때문이다
  // — 여기서 모양을 고정하면 필드가 하나 늘 때마다 옛 게이트가 표를 깨진 것으로 본다.
  return raw
}

// ---------------------------------------------------------------------------
// 5. judge — 위의 넷을 묶어 종료 코드까지
// ---------------------------------------------------------------------------

/**
 * 판정 전체. 게이트는 git 으로 재료를 모아 이 함수를 한 번 부르고, 결과의
 * `exit` 를 그대로 종료 코드로 쓴다.
 *
 * 🔴 종료 코드를 여기(순수 로직)에 둔 이유: 이 층의 계약이 곧 종료 코드이고,
 *    계약은 테스트할 수 있는 자리에 있어야 한다. 게이트가 메시지를 보고 코드를
 *    고르면 문구를 다듬는 커밋이 판정을 바꾼다.
 */
export function judge({
  policy, changed, votes, authorEmails, sha, contributors = null, now, branch = null, policyPath = DEFAULT_POLICY_PATH,
  tipAuthorEmail = null,
}) {
  const v = validatePolicy(policy, { policyPath })
  if (!v.ok) {
    return { exit: v.exit, ok: false, stage: 'policy', problems: v.problems }
  }
  try {
    // 🔴 배제 범위를 **여기서 한 번** 읽어 분모 쪽에 넘긴다. 분자 쪽(`countVotes`)은
    //    같은 `policy` 로 같은 함수를 다시 부르므로 두 값은 갈라질 수 없다.
    //    갈라지면 "필요한 표" 와 "센 표" 의 분모가 어긋나 판정만 조용히 틀린다.
    const selfVote = selfVoteMode(policy)
    // 🔴 과반은 **정책 명단에서 작성자를 뺀 수**로 센다. 승계로 들어온 사람은
    //    분모에 안 들어간다 — 모자라서 부른 사람이 문턱을 같이 올리면 안 된다.
    //    그래서 이 계산이 `deriveVoters` 보다 먼저 온다.
    const majority = usesMajority(policy)
      ? majorityThreshold(policy.voters, authorEmails, { selfVote, tipAuthorEmail })
      : null
    const need = rulesFor(changed, policy, { majority })
    const roster = deriveVoters({ policy, contributors, now, threshold: need.threshold })
    // 🔴 정족수를 **분자 쪽에도** 넘긴다. `countVotes` 는 이 숫자가 있어야
    //    "자기 표를 빼고 나면 던질 수 있는 사람이 정족수보다 적은가" 를 볼 수
    //    있다. 문턱은 여기서 정해지므로(`rulesFor`) 그 값을 그대로 준다 —
    //    분자가 다른 문턱을 보고 해제를 판단하면 판정만 조용히 틀린다.
    const tally = countVotes({
      policy, votes, authorEmails, sha, now, voters: roster.voters, branch, tipAuthorEmail,
      threshold: need.threshold,
    })
    const ok = tally.approvals >= need.threshold
    return {
      exit: ok ? EXIT.OK : EXIT.SHORT,
      ok,
      stage: 'count',
      threshold: need.threshold,
      approvals: tally.approvals,
      need,
      roster,
      tally,
      sha,
      branch,
    }
  } catch (e) {
    // GovernanceError 만 결과로 바꾼다. 그 밖의 예외는 우리 버그이므로 삼키지
    // 않는다 — 삼키면 "판정 불가" 로 위장한 버그가 영원히 안 고쳐진다.
    if (!(e instanceof GovernanceError)) throw e
    return { exit: e.exit, ok: false, stage: 'undecidable', problems: [{ code: e.code, message: e.message, exit: e.exit }] }
  }
}

/**
 * 사람과 에이전트가 함께 읽는 출력.
 *
 * 메시지 생성을 순수 로직에 두는 것은 이 저장소의 관례다 (`protocol.mjs` 의
 * `formatBlocks`). 덕분에 **"승계 발동 사실이 출력에 드러나는가" 를 테스트로
 * 고정할 수 있다** — 그 줄을 지우면 테스트가 빨개진다.
 */
export function formatVerdict(verdict) {
  const L = []
  if (verdict.stage === 'policy' || verdict.stage === 'undecidable') {
    L.push(verdict.stage === 'policy'
      ? '합의 판정 실패 — 정책 자체가 성립하지 않습니다.'
      : '합의 판정 불가 — 셀 수 없었습니다. 못 세면 통과가 아닙니다 (G5).')
    L.push('')
    for (const p of verdict.problems) L.push(`  x [${p.code}] ${p.message}`)
    L.push('')
    L.push(verdict.exit === EXIT.POLICY_BROKEN
      ? '정책을 고치는 MR 은 개정 문턱을 지납니다. 그것부터 여세요.'
      : '환경 문제입니다. 위 메시지를 고치고 다시 도세요. 투표로는 풀리지 않습니다.')
    return L.join('\n')
  }

  const { threshold, approvals, need, roster, tally } = verdict
  L.push(verdict.ok
    ? `합의 충족 — 유효 찬성 ${approvals} / 필요 ${threshold}`
    : `합의 미달 — 유효 찬성 ${approvals} / 필요 ${threshold}`)
  L.push(`  대상 커밋 : ${verdict.sha}${verdict.branch ? ` (${verdict.branch})` : ''}`)
  L.push(`  문턱 근거 : ${need.top.path} → ${labelSource(need.source)} ${threshold}표`)
  // 🔴 과반이면 그 사실과 분모를 반드시 적는다. 숫자만 보이면 왜 이 문턱인지
  //    아무도 모르고, 명단이 하나 늘어난 날 그 숫자가 조용히 달라진다.
  if (isInt(need.majority)) {
    L.push(`             과반 — 정책 명단에서 이 MR 의 작성자를 뺀 인원 기준 ${need.majority}표`)
  }
  L.push('')

  // 🔴 자기 표 배제 해제는 **조용히 발동하지 않는다.** 이 줄을 지우면 해제가
  //    예외가 아니라 우회로가 된다 — 승계 줄을 지울 수 없는 것과 같은 이유다.
  //    나중에 이력을 보는 사람이 "이 판정은 예외였다" 를 여기서 알아야 한다.
  if (tally?.g1Waived) {
    L.push(`  🔴 G1(자기 표 배제)이 해제된 판정입니다 — 유효 투표권자 ${tally.eligibleCount}명 < 정족수 ${threshold}. 저자 본인의 표를 셌습니다.`)
    L.push('     오래 쌓인 브랜치는 투표권자가 전부 저자가 되어 던질 수 있는 사람이 0 이 됩니다.')
    L.push('     그건 표가 모자란 것이 아니라 표를 더 모아도 안 풀리는 교착이라, 이 판정에 한해서만 풉니다.')
    L.push('     🔴 정족수 숫자는 그대로입니다. G3(표는 커밋에 묶인다)·G4(같은 사람의 두 번째 표)·')
    L.push('        브랜치 대조·committer(표를 기록한 git 신원) 대조도 전부 그대로 돕니다.')
    if (tally.selfVoted?.length) {
      L.push('     해제 덕분에 센 표')
      for (const s of tally.selfVoted) L.push(`       ! ${s.voter} <${s.email}>  ${s.vote}`)
    }
    L.push('')
  }

  if (tally.counted.length) {
    L.push('  센 표')
    for (const c of tally.counted) L.push(`    o ${c.voter} <${c.email}>  ${c.at}`)
  }
  if (tally.rejections.length) {
    L.push('  반대 (정족수 계산에는 들어가지 않습니다 — 사람이 읽으라고 적습니다)')
    for (const c of tally.rejections) L.push(`    - ${c.voter} <${c.email}>  ${c.at}`)
  }
  if (tally.invalid.length) {
    L.push('  안 센 표')
    for (const b of tally.invalid) {
      L.push(`    x ${b.voter} <${b.email}> — ${REASONS[b.reason] ?? b.reason}${b.detail ? ` (${b.detail})` : ''}`)
    }
  }
  if (tally.counted.length || tally.rejections.length || tally.invalid.length) L.push('')

  // 🔴 명단 없이 정해진 투표권자도 조용히 지나가지 않는다. **누가 표를 던질 수
  //    있는가는 판정의 절반**이고, 그것이 커밋 이력에서 나왔다면 더 그렇다.
  if (roster.derived) {
    L.push(`  명단 없음 — 최근 ${roster.window.days}일 안에 커밋한 ${roster.voters.length}명이 투표권자입니다.`)
    for (const c of roster.voters) L.push(`     · ${c.id} <${c.email}>  커밋 ${c.commits}`)
  }

  // 🔴 승계는 조용히 발동하지 않는다. 이 줄을 지우면 승계가 우회로가 된다.
  if (roster.triggered) {
    L.push(`  ⚠ 승계 발동 — 살아 있는 투표권자 ${roster.alive.length}명 < 필요 ${roster.need}명`)
    L.push(`     최근 ${roster.window.days}일(${roster.window.since} 이후) 기여자 상위 ${roster.window.top}명에게 임시 투표권을 줍니다.`)
    if (roster.succeeded.length) {
      for (const s of roster.succeeded) L.push(`     + ${s.id} <${s.email}>  커밋 ${s.commits}`)
    } else {
      L.push('     그런데 창 안에 기여자가 없습니다.')
    }
    // 해제된 판정에서는 이 줄이 거짓이 된다. 틀린 안내는 안 하는 것만 못하다.
    L.push(tally?.g1Waived
      ? '     이 판정은 자기 표 배제가 해제되어 있어 승계로 들어온 사람의 자기 표도 셉니다 (위 🔴).'
      : '     승계로 들어온 사람도 자기 표는 세지 않습니다 (G1).')
    L.push('')
  }
  if (roster.short > 0) {
    L.push(`  🔴 승계로도 ${roster.short}표가 모자랍니다. 이 저장소는 막혀 있습니다.`)
    L.push('     탈출구를 두지 않았습니다 — 이 상태의 정답은 fork 입니다.')
    L.push('')
  }

  L.push(verdict.ok
    ? '통과. 이 판정은 표 파일에만 근거합니다 (GitLab Approve 는 세지 않습니다).'
    : `아직 ${threshold - approvals}표가 필요합니다. 사람에게 투표를 요청하세요 — 재시도로는 바뀌지 않습니다.`)
  return L.join('\n')
}

const labelSource = (s) => ({ amendment: '개정(amendment)', rules: '파트 규칙(rules)', default: '기본(default)' }[s] ?? s)
