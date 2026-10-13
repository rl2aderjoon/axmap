/**
 * 언어별 import 규칙.
 *
 * 🔴 이 표는 **여러 사람이 동시에 고치는 자리**다. 언어마다 자기 항목만
 *    건드리도록 떼어냈으므로, 한 언어를 추가하다 다른 언어를 깨뜨렸는지
 *    여기서 잡아야 한다.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LANGS, EXT_TO_LANG, PARSED_LANG, extractImports, resolvesToDir, resolveKind, rsModuleDir } from '../app/lib/langs.mjs'

/**
 * 러스트는 **파일 이름에 따라** 자식 모듈이 사는 곳이 달라지므로 경로를
 * 함께 넘길 수 있어야 한다. 다른 언어는 무시한다.
 */
const got = (lang, text, filePath = '') => [...extractImports(lang, text, filePath)].sort()

describe('표의 모양', () => {
  it('언어를 하나 이상 담았다', () => {
    assert.ok(PARSED_LANG.size >= 5, `언어가 ${PARSED_LANG.size}개뿐이다`)
  })

  /**
   * 🔴 `resolve` 목록을 여기 손으로 적어두는 것이 의도다.
   *
   * 새 종류를 더하면 이 테스트가 먼저 깨진다. 그때 `analyze.mjs` 쪽
   * 배선(`resolveKind` 로 갈리는 자리)을 같이 했는지 확인하라는 뜻이다.
   * 표에만 적고 해석기를 안 붙이면 그 언어는 **명세만 뽑고 엣지가 0개**가
   * 되는데, 화면에서는 "이 저장소는 결합이 없다" 로 보인다.
   */
  const KINDS = ['path', 'dir', 'include', 'ns', 'swift']

  it('모든 항목이 ext · resolve · extract 를 갖는다', () => {
    for (const [name, r] of Object.entries(LANGS)) {
      assert.ok(Array.isArray(r.ext) && r.ext.length, `${name}: ext 가 없다`)
      assert.ok(KINDS.includes(r.resolve), `${name}: resolve 가 ${r.resolve} — 해석기는 붙였나?`)
      assert.equal(typeof r.extract, 'function', `${name}: extract 가 없다`)
    }
  })

  it('🔴 확장자가 두 언어에 겹치지 않는다', () => {
    // 겹치면 EXT_TO_LANG 이 조용히 한쪽을 덮어쓰고, 그 언어의 파서가 통째로 죽는다
    const seen = new Map()
    for (const [name, r] of Object.entries(LANGS)) {
      for (const e of r.ext) {
        assert.equal(seen.get(e), undefined, `${e} 를 ${seen.get(e)} 와 ${name} 이 함께 주장한다`)
        seen.set(e, name)
      }
    }
  })

  it('EXT_TO_LANG 이 표에서 파생된다', () => {
    assert.equal(EXT_TO_LANG['.go'], 'go')
    assert.equal(EXT_TO_LANG['.tsx'], 'ts')
    assert.equal(EXT_TO_LANG['.없는것'], undefined)
  })
})

describe('python', () => {
  it('두 형태를 다 뽑는다', () => {
    assert.deepEqual(got('python', 'from a.b import c\nimport d.e\n'), ['a.b', 'd.e'])
  })
  it('들여쓴 import 도 잡는다', () => {
    assert.deepEqual(got('python', '    import lazy.mod\n'), ['lazy.mod'])
  })
})

describe('js / ts', () => {
  it('상대 경로만 뽑는다 — 외부 패키지는 이 그래프에 뜻이 없다', () => {
    const t = "import x from './a'\nimport y from 'react'\nfrom '../b'"
    assert.deepEqual(got('js', t), ['../b', './a'])
  })
  it('ts 도 같은 규칙을 쓴다', () => {
    assert.deepEqual(got('ts', "import {A} from './a'"), ['./a'])
  })
})

describe('go', () => {
  it('괄호 묶음과 한 줄짜리를 모두 뽑는다', () => {
    const t = 'import "solo"\nimport (\n\t"fmt"\n\talias "github.com/x/y"\n\t_ "blank/one"\n)\n'
    assert.deepEqual(got('go', t), ['blank/one', 'fmt', 'github.com/x/y', 'solo'])
  })
  it('명세가 디렉터리를 가리킨다', () => {
    // go 만 하나가 여럿으로 풀린다. 이 플래그가 틀리면 엣지가 통째로 어긋난다.
    assert.equal(resolvesToDir('go'), true)
    assert.equal(resolvesToDir('python'), false)
  })
})

describe('java', () => {
  it('static 은 멤버를 떼고 클래스까지만', () => {
    assert.deepEqual(got('java', 'import static a.b.C.member;'), ['a.b.C'])
  })
  it('🔴 와일드카드는 잇지 않는다 — 파일 하나로 못 푼다', () => {
    assert.deepEqual(got('java', 'import a.b.*;'), [])
  })
  it('마디가 하나면 버린다', () => {
    assert.deepEqual(got('java', 'import Single;'), [])
  })
})

describe('🔴 모르는 언어에서는 아무것도 뽑지 않는다', () => {
  /**
   * JS 정규식을 Ruby 에 들이대면 조용히 헛것을 잡는다. 모르는 것은 모른다고
   * 두는 편이 낫다 (D5). 파서를 추가하기 전까지 이 테스트가 그것을 지킨다.
   */
  it('표에 없는 언어는 빈 집합', () => {
    // 🔴 목록을 손으로 적지 않는다. **표에서 파생한다.**
    //
    // 처음에는 ['ruby','php','swift','rust',...] 로 박아뒀는데, 이 파일은
    // 여러 사람이 언어를 더하는 자리다. rust·ruby 를 표에 넣는 순간
    // "표에 없다" 는 전제가 거짓이 되어 이 테스트가 깨졌다.
    // 지키려는 성질은 "표에 없으면 아무것도 안 나온다" 이지 특정 언어 이름이 아니다.
    const notInTable = ['php', 'swift', 'csharp', 'kotlin', 'scala', 'haskell', null, undefined]
      .filter((l) => !LANGS[l])
    assert.ok(notInTable.length >= 3, '표에 없는 언어 예시가 모자라다')
    for (const l of notInTable) {
      assert.equal(extractImports(l, 'require \"x\"\nuse a::b;\n#include <y>').size, 0, String(l))
    }
  })

  it('본문이 문자열이 아니면 빈 집합', () => {
    assert.equal(extractImports('python', null).size, 0)
    assert.equal(extractImports('python', 42).size, 0)
  })
})

describe('rust', () => {
  it('`mod x;` 는 파일 선언이다 — x.rs 와 x/mod.rs 둘 다 후보', () => {
    // 러스트는 이 줄이 있어야 파일이 빌드에 들어간다. 추측이 아니라 사실이라
    // 이것만으로도 모듈 트리가 통째로 나온다.
    assert.deepEqual(got('rust', 'mod config;\npub mod util;\n'),
      ['./config', './config/mod', './util', './util/mod'])
  })

  it('🔴 인라인 모듈은 파일이 아니다', () => {
    // `mod x { ... }` 는 같은 파일 안에 있다. 엣지를 만들면 자기 자신을 가리킨다.
    assert.deepEqual(got('rust', 'mod inline { fn x() {} }\n'), [])
  })

  it('🔴 마지막 마디가 타입이면 떼어낸다', () => {
    // `use crate::config::Config` 에서 Config 는 파일이 아니다. 안 떼면
    // `config/Config` 를 찾다가 아무 데도 못 붙는다 — 가장 흔한 형태를 통째로 잃는다.
    assert.deepEqual(got('rust', 'use crate::config::Config;\n'), ['config'])
    assert.deepEqual(got('rust', 'use crate::a::b::Thing;\n'), ['a', 'a.b'])
  })

  it('🔴 `super::x` 는 같은 디렉터리다 — 한 단계 위가 아니다', () => {
    // src/a/b.rs 는 모듈 a::b 이고 super 는 모듈 a 인데, a 의 자식 파일은
    // src/a/ 에 산다 — b.rs 자신이 있는 곳이다.
    // 처음에 '../' 로 썼다가 형제가 아니라 삼촌을 가리키고 있었다.
    assert.ok(got('rust', 'use super::sibling;', 'src/a/b.rs').includes('./sibling'))
    assert.ok(got('rust', 'use super::super::grand::Thing;', 'src/a/b.rs').includes('../grand'))
  })

  it('self:: 는 이 파일의 자식 모듈', () => {
    assert.ok(got('rust', 'use self::helper::run;', 'src/a/mod.rs').includes('./helper'))
  })

  it('🔴 마디가 하나인 외부 크레이트는 버린다', () => {
    // `use serde;` 를 넘기면 해석기의 단일 마디 분기가 "저장소에 이름이
    // 유일하면" 이어버려, 우연히 있는 serde.rs 에 붙는다.
    assert.deepEqual(got('rust', 'use serde;\nuse anyhow;\n'), [])
  })

  it('외부 크레이트의 접두사는 넘기지 않는다', () => {
    // std 를 넘기면 저장소에 std.rs 가 있을 때 붙는다. 내부 뿌리에만 접두사를 낸다.
    const r = got('rust', 'use std::collections::HashMap;\n')
    assert.ok(!r.includes('std'), `std 가 새어 나왔다: ${r}`)
  })

  it('별칭과 중괄호를 벗긴다', () => {
    assert.deepEqual(got('rust', 'use crate::x::y as z;\n'), ['x', 'x.y'])
    assert.deepEqual(got('rust', 'use crate::a::{b, c};\n'), ['a'])
  })
})

describe('ruby', () => {
  it('require_relative 는 이 파일 기준 경로다', () => {
    assert.deepEqual(got('ruby', "require_relative 'helper'\n"), ['./helper'])
    assert.deepEqual(got('ruby', "require_relative '../lib/thing'\n"), ['../lib/thing'])
  })

  it('확장자를 떼어낸다 — 색인이 확장자 없이 만들어진다', () => {
    assert.deepEqual(got('ruby', "require_relative 'thing.rb'\n"), ['./thing'])
  })

  it('🔴 마디가 하나인 require 는 버린다 — 젬·표준 라이브러리다', () => {
    // `require 'logger'` 를 넘기면 우리 app/logger.rb 에 붙는다.
    // 실제로 파이썬에서 같은 유형(rclpy.qos)이 가짜 엣지 7개를 만들었다.
    assert.deepEqual(got('ruby', "require 'json'\nrequire 'set'\nrequire 'logger'\n"), [])
  })

  it('경로 모양인 require 는 점 경로로 넘긴다', () => {
    // 해석기는 점으로 마디를 가르고 꼬리가 통째로 맞아야 붙인다(bySuffix).
    // 그래서 외부 젬은 저장소에 그 경로가 없어 자연히 안 붙는다.
    assert.deepEqual(got('ruby', "require 'my_app/models/user'\n"), ['my_app.models.user'])
  })

  it('require_relative 를 require 로 오인하지 않는다', () => {
    // `^\s*require\s+` 는 require_relative 뒤에 공백이 없어 안 걸린다.
    // 걸렸다면 './helper' 대신 'helper' 가 섞여 나온다.
    assert.deepEqual(got('ruby', "require_relative 'helper'\n"), ['./helper'])
  })
})

describe('swift', () => {
  it('모듈 이름만 뽑는다 — 파일이 아니다', () => {
    assert.deepEqual(got('swift', 'import MyFeature\n'), ['MyFeature'])
  })

  it('@testable 을 넘어간다 — 테스트가 부르는 것도 부르는 것이다', () => {
    assert.deepEqual(got('swift', '@testable import MyFeature\n'), ['MyFeature'])
  })

  it('한 타입만 부르는 형태에서도 모듈을 집는다', () => {
    // import struct Foundation.Data → 모듈은 Foundation 이고 .Data 는 버린다.
    assert.deepEqual(got('swift', 'import struct Foundation.Data\n'), ['Foundation'])
    assert.deepEqual(got('swift', 'import class UIKit.UIView\n'), ['UIKit'])
  })

  it('점 뒤 하위 모듈은 버린다 — 파일로 풀리는 것은 모듈까지다', () => {
    assert.deepEqual(got('swift', 'import A.B.C\n'), ['A'])
  })

  it('🔴 주석 안의 import 를 집지 않는다', () => {
    assert.deepEqual(got('swift', '// import Ghost\n *  import Ghost2\n'), [])
  })
})

describe('🔴 언어를 더해도 서로를 깨뜨리지 않는다', () => {
  it('확장자가 겹치지 않는다', () => {
    const seen = new Map()
    for (const [name, r] of Object.entries(LANGS)) {
      for (const e of r.ext) {
        assert.equal(seen.get(e), undefined, `${e} 를 ${seen.get(e)} 와 ${name} 이 함께 주장한다`)
        seen.set(e, name)
      }
    }
  })

  it('한 언어의 본문이 다른 언어에서 엣지를 만들지 않는다', () => {
    // 남의 정규식을 들이대면 조용히 헛것을 잡는다 (D5).
    const rs = 'mod config;\nuse crate::a::B;\n'
    const rb = "require_relative 'x'\nrequire 'a/b'\n"
    assert.deepEqual(got('python', rs), [])
    assert.deepEqual(got('go', rb), [])
    assert.deepEqual(got('java', rs), [])
    assert.deepEqual(got('rust', rb), [])
    assert.deepEqual(got('ruby', rs), [])
  })
})

describe('c / c++', () => {
  it('따옴표 include 를 뽑는다', () => {
    assert.deepEqual(got('c', '#include "foo.h"\n#include "sub/bar.h"\n'), ['foo.h', 'sub/bar.h'])
  })

  it('# 과 include 사이의 공백을 허용한다', () => {
    // `#  include` 는 드물지만 유효하다. 조건부 컴파일 블록 안에서 들여쓴다.
    assert.deepEqual(got('c', '  #  include   "a.h"'), ['a.h'])
  })

  it('🔴 꺾쇠는 버린다 — 못 잇는 것보다 잘못 잇는 것이 나쁘다', () => {
    /**
     * `<vector>` 를 저장소 파일에 이으려 하면 우연히 이름이 같은 파일에 붙는다.
     * 신입은 화면에 있는 선을 사실로 읽으므로, 없는 관계를 그리면 안 된다.
     */
    assert.deepEqual(got('cpp', '#include <vector>\n#include <sys/types.h>\n#include "mine.h"'), ['mine.h'])
  })

  it('윈도우 구분자를 슬래시로 바꾼다 — 색인은 슬래시로만 만든다', () => {
    // 리터럴 역슬래시를 소스에 쓰면 이스케이프가 층층이 꼬인다. 코드로 만든다.
    const BS = String.fromCharCode(92)
    assert.deepEqual(got('c', `#include "sub${BS}dir${BS}x.h"`), ['sub/dir/x.h'])
  })

  it('c 와 c++ 이 같은 규칙을 쓴다', () => {
    const t = '#include "x.h"'
    assert.deepEqual(got('c', t), got('cpp', t))
  })

  it('.h 는 c 에 속한다 — 확장자 하나는 한 언어에만', () => {
    // c++ 프로젝트의 .h 도 여기로 오지만 규칙이 같아 엣지 결과는 안 달라진다.
    assert.equal(EXT_TO_LANG['.h'], 'c')
    assert.equal(EXT_TO_LANG['.hpp'], 'cpp')
  })

  it('include 는 자기 해석 방식을 쓴다', () => {
    // 점으로 마디를 가르는 길로 가면 google/protobuf/message/h 가 된다
    assert.equal(resolveKind('c'), 'include')
    assert.equal(resolveKind('cpp'), 'include')
  })

  it('주석 안의 include 는 못 거른다 — 알려진 한계', () => {
    // 🔴 지어내지 않는다. 정규식은 전처리기를 모른다. `#if 0` 안이나 주석 안의
    //    include 도 잡힌다. 실측에서 문제가 될 만큼 흔하지 않아 두지만,
    //    "안 잡는다" 고 적어두면 그게 거짓말이 된다.
    assert.deepEqual(got('c', '#if 0\n#include "dead.h"\n#endif'), ['dead.h'])
  })
})

describe('🔴 rust 2018 — 자식 모듈이 어디 사는가', () => {
  /**
   * 실측(tokio)에서 잡은 오답이다. `src/runtime/context.rs` 가
   * `mod blocking;` 으로 자기 자식(`context/blocking.rs`)을 선언하는데,
   * 같은 디렉터리로 풀면 **무관한 `runtime/blocking/mod.rs` 가 실제로 있어서**
   * 거기 선이 붙었다. 못 이은 것이 아니라 틀리게 이은 것이라 더 나쁘다.
   * 같은 저장소의 `mod tests;` 21건은 아예 놓쳤다.
   */
  it('foo.rs 의 자식은 foo/ 안에 산다', () => {
    assert.deepEqual(got('rust', 'mod blocking;', 'src/runtime/context.rs'),
      ['./context/blocking', './context/blocking/mod'])
  })

  it('mod.rs 의 자식은 같은 디렉터리에 산다', () => {
    assert.deepEqual(got('rust', 'mod x;', 'src/a/mod.rs'), ['./x', './x/mod'])
  })

  it('크레이트 뿌리의 자식도 같은 디렉터리', () => {
    for (const p of ['src/lib.rs', 'src/main.rs']) {
      assert.deepEqual(got('rust', 'mod x;', p), ['./x', './x/mod'], p)
    }
  })

  it('🔴 tests·benches·examples·src/bin 바로 아래도 크레이트 뿌리다', () => {
    // 카고가 각각을 독립 크레이트로 빌드한다. ripgrep 의 tests/tests.rs 가
    // mod util; 로 tests/util.rs 를 가리키는 것이 이 경우다.
    for (const p of ['tests/tests.rs', 'benches/b.rs', 'examples/e.rs', 'src/bin/x.rs']) {
      assert.deepEqual(got('rust', 'mod util;', p), ['./util', './util/mod'], p)
    }
  })

  it('경로를 모르면 같은 디렉터리로 둔다 — 없는 하위 디렉터리를 지어내지 않는다', () => {
    assert.deepEqual(got('rust', 'mod x;'), ['./x', './x/mod'])
    assert.equal(rsModuleDir(''), './')
    assert.equal(rsModuleDir(null), './')
  })

  it('self / super 가 파일 종류에 따라 갈린다', () => {
    // src/a.rs 는 모듈 a — 자식은 src/a/, super(크레이트 뿌리)는 src/
    assert.ok(got('rust', 'use self::w::W;', 'src/a.rs').includes('./a/w'))
    assert.ok(got('rust', 'use super::y::Z;', 'src/a.rs').includes('./y'))
    // src/a/mod.rs 도 모듈 a — 자식은 src/a/, super 는 src/
    assert.ok(got('rust', 'use self::w::W;', 'src/a/mod.rs').includes('./w'))
    assert.ok(got('rust', 'use super::y::Z;', 'src/a/mod.rs').includes('../y'))
  })
})

describe('c# · php · kotlin · scala', () => {
  const BS = String.fromCharCode(92)

  it('c# — using 에서 네임스페이스를 뽑는다', () => {
    assert.deepEqual(got('csharp', 'using MyApp.Models;\nusing static A.B;\nusing Alias = X.Y;'),
      ['A.B', 'MyApp.Models', 'X.Y'])
  })

  it('🔴 c# — 마디가 하나여도 버리지 않는다 (네임스페이스는 디렉터리다)', () => {
    /**
     * 처음에는 자바처럼 "마디가 하나면 위험하다" 로 버렸다. 그랬더니 Dapper
     * 에서 파일 156개에 엣지가 **1개**였다 — `using Dapper;` 가 실은
     * `Dapper/` 디렉터리인데 통째로 버려지고 있었다.
     *
     * 디렉터리로 푸는 쪽(`resolve: 'ns'`)에서는 없는 디렉터리면 아무 데도
     * 안 붙으므로(fail-closed) 남겨도 오탐이 안 는다.
     */
    assert.deepEqual(got('csharp', 'using System;\nusing Xunit;'), ['System', 'Xunit'])
    assert.equal(resolveKind('csharp'), 'ns')
  })

  it('php — 네임스페이스와 require 를 둘 다 뽑는다', () => {
    const src = [
      `use App${BS}Models${BS}User;`,
      `use function App${BS}helpers${BS}fmt;`,
      `require_once __DIR__ . '/../lib/db.php';`,
      `require "vendor/autoload.php";`,
    ].join('\n')
    assert.deepEqual(got('php', src),
      ['./../lib/db.php', './vendor/autoload.php', 'App.Models.User', 'App.helpers.fmt'])
  })

  it('php — 묶음 use 는 앞쪽 공통 경로까지만', () => {
    // 안쪽까지 펼치면 각 마디가 네임스페이스인지 클래스인지 못 가린다
    assert.deepEqual(got('php', `use App${BS}{A, B};`), [])
  })

  it('kotlin — 세미콜론 없이도 잡고 와일드카드는 버린다', () => {
    assert.deepEqual(got('kotlin', 'import com.example.Foo\nimport com.example.*\nimport a.b.Bar as Baz'),
      ['a.b.Bar', 'com.example.Foo'])
  })

  it('scala — 와일드카드는 버리지 않고 패키지로 본다', () => {
    // scalaz 실측: import 의 압도적 다수가 `import scalaz._` 꼴이었다.
    // 그걸 버리면 569개 파일에 엣지 22개가 된다.
    assert.deepEqual(got('scala', 'import a.b.C\nimport a.b._\nimport scalaz._'),
      ['a.b', 'a.b.C', 'scalaz'])
    assert.equal(resolveKind('scala'), 'ns')
  })

  /**
   * 🔴 **이 테스트는 뒤집힌 결정을 못박는다.** 전에는 정반대였다 —
   * `swift 는 일부러 없다`. 통과가 늘어나는 변경이므로 근거를 남긴다.
   *
   * 옛 근거: 스위프트에는 **파일 사이의 import 가 없다.** 같은 모듈의 파일은
   * 서로를 부르지 않고 그냥 보인다(접근 제어가 모듈 단위다). 그래서
   * `import MyModule` 을 파일로 풀면 없는 관계를 지어내는 것이다 — 맞는 말이다.
   *
   * 바뀐 것: 그 논증은 **파일**에 대해서만 맞다. SwiftPM 에서 모듈은
   * `Sources/<이름>/` 이라는 **진짜 디렉터리**이고, 거기까지 푸는 것은
   * 지어내기가 아니라 관측이다. Go 의 패키지·c# 의 네임스페이스에 이미 쓰는
   * 해석과 같은 것이고 같은 상한(GO_PKG_CAP)을 받는다.
   *
   * 계기: 코퍼스 스냅샷에서 13개 언어가 파싱 커버리지 90~100% 인데 swift 만
   * 4.9% 로 남았다. 그 0 에 가까운 숫자가 화면에서는 "이 저장소는 결합이 없다"
   * 로 읽힌다 — 우리가 제일 하지 않기로 한 거짓말이다.
   *
   * **여전히 안 하는 것**: 같은 모듈 안 파일끼리의 결합. 그건 import 문이 아니라
   * 타입 참조에 있고 정규식으로는 못 본다. 그 관계는 공변경 축으로만 보인다.
   */
  it('🔴 swift 는 모듈까지만 푼다 — 파일이 아니라 디렉터리로', () => {
    assert.equal(PARSED_LANG.has('swift'), true)
    assert.equal(EXT_TO_LANG['.swift'], 'swift')

    // 모듈 이름만 나온다. `Foundation` 도 여기서는 버리지 않는다 — 버릴지 말지는
    // 해석기(resolveSwift)가 저장소를 보고 정한다. 명세 단계에서 미리 버리면
    // `Sources/Foundation/` 을 가진 저장소에서 틀린다.
    assert.deepEqual([...extractImports('swift', 'import Foundation\nimport MyModule')].sort(),
      ['Foundation', 'MyModule'])

    // 🔴 전용 해석기가 붙어 있어야 한다. 'path' 로 떨어지면 모듈 이름을
    //    파일 이름으로 착각해 아무 파일에나 붙는다 — 옛 결정이 막으려던 바로 그것.
    assert.equal(resolveKind('swift'), 'swift')
    assert.equal(resolvesToDir('swift'), false)
  })
})
