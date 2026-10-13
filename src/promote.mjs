/**
 * 승격(**promotion** — 아래 단계 브랜치에 쌓인 것을 위 단계로 올리는 것) **계획**.
 *
 * 순수 판정만 둔다. git 도 네트워크도 시계도 여기 없다 (`tools/promote.mjs` 가 담당).
 * 이 저장소가 `src/version.mjs` 와 `tools/version.mjs` 를 가른 것과 같은 이유다 —
 * 하루를 기다리지 않고 "오늘 봇이 무엇을 올릴 것인가" 를 검증할 수 있어야 한다.
 *
 * 봇이 도는 주기는 둘이다.
 *
 *   dev-to-part   `<파트>/dev`  → `<파트>/main` (= `<파트>/func`)   하루 한 번
 *   part-to-main  `<파트>/main` → 최상위 `main`                      주 한 번
 *
 * ── 왜 짝짓기 규칙을 여기서 새로 만들지 않는가 ────────────────────────────────
 *
 * 🔴 만든 짝은 **전부 `checkTarget`(src/mrtarget.mjs)을 지난다.** 여기서 "dev 는
 *    같은 파트의 main 으로" 를 다시 적으면 한 저장소에 브랜치 규칙이 둘이 되고,
 *    그러면 **사람이 연 MR 은 막히는데 봇이 연 MR 은 통과하는** 조합이 생긴다.
 *    봇이 자기 규칙의 예외가 되는 순간 그 규칙은 규칙이 아니다.
 *
 *    같은 이유로 단계 판정도 `levelOf`(src/version.mjs) 를 가져다 쓴다.
 *    `back/main` 이 최상위인지 파트인지를 버전 자동화와 봇이 서로 다르게 답하면
 *    안 된다.
 *
 * 도구 전용 브랜치(`axmap/claims`·`axmap/votes`)를 여기서 따로 걸러내지 않는 것도
 * 같은 맥락이다. `checkTarget` 이 이미 막는다 — 두 군데서 막으면 한쪽을 고칠 때
 * 다른 쪽이 남아 "고쳤는데 안 바뀐다" 가 된다.
 */

import { levelOf } from './version.mjs'
import { checkTarget, partOf } from './mrtarget.mjs'

/** 봇이 도는 주기. 문자열을 코드 여기저기에 흩지 않는다. */
export const STEPS = ['dev-to-part', 'part-to-main']

/** 사람이 읽는 주기 이름. 로그의 첫 줄이 된다. */
export function describeStep(step) {
  switch (step) {
    case 'dev-to-part': return '파트 개발 브랜치 → 파트 브랜치 (하루 한 번)'
    case 'part-to-main': return '파트 브랜치 → 최상위 main (주 한 번)'
    default: return '알 수 없는 주기'
  }
}

/** 최상위 브랜치 이름은 저장소마다 다르다 (`main` · `master`). 목록에서 고른다. */
function topBranchOf(list) {
  if (list.includes('main')) return 'main'
  if (list.includes('master')) return 'master'
  return null
}

/**
 * 브랜치 이름 목록을 다듬는다. 공백·중복·비문자열을 버린다.
 *
 * 버리는 것을 `skipped` 에 적지 않는 이유: 여기서 걸러지는 것은 "브랜치가 아닌 것"
 * 이지 "승격 후보였는데 떨어진 것" 이 아니다. 둘을 한 목록에 담으면 사람이
 * 건너뛴 이유를 읽으러 왔다가 잡음부터 읽게 된다.
 */
function cleanBranches(branches) {
  const out = []
  const seen = new Set()
  for (const b of branches ?? []) {
    if (typeof b !== 'string') continue
    const name = b.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out.sort()
}

/**
 * 이번 주기에 올릴 짝을 만든다.
 *
 * @param {string[]} branches 저장소에 **실제로 있는** 브랜치 이름 목록
 * @param {{step: string}} opts 주기
 * @returns {{step:string, pairs:Array<{source:string,target:string,reason:string}>,
 *            skipped:Array<{source:string,target:string|null,code:string,reason:string}>}}
 *
 * 🔴 `pairs` 만 보고 실행하면 안 되는 이유가 `skipped` 에 있다. "오늘 back 은 왜
 *    안 올라갔나" 의 답이 거기 들어 있고, 그 답이 없으면 사람이 봇을 의심하는 대신
 *    자기 브랜치를 의심한다.
 */
export function planPromotions(branches, { step } = {}) {
  if (!STEPS.includes(step)) {
    throw new Error(
      `알 수 없는 승격 주기: ${step}\n`
      + `  쓸 수 있는 것: ${STEPS.join(' | ')}`,
    )
  }

  const list = cleanBranches(branches)
  const pairs = []
  const skipped = []
  const exists = new Set(list)

  const drop = (source, target, code, reason) => skipped.push({ source, target, code, reason })

  /** 짝을 넣기 전에 반드시 여기를 지난다. 봇도 사람과 같은 문을 쓴다. */
  const accept = (source, target, reason) => {
    const verdict = checkTarget(source, target)
    if (!verdict.ok) {
      drop(source, target, `blocked:${verdict.code}`,
        `브랜치 규칙이 막았습니다 — ${verdict.message.split('\n')[0]}`)
      return
    }
    pairs.push({ source, target, reason })
  }

  if (step === 'dev-to-part') {
    for (const source of list) {
      if (levelOf(source) !== 'dev') continue
      const part = partOf(source)
      if (!part) {
        drop(source, null, 'no-part',
          '파트를 읽을 수 없습니다 — `<파트>/dev` 처럼 앞에 파트 이름이 있어야 합니다.')
        continue
      }
      // 팀 컨벤션은 `<파트>/main` 이고 `<파트>/func` 도 같게 친다 (levelOf 가 둘 다
      // func 으로 읽는다). 둘 다 있으면 main 쪽으로 올린다 — 컨벤션에 적힌 이름이
      // 그쪽이고, 둘로 갈라 올리면 같은 코드가 두 릴리스 후보에 각각 들어간다.
      const main = `${part}/main`
      const func = `${part}/func`
      const target = exists.has(main) ? main : (exists.has(func) ? func : null)
      if (!target) {
        drop(source, null, 'no-target',
          `올릴 곳이 없습니다 — \`${main}\` 도 \`${func}\` 도 아직 없습니다.`)
        continue
      }
      if (target === main && exists.has(func)) {
        drop(source, func, 'duplicate-target',
          `\`${main}\` 과 \`${func}\` 이 둘 다 있어 \`${main}\` 쪽으로만 올립니다.`)
      }
      accept(source, target, `${part} 파트의 하루치`)
    }
    return { step, pairs, skipped }
  }

  // part-to-main
  const top = topBranchOf(list)
  for (const source of list) {
    if (levelOf(source) !== 'func') continue
    if (!top) {
      drop(source, null, 'no-top-main',
        '최상위 `main` 이 목록에 없습니다 — 올릴 곳을 추측하지 않습니다.')
      continue
    }
    accept(source, top, `${partOf(source) ?? source} 파트의 한 주치`)
  }
  return { step, pairs, skipped }
}

/**
 * 사람과 에이전트가 함께 읽는 계획표.
 *
 * 메시지 생성을 순수 로직에 두는 것은 이 저장소의 관례다 (`formatCheck`,
 * `formatVerdict`). 덕분에 **"건너뛴 이유가 출력에 남는가" 를 테스트로 고정할 수
 * 있다** — 그 줄을 지우면 테스트가 빨개진다.
 */
export function formatPlan(plan) {
  const L = []
  L.push(`승격 계획 — ${describeStep(plan.step)}`)
  L.push('')
  if (plan.pairs.length === 0) {
    L.push('  올릴 짝이 없습니다.')
  } else {
    for (const p of plan.pairs) L.push(`  o ${p.source} -> ${p.target}   (${p.reason})`)
  }
  if (plan.skipped.length) {
    L.push('')
    L.push('  건너뛴 것')
    for (const s of plan.skipped) {
      const where = s.target ? `${s.source} -> ${s.target}` : s.source
      L.push(`    - ${where}  [${s.code}] ${s.reason}`)
    }
  }
  return L.join('\n')
}
/**
 * ── 표의 이유를 머지 커밋에 싣는다 ──────────────────────────────────────────
 *
 * 🔴 **왜 GitLab MR 댓글이 아니라 커밋 메시지인가.**
 *
 * AI 여러 대가 MR 을 검토하면 의견이 쌓인다. 그 의견을 어디에 두느냐로 이후가
 * 갈린다. 기본값(MR 댓글)은 세 가지가 나쁘다.
 *
 *   1. **git 안에 없다.** clone 해도 안 따라온다. 다음 에이전트가 `git log` 로
 *      "왜 이렇게 머지됐나" 를 못 읽는다
 *   2. **플랫폼에 묶인다.** GitLab 을 떠나면 통째로 사라진다
 *   3. **MR 이 닫히면 아무도 안 본다.** 맥락도 같이 닫힌다
 *
 * 이 저장소는 이미 같은 판단을 두 번 했다 — 장부(`axmap/claims`)도 쪽지
 * (`axmap/bus`)도 서버가 아니라 **고아 브랜치**에 뒀다. 합의의 근거도 같은 자리,
 * 즉 저장소 안에 남긴다. 트레일러로 적으면 `git log --grep` 과
 * `git interpret-trailers --parse` 가 그대로 읽는다.
 *
 * 🔴 **콜론 앞은 영문이어야 한다.** 2026-08-28 실측 — git 은 그 자리를 사람이
 *    읽는 이름이 아니라 **기계가 찾는 열쇠**로 본다. 한글이거나 괄호가 섞이면
 *    그 줄을 트레일러가 아니라 평범한 본문으로 보고 지나친다.
 *
 *      Reviewed-by: bob <b@x.com>            → 뽑힌다
 *      찬성(Reviewed-by): bob <b@x.com>      → 무시된다
 *      Reviewed-by(찬성): bob <b@x.com>      → 무시된다
 *      찬성: bob <b@x.com>                   → 무시된다
 *
 *    그래서 열쇠는 영문으로 두고 **한글을 값의 맨 앞**에 놓는다. 사람이 눈으로
 *    읽을 때 먼저 보이는 것은 여전히 '찬성'·'반대' 다.
 *
 * 🔴 **반대표도 싣는다.** 반대는 정족수 계산에 안 들어가므로(거부권은 다른 제도다)
 *    반대가 있어도 머지될 수 있다. 그때 그 반대가 아무 데도 안 남으면, 나중에
 *    문제가 터졌을 때 **"아무도 몰랐다" 로 기록된다.** 알았던 사람이 있었다는 것이
 *    남아야 한다.
 */

/** 트레일러 값에 들어갈 수 있게 한 줄로 만든다. */
function oneLine(s, max = 200) {
  const t = String(s ?? '').replace(/\s+/gu, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/**
 * 표 한 장을 트레일러 한 줄로.
 *
 * 🔴 이유가 비어 있으면 `— …` 를 안 붙인다. 정책이 `vote_note` 를 안 켰으면
 *    이유가 없는 것이 정상이고, 빈 꼬리를 붙이면 "이유를 안 적었다" 가 아니라
 *    "이유 칸이 깨졌다" 처럼 보인다.
 */
function trailerLine(key, vote, stance) {
  const who = `${oneLine(vote?.voter, 60) || '?'} <${oneLine(vote?.email, 100) || '?'}>`
  const note = oneLine(vote?.note)
  return `${key}: ${stance} — ${who}${note ? ` · ${note}` : ''}`
}

/**
 * 판정(`gate.mjs --json` 의 verdict)에서 트레일러 줄들을 만든다.
 * 판정이 셀 수 없었으면(정책 깨짐·판정 불가) 빈 배열이다 — 없는 것을 지어내지 않는다.
 */
export function reviewTrailers(verdict) {
  const t = verdict?.tally
  if (!t) return []
  const out = []
  for (const v of Array.isArray(t.counted) ? t.counted : []) out.push(trailerLine('Reviewed-by', v, '찬성'))
  for (const v of Array.isArray(t.rejections) ? t.rejections : []) out.push(trailerLine('Rejected-by', v, '반대'))
  return out
}

/**
 * 봇이 머지할 때 쓸 커밋 메시지. GitLab 의 `merge_commit_message` 로 넘어간다.
 *
 * 🔴 첫 줄은 GitLab 기본형(`Merge branch 'A' into 'B'`)을 그대로 쓴다. 사람이
 *    누른 머지와 봇이 누른 머지가 이력에서 다르게 보이면, 나중에 이력을 훑는
 *    사람이 **다르게 보이는 것 자체를 신호로 오해한다.** 다른 것은 트레일러뿐이다.
 *
 * 🔴 트레일러가 없으면 본문도 안 붙인다 — `null` 을 내서 부르는 쪽이 그 필드를
 *    아예 안 보내게 한다. 빈 본문을 보내면 GitLab 이 기본 메시지를 덮어쓴다.
 */
export function mergeCommitMessage({ source, target, verdict }) {
  const trailers = reviewTrailers(verdict)
  if (trailers.length === 0) return null
  const head = `Merge branch '${source}' into '${target}'`
  const approvals = verdict?.approvals ?? verdict?.tally?.approvals ?? 0
  const threshold = verdict?.threshold ?? 0
  const summary = `정족수 ${approvals}/${threshold} · 판정 커밋 ${String(verdict?.sha ?? '').slice(0, 12)}`
  return [head, '', summary, '', ...trailers].join('\n')
}
