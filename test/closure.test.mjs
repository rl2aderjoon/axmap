/**
 * CI 진입점에서 닿는 파일 목록을 **고정한다.**
 *
 * ── 이 테스트가 왜 있는가 ────────────────────────────────────────────────────
 *
 * 팀 저장소(S15P21E201)의 CI 는 axMap 을 clone 하지 않는다. 진입점에서 닿는
 * 파일만 복사해 둔 사본(`ci/axmap/`)을 부른다 — 이것을 **벤더링**(vendoring —
 * 남의 코드를 내 저장소 안에 사본으로 두고 그 사본으로 돌리는 것) 이라고 한다.
 * 사본은 `tools/vendor.mjs` 가 만든다.
 *
 * 🔴 그래서 여기서 import 를 하나 더 쓰면, **axMap 에서는 초록인데 팀 CI 만
 *    죽는다.** 팀 저장소의 사본에는 그 새 파일이 없기 때문이다.
 *    원인(axMap 의 커밋)과 증상(팀 저장소의 빨간 파이프라인)이 서로 다른
 *    저장소에 있어서, 실제로 겪으면 제일 찾기 어려운 모양이다.
 *
 *    이 테스트는 그 순간을 **원인 쪽 저장소에서** 잡는다.
 *
 * ── 목록을 늘려야 할 때 ─────────────────────────────────────────────────────
 *
 * 이 테스트가 빨개졌다고 목록을 지우거나 테스트를 삭제하면 안 된다.
 * 늘리는 것 자체는 괜찮다. 다만 **두 곳을 같이** 움직여야 한다.
 *
 *   1. 여기 `EXPECTED` 에 새 파일을 더한다
 *   2. axMap 에서 커밋한 뒤 `node tools/vendor.mjs --to <팀저장소>` 를 다시 돌리고
 *      팀 저장소에 생긴 `ci/axmap/` 변경을 MR 로 올린다
 *
 * 2 번을 빠뜨리면 이 테스트는 초록인데 팀 CI 는 죽는다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CI_ENTRYPOINTS,
  classifySpecifier,
  formatClosureProblems,
  importClosure,
  importSpecifiers,
  resolveImport,
  stripComments,
} from '../src/closure.mjs'

const AXMAP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 팀 저장소에 복사되어 있어야 하는 파일 전부.
 *
 * 🔴 이 목록은 **사본과 맞물린 계약**이다. 여기를 고치는 것은 팀 저장소의
 *    `ci/axmap/` 을 고치겠다는 뜻이다. 위 머리말의 두 단계를 같이 해야 한다.
 */
const EXPECTED = [
  'bin/axmap.mjs',
  'governance/gate.mjs',
  'governance/vote.mjs',
  'mcp/server.mjs',
  'src/governance.mjs',
  'src/identity.mjs',
  'src/invariants.mjs',
  // `doctor` 가 "MCP 가 어디에 등록돼 있나" 를 읽는 자리. 등록기(tools/mcp-register.mjs)와
  // 같은 판정을 두 벌 쓰지 않으려고 뺀 것이라, 사본에도 같이 가야 한다 —
  // `bin/axmap.mjs` 가 static import 하므로 없으면 CLI 가 통째로 죽는다.
  'src/mcpstate.mjs',
  'src/mrtarget.mjs',
  // 선점할 때 "이미 누가 같은 것을 했을지도 모른다" 를 알리는 판정.
  // `bin/axmap.mjs` 가 static import 하므로 없으면 CLI 가 통째로 죽는다.
  'src/overlap.mjs',
  'src/promote.mjs',
  'src/protocol.mjs',
  'src/repolock.mjs',
  'src/repotarget.mjs',
  // `src/update.mjs` 는 사본에서 **아무것도 하지 않는다.** 옆에 SOURCE.json 이 있으면
  // 사본으로 판정하고 갱신 확인을 통째로 건너뛴다(test/update.test.mjs 가 고정한다).
  // 그래도 목록에 있어야 한다 — `bin/axmap.mjs` 가 static import 하므로, 사본에
  // 이 파일이 없으면 팀 CI 에서 CLI 가 모듈을 못 찾고 통째로 죽는다.
  'src/update.mjs',
  'src/version.mjs',
  'tools/bus.mjs',
  'tools/mr-target.mjs',
  'tools/promote.mjs',
  'tools/version.mjs',
].sort()

const readFile = (rel) => {
  try {
    return fs.readFileSync(path.join(AXMAP, ...rel.split('/')), 'utf8')
  } catch {
    return null
  }
}

const closure = importClosure({ entries: CI_ENTRYPOINTS, readFile })

const WHY =
  '\n\n' +
  '  이 목록은 팀 저장소(S15P21E201)의 ci/axmap/ 사본과 맞물려 있습니다.\n' +
  '  여기서 어긋나면 axMap 은 초록인데 팀 CI 만 죽습니다 — 사본에 그 파일이 없어서입니다.\n' +
  '\n' +
  '  목록을 늘리는 것이 맞다면 두 가지를 같이 하세요.\n' +
  '    1. test/closure.test.mjs 의 EXPECTED 를 고친다\n' +
  '    2. 커밋한 뒤 node tools/vendor.mjs --to <팀저장소 루트> 를 다시 돌리고\n' +
  '       거기 생긴 ci/axmap/ 변경을 MR 로 올린다\n' +
  '\n' +
  '  이 테스트를 지우지 마세요. 2번을 빠뜨린 것을 잡아 주는 유일한 자리입니다.'

describe('CI 진입점의 import 폐포', () => {
  it('진입점이 전부 실재한다', () => {
    for (const rel of CI_ENTRYPOINTS) {
      assert.notEqual(
        readFile(rel),
        null,
        `CI 가 부르는 진입점이 없습니다: ${rel}\n` +
          '  진입점을 옮기거나 이름을 바꿨다면 src/closure.mjs 의 CI_ENTRYPOINTS 와\n' +
          '  .gitlab-ci.yml 을 같이 고쳐야 합니다.',
      )
    }
  })

  it('폐포가 팀 저장소 사본의 목록과 정확히 같다', () => {
    const got = closure.files
    const extra = got.filter((f) => !EXPECTED.includes(f))
    const lost = EXPECTED.filter((f) => !got.includes(f))

    const detail = [
      extra.length > 0 ? `  늘어난 것: ${extra.join(', ')}` : null,
      lost.length > 0 ? `  없어진 것: ${lost.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    assert.deepEqual(got, EXPECTED, `${detail}${WHY}`)
  })

  it('폐포 안에서는 Node 내장 밖의 것을 import 하지 않는다', () => {
    const problems = formatClosureProblems(closure)
    assert.deepEqual(
      problems,
      [],
      `${problems.join('\n')}\n\n` +
        '  사본에는 node_modules 가 없습니다. 팀 저장소의 CI 는 npm install 을 하지 않고\n' +
        '  ci/axmap/ 의 파일을 node 로 바로 부릅니다 — 패키지를 하나라도 쓰면 거기서 죽습니다.\n' +
        "  내장 모듈이라면 'fs' 가 아니라 'node:fs' 로 적으세요. 접두사 없는 이름은\n" +
        '  같은 이름의 패키지에 가려질 수 있어서 무엇이 로드됐는지 코드만 보고는 알 수 없습니다.',
    )
  })

  it('폐포 밖으로 새는 상대 경로가 없다', () => {
    assert.deepEqual(
      closure.outside,
      [],
      'axmap/ 위쪽을 import 하고 있습니다. 사본에는 그 위쪽이 없습니다.',
    )
  })
})

/*
 * 아래는 폐포를 구하는 계산 자체를 본다.
 *
 * 🔴 위의 테스트만 있으면 **폐포 함수가 아무것도 못 찾아도 초록이 될 수 있다** —
 *    import 를 하나도 못 읽는 함수는 진입점만 돌려주고, 그러면 목록이 줄어 위에서
 *    걸리기는 한다. 하지만 "주석 안의 예시를 진짜 import 로 셌다" 같은 반대
 *    방향 오류는 목록이 우연히 맞으면 안 걸린다. 그래서 따로 못을 박는다.
 */
describe('import 를 알아보는 방식', () => {
  it('여러 줄에 걸친 import 를 읽는다', () => {
    const src = 'import {\n  a,\n  b,\n} from "./x.mjs"\n'
    assert.deepEqual(importSpecifiers(src), ['./x.mjs'])
  })

  it('부수효과 import 와 재수출을 읽는다', () => {
    assert.deepEqual(importSpecifiers("import './side.mjs'\n"), ['./side.mjs'])
    assert.deepEqual(importSpecifiers("export * from './re.mjs'\n"), ['./re.mjs'])
    assert.deepEqual(importSpecifiers("export { a } from './re.mjs'\n"), ['./re.mjs'])
  })

  it('동적 import 를 읽는다', () => {
    assert.deepEqual(importSpecifiers("await import('./late.mjs')\n"), ['./late.mjs'])
  })

  it('주석에 적힌 예시를 import 로 세지 않는다', () => {
    // 이 저장소의 파일들은 머리말 주석에 사용법을 적어 둔다. 거기 있는 예시를
    // 세면 있지도 않은 파일을 복사 목록에 넣게 된다.
    const src = [
      '/**',
      " * 예: import x from './ghost.mjs'",
      ' *   node axmap/governance/gate.mjs',
      ' */',
      "// import y from './ghost2.mjs'",
      "import real from './real.mjs'",
    ].join('\n')
    assert.deepEqual(importSpecifiers(src), ['./real.mjs'])
  })

  it('import.meta 를 import 로 세지 않는다', () => {
    assert.deepEqual(importSpecifiers('const u = import.meta.url\n'), [])
  })

  it('정규식 리터럴 안의 슬래시를 주석으로 읽지 않는다', () => {
    // `/…\/\/…/` 를 주석 시작으로 잘못 읽으면 그 뒤가 통째로 사라져,
    // 아래 import 가 없는 것처럼 보인다.
    const src = ['const re = /a\\/\\/b/', "import x from './after.mjs'"].join('\n')
    assert.deepEqual(importSpecifiers(src), ['./after.mjs'])
  })

  it('문자열 안의 주석 기호에 속지 않는다', () => {
    const src = ["const url = 'https://example.com/*'", "import x from './after.mjs'"].join('\n')
    assert.deepEqual(importSpecifiers(src), ['./after.mjs'])
  })

  it('닫히지 않은 블록 주석에서 무한히 돌지 않는다', () => {
    assert.equal(typeof stripComments('/* 끝나지 않는 주석'), 'string')
  })
})

describe('import 대상을 가르는 방식', () => {
  it("'node:' 가 붙은 것만 내장으로 센다", () => {
    assert.equal(classifySpecifier('node:fs'), 'builtin')
    assert.equal(classifySpecifier('fs'), 'bare')
    assert.equal(classifySpecifier('./x.mjs'), 'relative')
    assert.equal(classifySpecifier('../src/x.mjs'), 'relative')
    assert.equal(classifySpecifier('lodash'), 'bare')
  })

  it('상대 경로를 루트 기준으로 편다', () => {
    assert.equal(resolveImport('tools/version.mjs', '../src/version.mjs'), 'src/version.mjs')
    assert.equal(resolveImport('src/mrtarget.mjs', './version.mjs'), 'src/version.mjs')
    assert.equal(resolveImport('governance/gate.mjs', '../src/governance.mjs'), 'src/governance.mjs')
  })

  it('루트 밖으로 나가면 null 을 준다', () => {
    // 사본에는 axmap/ 위쪽이 없다. 조용히 통과시키면 CI 에서 모듈을 못 찾는다.
    assert.equal(resolveImport('tools/version.mjs', '../../outside.mjs'), null)
  })
})
