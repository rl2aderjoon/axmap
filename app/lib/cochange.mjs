/**
 * 공변경(co-change) — git 히스토리에서 "실제로 함께 바뀐" 엣지를 뽑는다.
 *
 * 정적 파싱은 "코드가 무엇을 참조한다고 적혀 있나"를 답한다.
 * 리뷰가 답해야 하는 질문은 "이걸 고치면 무엇을 같이 고쳐야 하나"다.
 * 둘은 겹치지만 같지 않고, **겹치지 않는 부분이 사고가 나는 자리**다.
 *
 * D5 의 세 번째 출처다. 정적 파싱(좁고 확실) · LLM 독해(넓고 검증 필요) 옆에
 * 히스토리(결정론적이고 값싸지만 새 코드에 침묵)를 놓는다.
 * 세 출처의 실패 방식이 서로 달라서, 둘이 합의한 엣지는 훨씬 믿을 만하다.
 *
 * 외부 의존성 0. git 과 node 만 쓴다.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 커밋 하나가 이보다 많은 파일을 건드렸으면 버린다. */
export const MAX_FILES_PER_COMMIT = 50
/** 이보다 적게 함께 바뀐 쌍은 엣지로 치지 않는다. */
export const MIN_SUPPORT = 3

/**
 * 커밋 크기 필터의 근거.
 *
 * 대량 rename, 일괄 포맷팅, 작업본 통째 반입 커밋은 파일 수백 개를 한 번에 건드린다.
 * 그 안의 파일들이 서로 결합되어 있다는 정보는 **0** 이다. 같은 날 같이 들어왔을 뿐이다.
 * 그런데 쌍은 N(N-1)/2 로 늘어나므로, 그런 커밋 하나가 전체 쌍의 절반을 만들기도 한다.
 * 실측(e101): 454파일 커밋 하나가 102,831쌍 = 전체의 48%.
 *
 * 🔴 이 필터는 결과를 바꾼다. 성능 최적화가 아니라 **의미 판단**이다.
 *    임계값을 옮길 때는 왜 옮기는지 근거를 남긴다.
 */

/**
 * 빈도 사전 가지치기의 근거 — 이쪽은 반대로 **무손실**이다.
 *
 *   support(A,B) <= min(count(A), count(B))
 *
 * 어떤 파일이 전체에서 2번만 바뀌었다면, 그 파일이 낀 어떤 쌍도 support 3 을 넘을 수 없다.
 * 그러니 쌍을 만들기 *전에* 지워도 최종 결과가 같다. (Apriori 하향 폐쇄성)
 * 파일 빈도가 롱테일이라 실제로 크게 먹는다 — 실측에서 파일 93% 가 사라지고 답은 동일했다.
 */

function git(root, args) {
  return execFileSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  })
}

/**
 * 커밋별 파일 집합. 머지 커밋은 제외한다 — 머지는 저자가 고른 변경이 아니다.
 *
 * 🔴 `git log --name-only` 는 **저장소 루트 기준** 경로를 준다.
 *    뷰어를 하위 디렉터리로 열면(`node app/server.mjs <repo>/server`) 노드 ID 는
 *    그 디렉터리 기준이라 그대로는 하나도 안 맞는다. 조용히 엣지 0개가 되고
 *    "히스토리가 없다"는 틀린 결론이 나온다. 접두사를 떼서 맞춘다.
 */
/**
 * 이 저장소가 blob 을 지연 로딩하는가 (`git clone --filter=blob:none`).
 *
 * 왜 물어보나. git 은 diff 를 만들 때 rename 을 탐지하는데, 유사도를 재려면
 * **파일 내용(blob)** 이 필요하다. blobless 클론에는 blob 이 없으므로
 * 커밋마다 원격으로 가지러 간다.
 *
 * 실측(expressjs/express, 통제 실험):
 *   기본(rename 탐지)   37,166 ms   팩 1 → 64개, 84KB 페치
 *   --no-renames           121 ms   팩 1 → 1개,  페치 0
 *   **307배.**
 */
/**
 * blobless(부분) 클론인가.
 *
 * 🔴 `remote.origin` 만 보면 안 된다. **원격 이름이 바뀌면 판정이 깨진다.**
 *
 * 벤치 2회차에서 물렸다. 평가 저장소의 `origin` 을 장부용 로컬 베어 저장소로
 * 바꿔 달았더니 `remote.origin.promisor` 가 사라졌고, 이 함수가 false 를
 * 돌려줘 rename 탐지가 켜졌다. blobless 클론에서 rename 을 켜면 없는 blob 을
 * 읽으려다 `fatal: unable to read <sha>` 로 죽는다.
 *
 * 그 결과 `readCommitSets` 가 null 이 되고, 화면은 **"히스토리 부족"** 이라고
 * 말했다. 사실은 부족한 게 아니라 **명령이 실패한** 것이다.
 * 같은 서버가 `/api/featuregraph` 에서는 커밋을 멀쩡히 세고 있었으므로,
 * 화면끼리 서로 다른 답을 했다 — 벤치의 신입이 그 불일치를 잡아냈다.
 *
 * `extensions.partialclone` 은 저장소 수준 설정이라 원격 이름과 무관하다.
 * 그것을 먼저 보고, 없으면 원격별 promisor 를 **전부** 훑는다.
 */
function isBlobless(root) {
  try {
    if (git(root, ['config', '--get', 'extensions.partialclone']).trim()) return true
  } catch { /* 없으면 아래로 */ }
  try {
    return git(root, ['config', '--get-regexp', '^remote\\..*\\.promisor'])
      .split('\n').some((l) => l.trim().endsWith('true'))
  } catch {
    return false
  }
}

/**
 * 우리가 노드로 만들 수 있었을 확장자인가.
 *
 * 커버리지를 잴 때 이 구분이 없으면 숫자가 거짓말을 한다.
 * flask 에는 `.rst` 가 79개 있는데 그건 애초에 그래프에 안 들어간다.
 * 그것까지 "못 본 히스토리"로 세면 커버리지가 실제보다 훨씬 나빠 보이고,
 * rename 문제와 "코드 파일이 아님"이 한 숫자에 섞인다.
 */
const CODE_LIKE = /\.(py|mjs|cjs|js|jsx|ts|tsx|java|kt|go|rs|rb|php|cs|swift)$/i

/**
 * 커밋별 파일 목록을 그대로 읽는다. 거르지 않는다.
 *
 * 비코드 파일을 노드로 올릴지 판단하려면(datanodes.mjs) **거르기 전** 목록이
 * 필요하다. 그리고 git 로그를 두 번 읽지 않으려고 결과를 재사용한다.
 */
/**
 * 마지막 실패 이유. `readCommitSets` 가 null 을 돌려준 뒤 호출부가 읽는다.
 *
 * ⚠️ 모듈 수준 상태다. 한 프로세스에서 저장소 하나만 보는 지금 구조에서는
 *    안전하지만, 여러 저장소를 동시에 다루게 되면 인자로 바꿔야 한다.
 */
let lastError = null
export const lastCommitSetsError = () => lastError

export function readCommitSets(root) {
  return commitSets(root, () => true)
}

function commitSets(root, keep) {
  let raw, prefix
  const blobless = isBlobless(root)
  try {
    // show-prefix 는 저장소 루트에서 실행하면 빈 문자열, 하위에서는 'server/' 같은 값
    prefix = git(root, ['rev-parse', '--show-prefix']).trim()
    raw = git(root, [
      'log', '--pretty=format:@', '--name-only', '--no-merges',
      // 🔴 이건 성능 대책이 아니라 **의미 판단**이다.
      //
      // rename 을 탐지하면 파일이 이름을 바꿔도 히스토리가 이어진다 —
      // 공변경 입장에서는 그게 더 정확하다. 그래서 blob 이 있는 보통 클론에서는
      // 켜 둔다(git 기본값).
      //
      // 그런데 blobless 클론에서는 켜 두면 커밋마다 네트워크를 타서 307배가 된다.
      // 그 상태로는 아예 못 돌린다. 그러니 여기서는 "정확도를 조금 잃고 돌아가는 것"과
      // "정확한데 안 돌아가는 것" 중에 앞을 고른다.
      //
      // 잃는 것: rename 된 파일은 add + delete 로 보여서 그 지점에서 히스토리가 끊긴다.
      // 즉 **공변경 엣지가 줄어든다** — fail-closed 쪽이라 조용히 잘못 통과시키지는 않는다.
      ...(blobless ? ['--no-renames'] : []),
    ])
  } catch (e) {
    /**
     * 🔴 **왜** 실패했는지를 남긴다. 화면이 "히스토리 부족" 이라고 말하면 안 된다.
     *
     * 벤치 2회차에서 신입이 잡았다. 같은 서버가 `/api/overlay` 에서는
     * "커밋 0개 · 히스토리 부족" 이라 하고 `/api/featuregraph` 에서는 커밋을
     * 멀쩡히 세고 있었다. 화면끼리 서로 다른 답을 한 것이다.
     *
     * 진짜 원인은 `git log` 가 `fatal: unable to read <sha>` 로 죽은 것이었다.
     * 히스토리는 있었다. **우리가 못 읽은 것을 없는 것으로 말했다.**
     *
     * 원인을 안 남기면 다음 사람이 "이 저장소는 커밋이 적구나" 로 읽고 끝난다.
     */
    lastError = (e?.message ?? String(e)).split(/\r?\n/).slice(0, 2).join(' ').slice(0, 300)
    return null
  }
  const sets = []
  let cur = null
  /**
   * 히스토리에는 있는데 지금 트리에는 없는 경로.
   *
   * 🔴 이 수치를 화면에 내보내지 않으면 도구가 확신 있게 틀린 숫자를 보여준다.
   *
   * flask 에서 실측된 상황이다. 2019년에 `flask/` → `src/flask/` 로 옮겼는데,
   * 노드 id 는 `src/flask/app.py` 이고 5,556 커밋 중 대부분은 `flask/app.py` 로
   * 기록돼 있다. 그래서 여기서 전부 버려진다.
   *
   *   git log -- src/flask/app.py            135
   *   git log --follow -- src/flask/app.py   487   ← 진짜
   *   화면 표시                              136
   *
   * **3.6배 낮은 숫자를 아무 단서 없이 보여줬다.** `--follow` 는 경로 하나에만
   * 쓸 수 있어서 전체 히스토리에는 못 건다. 그러니 최소한 "얼마나 못 봤는지"는
   * 말해야 한다 — 모르는 것을 모른다고 말하는 것이 이 도구의 규칙이다 (D5).
   */
  const unknownPaths = new Set()
  let unknownHits = 0
  let knownHits = 0
  for (const line of raw.split('\n')) {
    if (line.startsWith('@')) { cur = []; sets.push(cur); continue }
    let f = line.trim()
    if (!f || !cur) continue
    if (prefix) {
      if (!f.startsWith(prefix)) continue // 범위 밖 파일
      f = f.slice(prefix.length)
    }
    if (keep(f)) { cur.push(f); knownHits++; continue }
    // 코드 파일인데 트리에 없다 = rename 되었거나 삭제되었다.
    // 그 외(문서·설정·이미지)는 원래 노드가 아니므로 커버리지에서 뺀다.
    if (CODE_LIKE.test(f)) { unknownPaths.add(f); unknownHits++ }
  }
  const out = sets.map((s) => [...new Set(s)]).filter((s) => s.length > 0)
  out.coverage = {
    knownHits,
    unknownHits,
    unknownPaths: unknownPaths.size,
    // **코드 파일 언급 중** 몇 %가 지금 트리에 있는 파일이었나.
    // 낮으면 rename·삭제가 많았다는 뜻이고, 그만큼 공변경이 실제보다 적게 나온다.
    // 문서·설정은 분모에서 뺐다 — 그건 못 본 게 아니라 원래 안 보는 것이다.
    ratio: knownHits + unknownHits > 0 ? +(knownHits / (knownHits + unknownHits)).toFixed(3) : 1,
  }
  return out
}

/**
 * 공변경 엣지를 만든다.
 *
 * @param {string} root 저장소 경로
 * @param {Set<string>} nodeIds 그래프에 실제로 있는 노드만 센다 (지워진 파일은 제외)
 * @returns {{edges:object[], freq:Map<string,number>, stats:object}|null}
 */
export function coChange(root, nodeIds, {
  maxFiles = MAX_FILES_PER_COMMIT,
  minSupport = MIN_SUPPORT,
  raw = null,   // readCommitSets() 결과를 넘기면 git 로그를 다시 안 읽는다
} = {}) {
  let sets
  if (raw) {
    // 미리 읽은 것을 노드 기준으로 거른다. 커버리지 통계는 그대로 물려받는다.
    const cov = raw.coverage
    sets = raw.map((s) => s.filter((f) => nodeIds.has(f))).filter((s) => s.length)
    sets.coverage = cov
  } else {
    sets = commitSets(root, (f) => nodeIds.has(f))
  }
  if (!sets) return null

  // 1차 패스 — 파일별 등장 커밋 수. 키가 파일이라 값싸다.
  const freq = new Map()
  for (const s of sets) for (const f of s) freq.set(f, (freq.get(f) ?? 0) + 1)

  // 2차 패스 — 쌍. 여기서만 데이터가 불어난다.
  const pair = new Map()
  let droppedBig = 0
  let pairsNoPrune = 0
  let pairsEmitted = 0
  for (let s of sets) {
    if (s.length > maxFiles) { droppedBig++; continue }
    pairsNoPrune += (s.length * (s.length - 1)) / 2
    s = s.filter((f) => freq.get(f) >= minSupport).sort()
    for (let i = 0; i < s.length; i++) {
      for (let j = i + 1; j < s.length; j++) {
        // 무순서 쌍이므로 정렬해 표준형으로 만든다. A|B 와 B|A 가 다른 키가 되면
        // 같은 사실이 두 곳에 나뉘어 센다. 구분자는 경로에 절대 못 들어가는 널 바이트.
        const k = `${s[i]}\0${s[j]}`
        pair.set(k, (pair.get(k) ?? 0) + 1)
        pairsEmitted++
      }
    }
  }

  const N = sets.length || 1
  const edges = []
  for (const [k, sup] of pair) {
    if (sup < minSupport) continue
    const [a, b] = k.split('\0')
    const fa = freq.get(a), fb = freq.get(b)
    edges.push({
      source: a,
      target: b,
      support: sup,
      // 신뢰도는 비대칭이다. 분자는 하나고 분모만 둘이다.
      // "A 를 고치면 B 도 고칠 확률" 과 그 역은 다른 질문이다.
      confA: +(sup / fa).toFixed(3),
      confB: +(sup / fb).toFixed(3),
      // lift 는 "우연히 같이 바뀔 확률 대비 몇 배인가".
      // 자주 바뀌는 파일(README, enum, base 클래스)이 아무거나와 짝지어지는 것을 걸러낸다.
      lift: +((sup / N) / ((fa / N) * (fb / N))).toFixed(1),
    })
  }
  edges.sort((x, y) => y.lift - x.lift || y.support - x.support)

  return {
    edges,
    freq,
    stats: {
      commits: sets.length,
      // 히스토리 커버리지. 낮으면 rename 등으로 히스토리가 끊긴 것이고,
      // 공변경이 실제보다 적게 잡힌다. 화면이 이 사실을 말해야 한다.
      coverage: sets.coverage ?? null,
      droppedBig,
      pairsNoPrune,
      pairsEmitted,
      filesWithHistory: [...freq.values()].filter((v) => v >= minSupport).length,
      minSupport,
      maxFiles,
    },
  }
}

/**
 * 별칭 import 보강.
 *
 * 🔴 analyze.mjs 의 JS_IMPORT_RE 는 './' 로 시작하는 **상대경로만** 잡는다.
 *    그런데 tsconfig `paths` 를 쓰는 저장소는 절대경로로 쓴다:
 *
 *      import { AuthDto } from 'src/dtos/auth.dto'      // immich
 *      import Foo from '@/components/Foo'                // Next.js 관례
 *
 *    실측(immich): 이걸 놓치면 노드 1,132개에 정적 엣지가 331개만 나온다.
 *    그리고 그 누락분이 전부 "히스토리에만 있는 숨은 결합"으로 둔갑한다.
 *    **파서 버그가 발견으로 포장되는 것**이 이 도구에서 가장 나쁜 실패다 (D5).
 *
 *    근본 해결은 analyze.mjs 를 고치는 것이지만 그건 모든 소비자의 동작을 바꾼다.
 *    여기서는 보강 엣지로 따로 얹고, 출처를 구분해 둔다.
 */
export function aliasImportEdges(root, nodeIds) {
  const files = [...nodeIds].filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
  if (files.length === 0) return []

  // 저장소 안의 패키지 루트를 찾는다. 'src/x' 는 그 패키지의 src 를 가리킨다.
  // (immich 는 server/ web/ 두 패키지가 각자 src 를 갖는다)
  const roots = new Set([''])
  for (const f of files) {
    const i = f.indexOf('/src/')
    if (i > 0) roots.add(f.slice(0, i + 1))
  }

  const EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '']
  const resolve = (spec, from) => {
    const bases = []
    if (spec.startsWith('.')) bases.push(path.posix.join(path.posix.dirname(from), spec))
    else if (spec.startsWith('src/')) {
      // 같은 패키지 안을 먼저 본다. 아니면 다른 패키지 루트를 시도한다.
      const own = from.slice(0, from.indexOf('/src/') + 1)
      for (const r of [own, ...roots]) bases.push(r + spec)
    } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
      const own = from.slice(0, from.indexOf('/src/') + 1)
      for (const r of [own, ...roots]) bases.push(`${r}src/${spec.slice(2)}`)
    } else return null // 외부 패키지

    for (const base of bases) {
      for (const e of EXT) {
        if (nodeIds.has(base + e)) return base + e
        if (nodeIds.has(`${base}/index${e}`)) return `${base}/index${e}`
      }
    }
    return null
  }

  // import 문은 여러 줄에 걸칠 수 있다. from 절까지 넉넉히 잡되 상한을 둬서
  // 파일 전체를 삼키는 폭주를 막는다.
  const RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+['"]([^'"]+)['"]/g

  const seen = new Map()
  for (const f of files) {
    let text
    try { text = fs.readFileSync(path.join(root, f), 'utf8') } catch { continue }
    RE.lastIndex = 0
    let m
    while ((m = RE.exec(text))) {
      const t = resolve(m[1], f)
      if (!t || t === f) continue
      const [a, b] = f < t ? [f, t] : [t, f]
      seen.set(`${a}\0${b}`, { source: f, target: t })
    }
  }
  return [...seen.values()]
}

/**
 * 정적 엣지와 공변경 엣지를 겹쳐 사분면으로 나눈다.
 *
 *              import 있음        import 없음
 *   함께 바뀜   both (정상)        cochange  ← 숨은 결합. 읽어서는 못 찾는다
 *   따로 바뀜   static (안정경계)   —
 *
 * 좌하단이 쓸모없는 게 아니다. "호출하지만 같이 안 바뀐다" = 인터페이스가 안정적이라는 뜻이고,
 * 영향 범위를 계산할 때 **가중치를 낮춰야 할 엣지**다. 이게 없으면 그래프가 스파게티가 된다.
 */
export function overlayEdges(staticEdges, coEdges, freq, minSupport = MIN_SUPPORT) {
  const key = (a, b) => (a < b ? `${a}\0${b}` : `${b}\0${a}`)

  const co = new Map()
  for (const e of coEdges) co.set(key(e.source, e.target), e)

  const out = []
  const usedCo = new Set()

  for (const e of staticEdges) {
    const k = key(e.source, e.target)
    const c = co.get(k)
    if (c) {
      usedCo.add(k)
      out.push({ ...e, origin: 'both', support: c.support, lift: c.lift, confA: c.confA, confB: c.confB })
    } else {
      // 양쪽 다 히스토리가 충분한데 함께 안 바뀐 것만 "안정된 경계"로 부른다.
      // 히스토리가 없는 파일은 판정할 근거가 없으므로 모른다고 둔다.
      const enough = (freq.get(e.source) ?? 0) >= minSupport && (freq.get(e.target) ?? 0) >= minSupport
      out.push({ ...e, origin: enough ? 'static-stable' : 'static' })
    }
  }
  for (const [k, c] of co) {
    if (usedCo.has(k)) continue
    out.push({ source: c.source, target: c.target, origin: 'cochange', directed: false, hub: false, support: c.support, lift: c.lift, confA: c.confA, confB: c.confB })
  }

  const count = (o) => out.filter((e) => e.origin === o).length
  return {
    edges: out,
    quadrant: {
      both: count('both'),
      cochange: count('cochange'),
      stable: count('static-stable'),
      unknown: count('static'),
    },
  }
}
