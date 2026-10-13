#!/usr/bin/env node
/**
 * 테스트를 돌리기 전에 **돌릴 것이 있는지부터 확인한다.**
 *
 * 🔴 `node --test "test/*.test.mjs"` 는 글롭이 아무것도 잡지 못해도
 * 테스트 0개를 돌리고 **exit 0** 을 낸다. 실측:
 *
 *     $ node --test "test/nonexistent-*.test.mjs"
 *     exit=0
 *
 * 즉 `npm test` 가 초록인데 검증은 하나도 일어나지 않은 상태가 가능하다.
 * 이 저장소가 락에서 금지한 fail-open 과 같은 종류이고, 하필 그것을 막는
 * 검증 계층 자체에 있었다.
 *
 * 파일 목록을 `readdirSync` 로 직접 만들어 `--test` 에 **명시적 경로**로 넘긴다.
 * 글롭 해석을 Node 에게 맡기지 않으므로, 어느 버전에서 돌리든 같은 목록이 돈다.
 * (참고: `node --test test/` 처럼 디렉터리를 넘기는 방식은 Node 24 에서
 *  디렉터리를 모듈로 실행하려다 죽는다. 그래서 이 길은 선택지가 아니었다.)
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 호출 위치에 기대지 않는다. bin/axmap.mjs 가 같은 이유로 쓰는 방식이다.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'test')

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(dir, f))

if (files.length === 0) {
  console.error(`테스트 파일을 하나도 찾지 못했습니다: ${dir}/*.test.mjs`)
  console.error('돌릴 것이 없는 것을 통과로 세지 않습니다.')
  process.exit(1)
}

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root })
// status 가 null 이면 신호로 죽은 것이다. 통과로 세지 않는다.
process.exit(r.status ?? 1)
