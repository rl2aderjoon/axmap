/**
 * 브라우저 코드에는 검사가 하나도 없었다.
 *
 * 🔴 `app/web/*.js` 는 `npm test` 가 한 줄도 안 본다. node 에서 import 할 수 없기
 * 때문이다(DOM 이 없다). 그래서 **문법 오류 하나면 화면 전체가 백지**가 되는데
 * 테스트는 초록이다.
 *
 * 밤샘 온보딩 루프에서 이게 특히 위험하다. 에이전트는 UI 로만 일하므로,
 * 화면이 죽으면 그 회차가 통째로 날아가고 우리는 "도구가 이해를 못 준다" 는
 * 잘못된 결론을 얻는다 — 실제로는 그냥 오타였는데.
 *
 * 실행하지 않고 확인할 수 있는 두 가지만 본다. 실행은 브라우저의 몫이다.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(ROOT, 'app', 'web')
const MODULES = fs.readdirSync(WEB).filter((f) => f.endsWith('.js'))

/**
 * ESM 으로 문법만 확인한다.
 *
 * `.js` 를 그대로 `node --check` 하면 CommonJS 로 읽어서 `import` 를 오류로 본다.
 * 브라우저는 `<script type=module>` 로 읽으므로 `.mjs` 로 복사해서 검사한다.
 */
function syntaxError(src, name) {
  const tmp = path.join(os.tmpdir(), `axmap-syntax-${name}.mjs`)
  fs.writeFileSync(tmp, src)
  try {
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8', windowsHide: true })
    return r.status === 0 ? null : (r.stderr ?? '').trim().split('\n').slice(0, 3).join(' ')
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* 지워지면 그만 */ }
  }
}

describe('브라우저 코드 — 문법', () => {
  it('모듈을 하나 이상 찾았다', () => {
    // 파일을 못 찾고 통과하면 검사가 아니라 장식이다
    assert.ok(MODULES.length > 0, `${WEB} 에 .js 가 없다`)
  })

  for (const f of MODULES) {
    it(`${f} 이 ESM 으로 파싱된다`, () => {
      const err = syntaxError(fs.readFileSync(path.join(WEB, f), 'utf8'), f.replace(/\W/g, '_'))
      assert.equal(err, null, `${f}: ${err}`)
    })
  }

  it('🔴 검사기가 실제로 깨진 코드를 잡는다', () => {
    // 한 번도 실패하지 않는 검사기는 검사기가 아니다 (CLAUDE.md)
    assert.notEqual(syntaxError('const s = {\n', 'broken'), null)
    assert.notEqual(syntaxError('function f( { return 1 }', 'broken2'), null)
    // 그리고 멀쩡한 ESM 은 통과시킨다 — 아무거나 잡으면 그것도 검사가 아니다
    assert.equal(syntaxError('import x from "y"\nexport const z = () => 1\n', 'fine'), null)
  })
})

describe('브라우저 코드 — DOM 참조', () => {
  /**
   * 어떤 모듈이 어느 화면에 실리는지 — `<script src>` 에서 시작해 import 를 따라간다.
   * `graph.js` 처럼 다른 모듈이 import 하는 것도 이렇게 해야 잡힌다.
   */
  const deps = (roots) => {
    const seen = new Set()
    const queue = [...roots]
    while (queue.length) {
      const f = queue.pop()
      if (seen.has(f) || !fs.existsSync(path.join(WEB, f))) continue
      seen.add(f)
      const src = fs.readFileSync(path.join(WEB, f), 'utf8')
      for (const m of src.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.js)'/g)) queue.push(m[1])
    }
    return [...seen]
  }

  /**
   * 🔴 어느 화면이 어느 모듈을 싣는지 **HTML 에서 읽는다.**
   *
   * 화면이 둘이 되면서(`index.html` · `shell.html`) 짝이 갈렸다. 그 짝을 여기
   * 손으로 적으면 화면을 새로 만들 때마다 이 파일도 같이 고쳐야 하고, 안 고치면
   * 새 모듈이 검사에서 **조용히 빠진다** — 검사기가 눈이 머는 것이 최악이다.
   * `<script src>` 가 이미 짝을 적어 두고 있으므로 그것을 진실로 삼는다.
   */
  const PAGES = fs.readdirSync(WEB)
    .filter((f) => f.endsWith('.html'))
    .map((f) => {
      const html = fs.readFileSync(path.join(WEB, f), 'utf8')
      const roots = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1])
      return {
        page: f,
        ids: new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])),
        modules: deps(roots),
      }
    })

  it('화면마다 id 와 싣는 모듈을 읽었다', () => {
    assert.ok(PAGES.length >= 1, `화면을 하나도 못 찾았다 — 정규식이 깨졌을 수 있다`)
    for (const p of PAGES) {
      assert.ok(p.ids.size > 5, `${p.page} 에서 id 를 ${p.ids.size}개만 찾았다`)
      assert.ok(p.modules.length > 0, `${p.page} 가 싣는 .js 를 못 찾았다`)
    }
  })

  it('아무 화면도 안 싣는 .js 가 없다', () => {
    // 죽은 파일이거나, 화면에 싣는 것을 빠뜨린 것이다. 둘 다 알아야 한다.
    const loaded = new Set(PAGES.flatMap((p) => p.modules))
    assert.deepEqual(MODULES.filter((f) => !loaded.has(f)), [])
  })

  /**
   * 🔴 `$('#없는id')` 는 null 을 내고, 그 다음 줄에서 터진다.
   *
   * 화면 코드는 대부분 최상위에서 한 번 실행되므로 이런 오류 하나가
   * **그 아래 전부를 안 돌게** 만든다. 조용히 반쪽만 동작하는 화면이 된다.
   */
  for (const p of PAGES) {
    for (const f of p.modules) {
      it(`${f} 의 $('#id') 가 전부 ${p.page} 에 있다`, () => {
        const src = fs.readFileSync(path.join(WEB, f), 'utf8')
        const missing = [...src.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)]
          .map((m) => m[1])
          .filter((id) => !p.ids.has(id))
        assert.deepEqual([...new Set(missing)], [], `${p.page} 에 없는 id 를 참조한다`)
      })
    }
  }
})
/**
 * 🔴 여기 있던 검사 둘(`actor 색·범례 일치` · `pathbar 겹침`)은 함께 지웠다.
 *
 * 둘 다 `overlay.js`·`graph.js`·`overlay.css` 를 읽는 검사였고, 그 파일들이
 * 사라졌으니 검사도 갈 곳이 없다. 남겨 두면 "없는 파일" 오류로 매번 빨개지고,
 * 그러면 사람이 검사 전체를 무시하기 시작한다 — 그게 검사가 죽는 방식이다.
 *
 * 그 검사들이 지킨 성질은 잃어도 되는 것이 아니다.
 *   · actor 이름이 규격·색·범례 세 곳에서 같아야 한다 (조용한 폴백을 막는다)
 *   · 같은 자리에 두 개를 겹쳐 그리지 않는다 (배치는 DOM 텍스트에 흔적이 없다)
 * 새 화면이 색과 배치를 갖게 되면 **그때 다시 세운다.**
 * 지운 것은 `git show 02b6dfc:test/web.test.mjs` 에 그대로 있다.
 */
