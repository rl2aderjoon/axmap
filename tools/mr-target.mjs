#!/usr/bin/env node
/**
 * MR 이 한 칸씩 올라가는지 검사하는 CLI — 환경변수와 출력만 담당하는 층.
 *
 * 판정은 전부 `src/mrtarget.mjs` 의 순수 함수에 있다.
 *
 *   node axmap/tools/mr-target.mjs                                  CI 에서 (환경변수로)
 *   node axmap/tools/mr-target.mjs --source <브랜치> --target <브랜치>  손으로
 *
 *   --json   판정을 기계가 읽는 모양으로도 낸다
 *
 * 종료 코드: 0 통과 · 2 규칙 위반(대상을 바꾸면 풀린다) · 1 판정 불가(환경 문제)
 */

import { checkTarget, formatCheck, EXIT } from '../src/mrtarget.mjs'

const argv = process.argv.slice(2)
const flag = (n) => {
  const i = argv.indexOf(n)
  return i < 0 ? null : argv[i + 1] ?? null
}
const has = (n) => argv.includes(n)

/**
 * 🔴 플래그가 환경변수를 이긴다.
 *
 * CI 안에서 손으로 한 번 더 돌려볼 때 환경변수가 남아 있으면 **내가 준 값이
 * 무시되고 엉뚱한 판정이 나온다.** 그러면 "손으로는 되는데 CI 에서만 막힌다"
 * 같은 착각이 생기고, 그 착각은 규칙을 못 믿게 만든다.
 */
const source = flag('--source') ?? process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? ''
const target = flag('--target') ?? process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? ''

if (!source || !target) {
  console.error('소스/대상 브랜치를 알 수 없습니다.')
  console.error('')
  console.error('  CI 에서라면 이 잡이 MR 파이프라인에서만 돌게 되어 있는지 보세요.')
  console.error('  (`rules:` 에 `$CI_PIPELINE_SOURCE == "merge_request_event"` 가 있어야')
  console.error('   `CI_MERGE_REQUEST_*` 변수가 내려옵니다. 브랜치 파이프라인에는 없습니다.)')
  console.error('')
  console.error('  손으로 돌린다면:')
  console.error('    node axmap/tools/mr-target.mjs --source feat/S15P21E201-144-login --target front/dev')
  process.exit(EXIT.UNDECIDABLE)
}

const result = checkTarget(source, target)
console.log(formatCheck(result))
if (has('--json')) console.log(JSON.stringify(result, null, 2))
process.exit(result.exit)
