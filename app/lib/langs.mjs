/**
 * 언어별 import 규칙.
 *
 * 🔴 왜 떼어냈나.
 *
 * 예전에는 `analyze.mjs` 의 `importsOf()` 안에 언어별 if-체인으로 있었다.
 * 5개일 때는 읽을 만했다. 그런데 SSOT 코퍼스가 12,672개 저장소로 커지면서
 * 드러난 사실이 이랬다 — **결합 판정이 실제로 도는 언어는 5개뿐**이고
 * 코퍼스가 잰 커버리지(스냅샷 16,331) — 13개 언어가 90~100%, swift 만 4.9% 였다.
 * 그 숫자가 이 파일의 작업 순서를 정했다. 이제 swift 도 모듈 수준까지 푼다.
 *
 * 저장소는 500개씩 모았는데 import 를 못 읽으니 결합이 **0 으로 보인다.**
 * 그 0 을 근거로 "잘 분리돼 있군요" 라고 말하면 새빨간 거짓말이라
 * `MIN_COVERAGE_FOR_COUPLING` 게이트로 막아뒀다. 즉 **저장소를 더 모아도
 * 소용이 없고, 파서를 늘려야 한다.**
 *
 * 그래서 언어를 여럿 동시에 붙이게 됐고, if-체인은 그 순간 병목이 된다 —
 * 두 사람이 같은 함수의 같은 자리를 고치게 되므로 선점 프로토콜이 한 명을
 * 30분 세운다. **파일 경계가 곧 협업의 경계다.** 표로 바꾸면 언어마다
 * 자기 항목만 건드린다.
 *
 * 순수 함수만 둔다 — fs 도 git 도 시계도 없다 (CLAUDE.md).
 */

/**
 * @typedef {object} LangRule
 * @property {string[]} ext      이 언어로 볼 확장자
 * @property {'path'|'dir'} resolve
 *   `path` — 명세가 파일을 가리킨다 (python `a.b.c`, js `./x`, java `a.b.C`)
 *   `dir`  — 명세가 디렉터리를 가리킨다 (go `github.com/x/y`)
 * @property {(text: string) => Set<string>} extract
 *   본문에서 import **명세**를 그대로 뽑는다. 여기서 파일로 해석하지 않는다 —
 *   해석은 저장소 전체를 아는 `resolveImport()` 의 몫이다.
 */

/** python — `import a.b` · `from a.b import c` */
const PY_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm

/** js/ts — 상대 경로만. 외부 패키지는 이 그래프에 의미가 없다. */
const JS_RE = /(?:from|import)\s+["'](\.[^"']+)["']/g

/**
 * java — `import a.b.C;` · `import static a.b.C.member;` · `import a.b.*;`
 * 세 형태를 한 정규식으로 받고 아래에서 가른다.
 */
const JAVA_RE = /^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm

/**
 * go — 한 줄짜리와 괄호 묶음 둘 다.
 *
 *   import "fmt"
 *   import (
 *       "fmt"
 *       alias "github.com/x/y/z"
 *       _ "github.com/blank/import"
 *   )
 */
const GO_BLOCK_RE = /^\s*import\s*\(([\s\S]*?)^\s*\)/gm
const GO_ONE_RE = /^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm
const GO_IN_BLOCK_RE = /^\s*(?:[\w.]+\s+)?"([^"]+)"/gm

/**
 * rust — `mod x;` 와 `use a::b::C;`
 *
 * 🔴 두 문법은 신뢰도가 다르다. 그래서 다르게 다룬다.
 *
 * `mod x;` 는 **파일 선언**이다. 러스트에서는 이 줄이 있어야 `x.rs` 또는
 * `x/mod.rs` 가 빌드에 들어간다. 추측이 아니라 사실이고, 이것만으로도
 * 모듈 트리가 통째로 나온다.
 *
 * `use a::b::C;` 는 **이름 가져오기**다. 마지막 마디가 파일이 아니라 타입일
 * 때가 대부분이라(`Config` · `HashMap`) 그대로 경로로 쓰면 아무 데도 안 붙는다.
 * 러스트 관례상 타입은 UpperCamelCase, 모듈은 snake_case 라 그것으로 가른다.
 *
 * ⚠️ 일부러 안 하는 것 —
 *   · `mod x { ... }` (인라인 모듈) 은 파일이 없다. `;` 를 요구해 걸러진다.
 *   · `#[path = "..."] mod x;` 는 파일 위치를 바꾼다. 드물어서 안 다룬다.
 *   · 마디가 하나뿐인 `use serde;` 는 버린다 — 외부 크레이트 전체를 뜻하는데,
 *     해석기의 단일 마디 분기는 저장소에 이름이 유일하기만 하면 이어버린다.
 *     저장소에 우연히 `serde.rs` 가 있으면 거기 붙는다.
 */
const RS_MOD_RE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm
const RS_USE_RE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\s+([^;]+);/gm

/** 마지막 마디가 파일이 아니라 타입·매크로·와일드카드인가. */
const rsIsItem = (x) => x === '*' || x === '' || /^[A-Z]/.test(x)

/**
 * 한 `use` 에서 나올 수 있는 명세들.
 *
 * 🔴 **내부 뿌리(`crate`·`self`·`super`)일 때만** 접두사를 함께 낸다.
 *
 * `use self::helper::run;` 에서 `run` 은 함수일 수도 모듈일 수도 있다.
 * 러스트는 둘 다 snake_case 라 대소문자로 못 가른다. 그래서 `./helper/run` 과
 * `./helper` 를 둘 다 넘긴다 — **존재하는 파일만 엣지가 되므로** 오탐이 안 는다.
 * (`helper/run.rs` 가 있다면 `helper` 는 디렉터리 모듈이고 `run` 은 모듈이 맞다.)
 *
 * 외부 뿌리에는 안 한다. `use std::collections::HashMap` 의 접두사 `std` 를
 * 넘기면 저장소에 `std.rs` 가 있을 때 붙는다.
 */
function rsUseSpecs(raw, dir) {
  const out = []
  const spec = rsUseSpec(raw, dir)
  if (spec) out.push(spec)
  const head = raw.replace(/\s+/g, '').split('{')[0].split('::').filter(Boolean)[0]
  if (spec && ['crate', 'self', 'super'].includes(head)) {
    const cut = spec.lastIndexOf(spec.includes('/') ? '/' : '.')
    // 접두사가 `./` 나 `../` 만 남으면 가리키는 것이 없다.
    if (cut > 0) {
      const pre = spec.slice(0, cut)
      if (!/^\.+\/?$/.test(pre)) out.push(pre)
    }
  }
  return out
}

/**
 * `self`·`super` 가 가리키는 디렉터리를 **깊이**로 계산한다.
 *
 * `dir` 은 이 파일의 자식 모듈이 사는 곳(`rsModuleDir`) 이다.
 * `./` 이면 파일이 있는 디렉터리와 같고(깊이 0), `./stem/` 이면 한 칸 아래다(1).
 *
 *   self          → 그 자리 그대로
 *   super × N     → 거기서 N 칸 위
 *
 * 🔴 `src/a/mod.rs` 에서 `use super::x` 는 `src/x` 다 — `src/a/x` 가 아니다.
 *    예전에는 super 를 늘 파일 디렉터리로 봤고, mod.rs 에서 그건 자기 자식을
 *    가리킨다(`self::x` 와 같아진다). 같은 원인의 두 번째 버그였다.
 */
function rsPrefix(dir, up) {
  const depth = (dir === './' ? 0 : 1) - up
  if (depth === 1) return dir
  if (depth === 0) return './'
  return '../'.repeat(-depth)
}

function rsUseSpec(raw, dir) {
  // `use a::b::{c, d}` — 중괄호 앞의 공통 경로만 쓴다. 안쪽까지 펼치면
  // 각 마디가 모듈인지 타입인지 가릴 수 없어 오탐이 는다.
  let p = raw.split('{')[0]
  // `use a::b as c` — 별칭은 경로가 아니다.
  p = p.split(/\s+as\s+/)[0].replace(/\s+/g, '')
  const segs = p.split('::').filter((x) => x !== '')
  if (!segs.length) return null

  // 끝이 타입이면 떼어낸다. `crate::config::Config` → `crate::config`
  while (segs.length && rsIsItem(segs[segs.length - 1])) segs.pop()
  if (!segs.length) return null

  const head = segs[0]

  /**
   * 🔴 `super::x` 는 **같은 디렉터리**다. 한 단계 위가 아니다.
   *
   * 파이썬 상대 import 와 헷갈리기 쉬운 자리다. `src/a/b.rs` 는 모듈 `a::b` 이고
   * 그 `super` 는 모듈 `a` 인데, `a` 의 자식 파일들은 `src/a/` 에 산다 —
   * 즉 `b.rs` 자신이 있는 디렉터리다. 그래서 super 하나는 `./`,
   * 둘이어야 `../` 다. (해석기의 파이썬 분기가 `up <= 1` 로 같은 판단을 한다.)
   *
   * 처음에 `'../'.repeat(up)` 으로 썼다가 실측에서 잡았다 —
   * `use super::parent_thing` 이 형제가 아니라 삼촌을 가리키고 있었다.
   */
  if (head === 'self' || head === 'super') {
    let up = 0
    while (segs[up] === 'super') up++
    const rest = segs.slice(head === 'self' ? 1 : up)
    if (!rest.length) return null
    return `${rsPrefix(dir, up)}${rest.join('/')}`
  }

  // `crate::` 는 크레이트 뿌리다. 그 뿌리가 어느 디렉터리인지는 저장소마다
  // 다르므로(워크스페이스면 여럿) 마디만 넘기고 해석은 색인에 맡긴다.
  const rest = head === 'crate' ? segs.slice(1) : segs
  if (!rest.length) return null
  /**
   * 🔴 마디가 하나일 때의 판정이 `crate::` 여부로 갈린다.
   *
   * `use serde;` 는 외부 크레이트 전체다. 그대로 넘기면 해석기의 단일 마디
   * 분기가 "저장소에 이름이 유일하면" 이어버려, 우연히 있는 `serde.rs` 에 붙는다.
   *
   * 반면 `use crate::config::Config` 는 타입을 떼고 나면 `config` 하나만 남는데
   * 이건 **내부 모듈이 확실하다.** 처음에 둘을 같이 막았다가 러스트에서 가장
   * 흔한 형태를 통째로 잃었다.
   */
  if (rest.length < 2 && head !== 'crate') return null
  return rest.join('.')
}

/**
 * ruby — `require_relative` 와 `require`
 *
 * 🔴 둘의 신뢰도가 다르다.
 *
 * `require_relative 'x'` 는 **이 파일 기준 경로**라 확실하다.
 *
 * `require 'x'` 는 로드 경로 기준이라 대부분 젬·표준 라이브러리다
 * (`json` · `set` · `logger`). 마디가 하나뿐인 것을 그대로 넘기면 해석기의
 * 단일 마디 분기가 "저장소에 이름이 유일하면" 이어버린다 —
 * `require 'logger'` 가 우리 `app/logger.rb` 에 붙는 식이다.
 *
 * 그래서 **경로 모양(`/` 포함)만** 넘긴다. 그건 꼬리가 통째로 맞아야 붙으므로
 * (bySuffix) 외부 젬은 자연히 아무 데도 안 붙는다.
 * 잃는 것: `require 'my_helper'` 같은 내부 단일 이름. fail-closed 쪽이다.
 */
const RB_REL_RE = /^\s*require_relative\s+['"]([^'"]+)['"]/gm
const RB_REQ_RE = /^\s*require\s+['"]([^'"]+)['"]/gm

/** 색인은 확장자를 떼고 만든다. `require_relative 'x.rb'` 도 있어서 떼어준다. */
const RB_EXT = /\.rb$/

/**
 * 러스트에서 **이 파일의 자식 모듈이 사는 디렉터리**.
 *
 * 🔴 여기를 틀리면 없는 관계를 그럴듯하게 그린다.
 *
 * 실측(tokio): `src/runtime/context.rs` 가 `mod blocking;` 으로 자기 자식
 * 모듈(`context/blocking.rs`)을 선언하는데, 같은 디렉터리로 풀면
 * `src/runtime/blocking/mod.rs` 라는 **무관한 파일이 실제로 있어서** 거기
 * 선이 붙었다. 못 이은 것이 아니라 **틀리게 이은 것**이라 더 나쁘다 —
 * 신입은 화면에 있는 선을 사실로 읽는다. 같은 저장소에서 `mod tests;` 는
 * 아예 놓쳤다(21개 파일이 이 모양이다).
 *
 * 규칙(러스트 2018):
 *   `foo/mod.rs`  자식은 **같은 디렉터리** — `foo/x.rs`
 *   크레이트 뿌리 자식은 **같은 디렉터리** — `src/lib.rs` → `src/x.rs`
 *   그 밖의 `foo.rs`  자식은 **`foo/` 안** — `src/a.rs` → `src/a/x.rs`
 *
 * 크레이트 뿌리는 `lib.rs`·`main.rs` 와 `tests/`·`benches/`·`examples/`·
 * `src/bin/` 바로 아래의 파일이다. 마지막 넷은 카고가 각각을 독립 크레이트로
 * 빌드하기 때문이다 — ripgrep 의 `tests/tests.rs` 가 `mod util;` 로
 * `tests/util.rs` 를 가리키는 것이 그 경우다.
 *
 * 🔴 두 후보를 다 내지 않는다. tokio 처럼 **둘 다 존재하는** 저장소가 있고,
 *    그러면 틀린 선이 같이 그려진다. 갈래를 여기서 결정한다.
 */
const RS_ROOT = /(^|\/)(lib|main)\.rs$/
const RS_TARGET_DIR = /(^|\/)(tests|benches|examples|src\/bin)\/[^/]+\.rs$/

export function rsModuleDir(filePath) {
  const p = String(filePath ?? '').split(String.fromCharCode(92)).join('/')
  const slash = p.lastIndexOf('/')
  const base = slash < 0 ? p : p.slice(slash + 1)
  // 🔴 경로를 모르면 같은 디렉터리로 둔다. 그게 크레이트 뿌리·`mod.rs` 의
  //    답이고, 2015 판의 기본이기도 하다. 여기서 `./stem/` 을 지어내면
  //    있지도 않은 하위 디렉터리를 가리킨다.
  if (!base || base === 'mod.rs' || RS_ROOT.test(p) || RS_TARGET_DIR.test(p)) return './'
  return `./${base.replace(/\.rs$/, '')}/`
}

/**
 * c# — `using System;` · `using static A.B;` · `using X = A.B;`
 *
 * 🔴 자바와 닮았지만 **한 가지가 다르다.** 자바는 패키지가 곧 디렉터리이고
 *    파일 이름이 클래스 이름이라 `a.b.C` 가 파일 하나로 풀린다. c# 의
 *    `using` 은 **네임스페이스**를 부르고, 한 네임스페이스에 파일이 여럿일
 *    수 있으며 디렉터리와 일치할 의무도 없다.
 *
 *    그래도 관례상 대부분 일치하므로 마디를 넘기고 **해석기의 꼬리 검사에
 *    맡긴다** — 디렉터리가 안 맞으면 아무 데도 안 붙는다(fail-closed).
 */
const CS_USE_RE = /^\s*using\s+(?:static\s+)?(?:[\w]+\s*=\s*)?([\w.]+)\s*;/gm

/**
 * php — `use A\\B\\C;` 와 `require '경로'`
 *
 * 두 축이 다 있다. `use` 는 PSR-4 네임스페이스(구분자가 역슬래시)이고,
 * `require`/`include` 는 파일 경로다.
 *
 * 🔴 `use A\\{B, C}` 같은 묶음은 앞쪽 공통 경로만 쓴다. 안쪽까지 펼치면
 *    각 마디가 네임스페이스인지 클래스인지 가릴 수 없어 오탐이 는다
 *    (러스트 `use a::{b, c}` 에서 내린 것과 같은 판단).
 */
const PHP_USE_RE = /^\s*use\s+(?:function\s+|const\s+)?([\w\\\\]+)/gm
const PHP_REQ_RE = /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']([^"']+)["']/g

/**
 * kotlin — `import a.b.C` (세미콜론 없음) · `import a.b.*` 는 버린다
 *
 * ⚠️ 자바보다 근거가 약하다. 코틀린은 **파일 이름이 클래스 이름과 같을
 *    의무가 없고** 최상위 함수도 import 할 수 있다. 그래서 `a.b.foo` 가
 *    파일을 못 가리키는 경우가 자바보다 흔하다. 못 찾으면 안 잇는다.
 */
const KT_IMPORT_RE = /^\s*import\s+([\w.]+(?:\.\*)?)(?:\s+as\s+\w+)?\s*$/gm

/** scala — `import a.b.C` · `import a.b.{C, D}` · `import a.b._` */
const SCALA_IMPORT_RE = /^\s*import\s+([\w.]+)/gm

/**
 * 마디가 둘 이상인 점 경로만 남긴다.
 *
 * 마디가 하나면 해석기의 단일 마디 분기를 타서 "저장소에 이름이 유일하면"
 * 이어버린다. `using System;` 이 우연히 있는 `System.cs` 에 붙는 식이다.
 */
function dotted(spec) {
  return spec.includes('.') && !spec.endsWith('.*') && !spec.endsWith('._') ? spec : null
}

/** @type {Record<string, LangRule>} */
export const LANGS = {
  python: {
    ext: ['.py'],
    resolve: 'path',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(PY_RE)) set.add(m[1] ?? m[2])
      return set
    },
  },

  js: {
    ext: ['.mjs', '.cjs', '.js', '.jsx'],
    resolve: 'path',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(JS_RE)) set.add(m[1])
      return set
    },
  },

  ts: {
    ext: ['.ts', '.tsx'],
    resolve: 'path',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(JS_RE)) set.add(m[1])
      return set
    },
  },

  go: {
    ext: ['.go'],
    // go 의 명세는 **디렉터리**다. `github.com/x/y` 아래 파일이 여럿이다.
    resolve: 'dir',
    extract(text) {
      const set = new Set()
      // 괄호 묶음이 흔하다. 블록을 먼저 훑고 한 줄짜리를 더한다.
      for (const b of text.matchAll(GO_BLOCK_RE)) {
        for (const m of b[1].matchAll(GO_IN_BLOCK_RE)) set.add(m[1])
      }
      for (const m of text.matchAll(GO_ONE_RE)) set.add(m[1])
      return set
    },
  },

  java: {
    ext: ['.java'],
    resolve: 'path',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(JAVA_RE)) {
        const isStatic = Boolean(m[1])
        let spec = m[2]
        // 와일드카드는 패키지 전체를 뜻하므로 파일 하나로 못 푼다 (fail-closed).
        if (spec.endsWith('.*')) continue
        // `import static a.b.C.member;` 의 마지막 마디는 클래스가 아니라 멤버다.
        if (isStatic) spec = spec.slice(0, spec.lastIndexOf('.'))
        if (spec.includes('.')) set.add(spec)
      }
      return set
    },
  },

  rust: {
    ext: ['.rs'],
    resolve: 'path',
    extract(text, filePath) {
      const set = new Set()
      // 자식 모듈이 어디 사는지는 **파일 이름에 달렸다** (rsModuleDir 주석).
      const dir = rsModuleDir(filePath)
      for (const m of text.matchAll(RS_MOD_RE)) {
        // `x.rs` 와 `x/mod.rs` 둘 다 가능하다. 동시에 존재할 수는 없으므로
        // 둘을 다 넘겨도 엣지가 겹치지 않는다 — 해석기가 맞는 쪽만 찾는다.
        set.add(`${dir}${m[1]}`)
        set.add(`${dir}${m[1]}/mod`)
      }
      for (const m of text.matchAll(RS_USE_RE)) {
        for (const spec of rsUseSpecs(m[1], dir)) set.add(spec)
      }
      return set
    },
  },

  /**
   * `.h` 를 c 에 둔다. c++ 프로젝트의 `.h` 도 여기로 오지만, 확장자 하나는
   * 한 언어에만 속해야 하고(EXT_TO_LANG 이 조용히 덮어쓴다) 규칙이 같으므로
   * 엣지 결과는 달라지지 않는다. 코퍼스(ssot.mjs LANG_BY_EXT)도 같은 선택이다.
   */
  c: {
    ext: ['.c', '.h'],
    resolve: 'include',
    extract: cIncludes,
  },

  cpp: {
    ext: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx', '.ipp', '.tcc'],
    resolve: 'include',
    extract: cIncludes,
  },

  ruby: {
    ext: ['.rb'],
    resolve: 'path',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(RB_REL_RE)) {
        const p = m[1].replace(RB_EXT, '')
        // 해석기의 상대 경로 분기는 `.` 으로 시작하고 `/` 를 포함해야 탄다.
        set.add(p.startsWith('.') ? p : `./${p}`)
      }
      for (const m of text.matchAll(RB_REQ_RE)) {
        const p = m[1].replace(RB_EXT, '')
        // 경로 모양만 받는다 (위 주석 — 젬·표준 라이브러리 오탐 방지)
        if (!p.includes('/')) continue
        // 해석기는 점으로 마디를 가른다. `foo/bar` → `foo.bar` → bySuffix('foo/bar')
        set.add(p.split('/').filter(Boolean).join('.'))
      }
      return set
    },
  },

  csharp: {
    ext: ['.cs'],
    /**
     * 🔴 `path` 가 아니라 `ns` 다. `using MyApp.Models;` 는 **네임스페이스**를
     *    부르고 그 안에 파일이 여럿이다. 파일 하나로 풀려고 하면 거의 안 붙는다
     *    (Dapper 실측: 156개 파일에 엣지 1개).
     *
     * 그래서 마디가 하나여도 버리지 않는다 — `using Dapper;` 는 실제로
     * `Dapper/` 디렉터리다. 없는 저장소에서는 아무 데도 안 붙으므로
     * (fail-closed) 남겨도 오탐이 안 는다.
     */
    resolve: 'ns',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(CS_USE_RE)) set.add(m[1])
      return set
    },
  },

  php: {
    ext: ['.php'],
    resolve: 'path',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(PHP_USE_RE)) {
        // 역슬래시를 점으로. 해석기는 점으로 마디를 가른다.
        const d = dotted(m[1].split(String.fromCharCode(92)).filter(Boolean).join('.'))
        if (d) set.add(d)
      }
      for (const m of text.matchAll(PHP_REQ_RE)) {
        const raw = m[1].split(String.fromCharCode(92)).join('/')
        // `__DIR__ . '/x.php'` 는 여는 파일 기준이다. 앞의 `/` 를 떼고 상대로 만든다.
        const rel = raw.startsWith('.') ? raw : `./${raw.replace(/^\//, '')}`
        if (rel.includes('/')) set.add(rel)
      }
      return set
    },
  },

  kotlin: {
    ext: ['.kt', '.kts'],
    resolve: 'path',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(KT_IMPORT_RE)) {
        const d = dotted(m[1])
        if (d) set.add(d)
      }
      return set
    },
  },

  scala: {
    ext: ['.scala'],
    // c# 과 같은 이유로 `ns` 다. 실측(scalaz)에서 import 의 압도적 다수가
    // `import scalaz._` 같은 와일드카드였고, 그건 파일이 아니라 패키지다.
    resolve: 'ns',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(SCALA_IMPORT_RE)) {
        // `import a.b._` 는 패키지 전체 — 뒤의 `._` 를 떼면 그 패키지 경로다.
        // 마디가 하나(`import scalaz._`)여도 버리지 않는다. c# 과 같은 이유로
        // 그것도 디렉터리이고, 없는 저장소에서는 아무 데도 안 붙는다.
        const spec = m[1].replace(/\._?$/, '')
        if (spec) set.add(spec)
      }
      return set
    },
  },

  swift: {
    ext: ['.swift'],
    resolve: 'swift',
    extract(text) {
      const set = new Set()
      for (const m of text.matchAll(SWIFT_IMPORT_RE)) set.add(m[1])
      return set
    },
  },

}

/**
 * c / c++ — `#include`
 *
 * 🔴 두 가지가 다른 언어들과 다르다.
 *
 *   ① 명세가 **확장자를 달고 다닌다** (`"foo.h"`). 점 경로를 마디로 가르는
 *      다른 언어들과 달라서 해석 방식이 따로 필요하다 (`resolve: 'include'`).
 *   ② 같은 따옴표 include 가 저장소마다 **다른 기준**을 쓴다. 작은
 *      프로젝트는 여는 파일 기준(`#include "util.h"`)이고, 큰 프로젝트는
 *      루트 기준이다 — protobuf 의 `#include "google/protobuf/message.h"` 는
 *      `src/google/protobuf/foo.cc` 에서 써도 자기 디렉터리를 안 가리킨다.
 *      둘 다 시도하고, 애매하면 잇지 않는다(해석기 쪽 판단).
 *
 * 🔴 꺾쇠(`<...>`)는 **버린다.**
 *
 *    `<vector>` · `<cstdio>` 는 표준 라이브러리다. 그것을 저장소 파일에
 *    이으려 하면 우연히 이름이 같은 파일에 붙는다. 프로젝트가 자기 헤더를
 *    꺾쇠로 부르는 경우(`-I` 로 잡은 include 디렉터리)를 놓치지만,
 *    **못 잇는 것보다 잘못 잇는 것이 나쁘다** — 신입은 화면에 있는 선을
 *    사실로 읽는다.
 */
/**
 * 스위프트의 `import` 는 **모듈**을 부른다 — 파일이 아니다.
 *
 *   import Foundation                 시스템 모듈
 *   import MyFeature                  같은 저장소의 다른 모듈
 *   @testable import MyFeature        테스트에서
 *   import struct Foundation.Data     한 타입만
 *
 * 마지막 형태 때문에 `struct`·`class` 같은 낱말이 모듈 이름 앞에 온다.
 * 우리가 쓰는 것은 **첫 마디(모듈)뿐**이고 `.Data` 는 버린다 — 파일로 풀리는
 * 것은 모듈까지이기 때문이다.
 */
const SWIFT_IMPORT_RE =
  /^[ \t]*(?:@testable[ \t]+)?import[ \t]+(?:(?:struct|class|enum|protocol|typealias|func|var|let)[ \t]+)?([A-Za-z_]\w*)/gm

const C_INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*"([^"]+)"/gm

function cIncludes(text) {
  const set = new Set()
  for (const m of text.matchAll(C_INCLUDE_RE)) {
    // 윈도우 스타일 구분자를 쓰는 코드가 있다. 색인은 `/` 로만 만든다.
    const spec = m[1].split('\\').join('/').trim()
    if (spec) set.add(spec)
  }
  return set
}

/**
 * 🔴 스위프트는 **모듈까지만** 푼다. 파일 사이의 import 는 이 언어에 없다.
 *
 * 같은 모듈 안의 파일들은 서로를 import 하지 않고 그냥 보인다(접근 제어가
 * 모듈 단위다). 그래서 `import MyModule` 을 아무 파일에나 이으면 그것은
 * 못 잇는 것이 아니라 **없는 관계를 지어내는 것**이다.
 *
 * 그런데 모듈은 실재한다 — SwiftPM 에서 모듈은 `Sources/<이름>/` 이라는
 * **진짜 디렉터리**다. 거기까지는 지어내는 것이 아니라 관측이다. Go 의 패키지·
 * c# 의 네임스페이스에 쓰는 해석과 같고, 같은 상한(GO_PKG_CAP)을 받는다.
 *
 * 세 가지로 fail-closed 를 지킨다 (analyze.mjs 의 `resolveSwift`) —
 *   ① 결과가 `.swift` 파일이 아니면 버린다. 스위프트 모듈은 스위프트다.
 *   ② `Sources/<이름>/`·`src/<이름>/` 처럼 **모듈 뿌리**로 보이는 것을 먼저 쓴다.
 *   ③ 뿌리가 없는데 이름이 애플 프레임워크면 버린다. 저장소 어딘가에 우연히
 *      `Network/` 하위 폴더가 있다고 `import Network` 가 그것일 리 없다.
 *      반대로 `Sources/Network/` 가 있으면 그건 저장소의 진짜 모듈이라 받는다.
 *
 * **아직 못 보는 것** — 같은 모듈 안 파일끼리의 결합. 그건 import 문이 아니라
 * 타입 참조에 있고, 보려면 정규식이 아니라 파서가 필요하다. 그때까지 그 관계는
 * 공변경 축으로만 보인다. 화면에서 "정적 엣지 없음" 이 "관계 없음" 으로 읽히지
 * 않게 하는 것은 confidence 표시의 몫이다.
 */

/** 확장자 → 언어 이름. `LANGS` 에서 파생한다 — 두 곳에 적으면 갈라진다. */
export const EXT_TO_LANG = Object.fromEntries(
  Object.entries(LANGS).flatMap(([name, r]) => r.ext.map((e) => [e, name])),
)

/** import 를 뽑을 수 있는 언어. 표의 열쇠 집합이 곧 이 답이다. */
export const PARSED_LANG = new Set(Object.keys(LANGS))

/**
 * 지금 우리가 읽을 수 있는 언어들 — **측정 기록에 찍는 도장.**
 *
 * 🔴 코퍼스가 이걸 안 찍어서 새 파서가 헛일이 될 뻔했다.
 *
 * `parseCoverage` 는 "이 칸의 저장소에서 내부 import 중 몇 개를 실제로
 * 이었나" 다. 파서가 없는 언어에서는 0 이 나오고, 그 0 은 **결합 판정을
 * 보류시키는 근거**로 쓰인다 — 못 본 것을 "결합이 없다" 로 오해하지 않기
 * 위해서다. 옳은 설계다.
 *
 * 그런데 그 값이 **레코드 1만 2천 개의 평균**이다. 오늘 c·rust·ruby 파서를
 * 붙여도 새 레코드 몇백 개로는 평균이 안 움직이고, 게이트는 영원히 안 열린다.
 * 옛 기록이 "그때 우리가 파서가 없었다" 를 말하는데 화면은 그것을 "이 언어는
 * 결합을 볼 수 없다" 로 읽는다.
 *
 * 그래서 잰 순간의 파서 집합을 레코드에 남긴다. 집계는 **같은 도장끼리만**
 * 평균을 낸다. 표에 언어를 더하면 이 문자열이 저절로 바뀐다 — 손으로 올리는
 * 버전 번호는 반드시 올리는 것을 잊는다.
 */
export const PARSER_VERSION = [...PARSED_LANG].sort().join(',')

/**
 * 본문에서 import 명세를 뽑는다.
 *
 * 🔴 파서가 없는 언어에서는 **아무것도 뽑지 않는다.** JS 정규식을 Java 에
 *    들이대면 조용히 헛것을 잡는다 — 모르는 것은 모른다고 두는 편이 낫다 (D5).
 *
 *    판정은 `lang` 하나로만 한다. 처음엔 `parsed` 플래그를 봤는데, 손으로
 *    파일 객체를 만드는 호출부(테스트 등)가 그 필드를 모르면 조용히 엣지가
 *    통째로 사라졌다. 진실의 출처는 하나여야 한다.
 */
export function extractImports(lang, text, filePath = '') {
  const rule = LANGS[lang]
  if (!rule || typeof text !== 'string') return new Set()
  // 🔴 경로를 함께 넘긴다. 러스트는 **파일 이름에 따라** 자식 모듈이 사는
  //    디렉터리가 달라지므로 본문만으로는 명세를 만들 수 없다 (rsModuleDir).
  return rule.extract(text, filePath)
}

/** 이 언어의 명세가 디렉터리를 가리키나. */
export function resolvesToDir(lang) {
  return LANGS[lang]?.resolve === 'dir'
}

/** 이 언어의 명세를 어떤 방식으로 파일로 바꾸나. 모르는 언어는 null. */
export function resolveKind(lang) {
  return LANGS[lang]?.resolve ?? null
}
