/**
 * 기본 흐름 — "따라가다 보면 어느샌가 이해하게 되는" 순서 (D14 2단계, D15).
 *
 * 🔴 이 파일이 있기 전까지 이 도구는 **병렬 목록만** 줬다.
 *
 * `entryPoints()` 는 질문 넷에 각각 답하는 목록을 준다. 그건 좋은 답이지만
 * **순서가 아니다.** "여기서부터 읽으세요" 라고 적어두고 정작 *그 다음에
 * 무엇을* 은 말하지 않았다. 관찰자 4명 중 4명이 같은 자리에서 멈췄다.
 *
 * 흐름은 여섯 걸음이다.
 *
 *   ① 이 저장소는 무엇을 하는 물건인가   ← 도구가 한 번도 답한 적 없다
 *   ② 실행은 어디서 시작하나
 *   ③ 그 다음에 무엇이 불리나            ← 정적 파싱이 살아 있어야 가능
 *   ④ 어디가 활발하고 위험한가            ← 이미 있던 것
 *   ⑤ 여기에 새로 만들려면 어디를 고치나   ← 첫 번째 '쓰는' 걸음
 *   ⑥ 이제 당신 차례                      ← 3단계(함께 짜기)로 넘기는 다리
 *
 * ①②③ 이 비어 있었다. 이 파일이 그 셋을 채운다.
 *
 * ---
 *
 * 🔴 걸음마다 `gaps` 를 함께 낸다. 못 알아낸 것을 반드시 말한다.
 *
 * 이 프로젝트에서 실제로 발견된 가장 나쁜 버그는 전부 같은 모양이었다 —
 * 정적 파싱이 Go·Java 에서 조용히 0개를 내놓고, 화면이 **그 침묵을 결과로**
 * 제시했다. 흐름은 그보다 더 위험하다. 순서를 주면 사용자는 그것이
 * 검증된 경로라고 믿고 따라가기 때문이다.
 *
 * 그래서 각 걸음은 근거(`evidence`)와 못 알아낸 것(`gaps`)을 함께 낸다.
 * 근거가 없으면 그 걸음은 "모른다" 를 답으로 낸다. 추측을 답으로 내지 않는다.
 *
 * 🔴 한 걸음이 끝났다는 판정은 도구가 하지 않는다 (Q8 에 대한 답).
 *
 * 체크박스도, 읽은 시간도, 진도율도 두지 않는다. 이해했는지는 사람만 안다.
 * 대신 걸음마다 `done` 에 **스스로 확인할 수 있는 문장**을 적는다 —
 * "이 저장소를 한 문장으로 말할 수 있다" 처럼. 도구가 판정하는 순간
 * 사용자는 이해가 아니라 진도율을 좇게 된다.
 */

import fs from 'node:fs'
import path from 'node:path'
// 겹침 판정은 프로토콜의 것을 그대로 쓴다. 여기서 다시 정의하면 화면과
// 락이 서로 다른 답을 하게 된다 (CLAUDE.md — 판정은 한 곳에서).
import { coversPath } from '../../src/protocol.mjs'

// ---------------------------------------------------------------------------
// ① 이 저장소는 무엇을 하는 물건인가
// ---------------------------------------------------------------------------

/** README 로 인정할 파일. 위에 있을수록 우선. */
const README_NAMES = [
  'README.md', 'README.rst', 'README.txt', 'README',
  'readme.md', 'Readme.md', 'docs/README.md', 'docs/index.md',
]

/**
 * README 첫 문단에서 "무엇을 하는 물건인지" 를 뽑는다.
 *
 * 🔴 배지·이미지·HTML 정렬 태그를 건너뛴다. 요즘 README 는 첫 10줄이
 *    전부 배지라서, 그냥 첫 줄을 집으면 `[![Build Status](...)](...)` 가
 *    프로젝트 설명으로 화면에 뜬다. 실제로 그렇게 뜬 적이 있다.
 */
/**
 * 공지 블록인가 — 보관·중단·이관 안내.
 *
 * 🔴 실측(clips/pattern): README 가 이렇게 시작한다.
 *
 *     # WARNING: This repository is no longer maintained.
 *
 *     This project is archived and will not receive further updates...
 *
 * 첫 제목과 첫 문단을 그대로 집으면 ①의 답이
 * **"이 프로젝트는 보관되었습니다"** 가 된다. 사실이지만 "무엇을 하는
 * 물건인가" 에 대한 답이 아니다. 진짜 설명은 배너 아래에 있다 —
 * "Pattern is a web mining module for Python."
 *
 * 그렇다고 버리지도 않는다. 보관됐다는 사실은 이 코드를 읽으려는 사람에게
 * 중요한 정보다. 따로 `notice` 로 빼서 둘 다 보여준다.
 */
const NOTICE_RE = /^(?:[⚠🚨❗️\s*_-]*)?(?:\*{0,2})(?:warning|note|notice|caution|important|deprecated|archived|unmaintained|주의|경고|안내)\b/i
const NOTICE_BODY_RE = /\b(no longer maintained|not maintained|is archived|has been archived|deprecated|end of life|read[- ]only|moved to|superseded by)\b/i

const isNotice = (s) => !!s && (NOTICE_RE.test(s) || NOTICE_BODY_RE.test(s))

export function readmeSummary(text) {
  if (!text) return null
  const src = text.replace(/<!--[\s\S]*?-->/g, '')          // 주석 제거
  const lines = src.split(/\r?\n/)

  let title = null
  let notice = null
  const para = []

  const skippable = (l) => {
    const t = l.trim()
    if (!t) return true
    if (/^[-=_*]{3,}$/.test(t)) return true                 // 구분선
    if (/^<\/?(p|div|img|br|h\d|a|picture|source|center)\b/i.test(t)) return true
    if (/^\[!\[/.test(t) || /^!\[/.test(t)) return true     // 배지·이미지
    if (/^\[\!\[.*\]\(.*\)\]\(.*\)$/.test(t)) return true
    // 배지만 여러 개 이어 붙인 줄
    if (/^(\s*\[?!\[[^\]]*\]\([^)]*\)\]?\([^)]*\)\s*)+$/.test(t)) return true
    return false
  }

  /**
   * rST/Setext 제목인가 — 다음 줄이 `=====` 나 `-----` 인 짧은 줄.
   *
   * 🔴 앞줄만 보고는 판단할 수 없어서 다음 줄을 본다.
   *
   * 예전에는 "짧고 마침표로 안 끝나면 제목" 이라고 봤다. 그건 공지 배너가
   * 있는 README 에서 무너진다 — clips/pattern 의 진짜 제목은
   * `Pattern` / `=======` 인데, 마크다운 제목이 아니라서 못 잡고
   * 그 앞의 아무 짧은 줄이나 제목이 될 수 있었다.
   */
  const isSetext = (i) => /^[=\-~^]{3,}\s*$/.test(lines[i + 1]?.trim() ?? '')

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]
    const t = raw.trim()
    const heading = t.match(/^#{1,6}\s+(.+?)\s*#*$/)

    // 🔴 공지 블록은 제목이든 문단이든 통째로 건너뛰고 **처음부터 다시 찾는다.**
    //    보관 안내를 답으로 내놓으면 ①이 "무엇을 하는 물건인가" 에 답을 못 한다.
    if (isNotice(t)) {
      if (!notice) notice = t.replace(/^#+\s*/, '').trim()
      title = null
      para.length = 0
      continue
    }

    if (title === null) {
      if (heading) { title = heading[1].trim(); continue }
      // rST/Setext 제목. 다음 줄의 `=====` 는 구분선 규칙에 걸려 건너뛴다.
      if (t && t.length < 90 && isSetext(li)) { title = t; continue }
      if (skippable(t)) continue
      // 🔴 공지 블록의 꼬리를 설명으로 집지 않는다.
      //
      // 공지는 여러 문단이다. `no longer maintained` 는 걸렀는데 그 다음
      // "Use this software at your own risk." 가 설명으로 올라왔다.
      // 배너 뒤에는 문서가 **제목부터 다시 시작한다** — 그러니 공지를 본 뒤에는
      // 새 제목을 만나기 전까지 본문을 모으지 않는다.
      if (notice) continue
      // 제목이 아예 없는 README. 마침표로 끝나면 이미 설명문이므로 흘려보낸다.
      if (t.length > 0 && t.length < 90 && !/[.。]$/.test(t)) { title = t; continue }
    } else if (heading) {
      // 🔴 제목을 지난 뒤 만나는 섹션 제목에서 무조건 끊는다.
      //
      // 전에는 `para` 가 비어 있으면 계속 읽었다. 그러면 첫 문단이 배지뿐인
      // README 에서 **`## 설치` 아래 본문을 프로젝트 설명으로 집었다.**
      // "이 저장소는 무엇을 하는 물건인가" 자리에 설치 안내가 뜬다.
      //
      // 여기서 끊으면 답이 null 이 되고, ①이 "README 첫 문단이 배지뿐이라
      // 설명을 못 찾았다" 고 말한다. 모른다고 말하는 편이 낫다.
      break
    }

    if (skippable(t)) { if (para.length) break; continue }
    para.push(t)
    if (para.join(' ').length > 400) break
  }

  const summary = para.join(' ').replace(/\s+/g, ' ').trim()
  if (!title && !summary && !notice) return null
  return { title, summary: summary || null, notice }
}

/**
 * 매니페스트에서 이름·설명을 읽는다.
 *
 * ⚠️ package.json 만 진짜로 파싱한다. 나머지(pyproject·go.mod·gradle)는
 *    정규식으로 한 줄씩 집는다. **파서가 아니다.** 형식이 조금만 달라도
 *    못 읽는데, 그건 못 읽었다고 말하면 되는 일이라 허용한다.
 *    반대로 어설픈 파서를 넣으면 틀린 값을 자신 있게 내놓게 된다.
 */
export function manifestInfo(root) {
  const read = (rel) => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8') } catch { return null }
  }
  const out = []

  const pkg = read('package.json')
  if (pkg) {
    try {
      const j = JSON.parse(pkg)
      out.push({
        file: 'package.json', kind: 'node',
        name: j.name ?? null, description: j.description ?? null,
      })
    } catch { out.push({ file: 'package.json', kind: 'node', unparsable: true }) }
  }

  const py = read('pyproject.toml')
  if (py) {
    out.push({
      file: 'pyproject.toml', kind: 'python',
      name: py.match(/^\s*name\s*=\s*["']([^"']+)/m)?.[1] ?? null,
      description: py.match(/^\s*description\s*=\s*["']([^"']+)/m)?.[1] ?? null,
    })
  }
  const setup = read('setup.py')
  if (setup && !py) {
    out.push({
      file: 'setup.py', kind: 'python',
      name: setup.match(/name\s*=\s*["']([^"']+)/)?.[1] ?? null,
      description: setup.match(/description\s*=\s*["']([^"']+)/)?.[1] ?? null,
    })
  }

  const gomod = read('go.mod')
  if (gomod) {
    out.push({
      file: 'go.mod', kind: 'go',
      name: gomod.match(/^\s*module\s+(\S+)/m)?.[1] ?? null, description: null,
    })
  }

  const cargo = read('Cargo.toml')
  if (cargo) {
    out.push({
      file: 'Cargo.toml', kind: 'rust',
      name: cargo.match(/^\s*name\s*=\s*["']([^"']+)/m)?.[1] ?? null,
      description: cargo.match(/^\s*description\s*=\s*["']([^"']+)/m)?.[1] ?? null,
    })
  }

  for (const g of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'pom.xml']) {
    const t = read(g)
    if (!t) continue
    const name = g === 'pom.xml'
      ? t.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1] ?? null
      : t.match(/rootProject\.name\s*=\s*["']([^"']+)/)?.[1] ?? null
    out.push({ file: g, kind: 'jvm', name, description: null })
    break
  }

  return out
}

/** 최상위 폴더별 파일 수·줄수. "이 저장소가 무엇으로 이뤄졌나" 의 뼈대다. */
export function topLevelShape(nodes, { limit = 10 } = {}) {
  const byDir = new Map()
  for (const n of nodes) {
    const top = n.id.includes('/') ? n.id.slice(0, n.id.indexOf('/')) : '(최상위)'
    const e = byDir.get(top) ?? { dir: top, files: 0, lines: 0, langs: new Map() }
    e.files++
    e.lines += n.lines ?? 0
    e.langs.set(n.lang, (e.langs.get(n.lang) ?? 0) + 1)
    byDir.set(top, e)
  }
  return [...byDir.values()]
    .map((e) => ({
      ...e,
      langs: [...e.langs].sort((a, b) => b[1] - a[1]).map(([l, c]) => ({ lang: l, files: c })),
    }))
    .sort((a, b) => b.files - a.files)
    .slice(0, limit)
}

function stepWhat(root, nodes) {
  const gaps = []
  let readme = null
  let readmeFile = null
  for (const rel of README_NAMES) {
    try {
      const t = fs.readFileSync(path.join(root, rel), 'utf8')
      const s = readmeSummary(t)
      if (s) { readme = s; readmeFile = rel; break }
    } catch { /* 다음 후보 */ }
  }
  if (!readme) gaps.push('README 를 찾지 못했거나 첫 문단이 배지뿐이다 — 설명을 사람이 직접 확인해야 한다')

  const manifests = manifestInfo(root)
  if (!manifests.length) gaps.push('매니페스트(package.json·pyproject.toml·go.mod 등)가 없다 — 프로젝트 이름을 알 수 없다')

  const shape = topLevelShape(nodes)
  const langs = new Map()
  for (const n of nodes) langs.set(n.lang, (langs.get(n.lang) ?? 0) + 1)

  const described = readme?.summary
    ?? manifests.find((m) => m.description)?.description
    ?? null
  if (!described) gaps.push('한 문장 설명을 어디서도 못 찾았다')
  // 보관·중단 안내는 버리지 않는다. 이 코드를 읽으려는 사람에게 중요한 정보다.
  if (readme?.notice) gaps.push(`README 에 안내가 붙어 있다 — "${readme.notice}"`)

  return {
    n: 1,
    key: 'what',
    question: '이 저장소는 무엇을 하는 물건인가',
    why: '무엇을 하는 물건인지 모르는 채로 구조를 보면, 보이는 것이 전부 그냥 파일이다.',
    answer: {
      name: manifests.find((m) => m.name)?.name ?? readme?.title ?? null,
      summary: described,
      source: readme?.summary ? readmeFile : manifests.find((m) => m.description)?.file ?? null,
      manifests,
      shape,
      langs: [...langs].sort((a, b) => b[1] - a[1]).map(([lang, files]) => ({ lang, files })),
    },
    /**
     * 무엇을 강조할지 — **가장 큰 폴더 하나**.
     *
     * 🔴 처음에는 상위 3개를 강조했다. 그랬더니 화면의 거의 모든 점이 물들어
     *    강조가 아무 말도 하지 않게 됐다(스크린샷으로 확인). 전부를 강조하는
     *    것은 아무것도 강조하지 않는 것이다.
     */
    focus: shape.slice(0, 1).map((s) => s.dir),
    focusKind: 'dir',
    done: '이 저장소가 무엇을 하는지 한 문장으로 말할 수 있다.',
    next: '무엇을 하는지 알았으면, 그 일이 어디서 시작되는지를 본다.',
    gaps,
  }
}

// ---------------------------------------------------------------------------
// ② 실행은 어디서 시작하나
// ---------------------------------------------------------------------------

/** 이름만으로 진입점 후보가 되는 파일. 약한 근거이므로 등급을 낮게 준다. */
const CONVENTIONAL = /(^|\/)(main|index|cli|app|server|__main__|manage|program)\.(mjs|cjs|js|jsx|ts|tsx|py|go|java|kt|rs|rb|php|cs)$/i

/**
 * 진입점을 **근거 등급과 함께** 낸다.
 *
 * 🔴 합성 점수로 줄 세우지 않는다 (entry.mjs 와 같은 이유).
 *    대신 근거의 종류를 그대로 보여준다 — 선언된 것, main 이 있는 것,
 *    이름이 그런 것, 그래프에서 아무도 안 부르는 것. 넷은 신뢰도가 다르다.
 *
 *    `declared` 는 사람이 직접 적은 것이라 가장 세고,
 *    `convention` 은 이름만 보고 찍은 것이라 가장 약하다.
 *    그 차이를 숫자 하나로 뭉개면 사용자가 무엇을 믿을지 알 수 없게 된다.
 */
export function entryCandidates(root, nodes, edges, { prefix = '' } = {}) {
  /**
   * 🔴 매니페스트를 **저장소 최상위에서만** 읽고 있었다.
   *
   * 모노레포에서는 그것이 아무것도 못 찾는다는 뜻이다. 실측(SSAFY S15P11E101):
   * 매니페스트가 `FE/bbiyong-react/package.json` · `BE_system/build.gradle` ·
   * `AI/requirements.txt` 에 있는데 최상위에는 없어서 1등급을 하나도 못 찾았고,
   * 하위 근거로 떨어져 `if __name__ == '__main__'` 이 있는 **JIRA 자동화 스크립트**
   * 8개를 진입점으로 골랐다. 거기서 Java 208개와 React 149개로 가는 길은 없다.
   * 결과는 "549개 중 14개만 닿음" 이었다.
   *
   * `prefix` 를 받으면 그 하위 프로젝트 안에서 찾는다. 하위 프로젝트를 어떻게
   * 나누는지는 `app/lib/roots.mjs`.
   */
  const base = prefix ? path.join(root, prefix) : root
  /** 매니페스트가 준 경로는 그 프로젝트 기준이다. 노드 id 는 저장소 기준이라 앞을 붙인다. */
  const at = (p) => (prefix && p ? `${prefix}/${p}` : p)
  // 🔴 코드가 아닌 노드는 진입점이 될 수 없다.
  //
  // `datanodes.mjs` 가 `.md`·`.json`·`.gradle` 을 노드로 올린다. 그건 숨은
  // 결합을 잡기 위한 것이고 옳지만, 진입점 목록에는 들어오면 안 된다.
  // 실제로 `CLAUDE.md` 가 "아무도 부르지 않는데 남을 부른다" 로 4등급에
  // 올라왔다. 문서는 실행되지 않는다.
  const runnable = nodes.filter((n) => n.lang !== 'data' && n.confidence !== 'history-only')
  const have = new Set(runnable.map((n) => n.id))
  nodes = runnable
  const found = new Map()   // path -> {path, evidence:[], rank}

  const add = (p, evidence, rank) => {
    if (!p || !have.has(p)) return
    const e = found.get(p) ?? { path: p, evidence: [], rank: 9 }
    if (!e.evidence.includes(evidence)) e.evidence.push(evidence)
    e.rank = Math.min(e.rank, rank)
    found.set(p, e)
  }

  // ── 1등급: 매니페스트가 선언한 것 ──────────────────────────────────────
  const norm = (s) => (s ?? '').replace(/^\.\//, '').replace(/\\/g, '/')
  try {
    const j = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'))
    if (typeof j.main === 'string') add(at(norm(j.main)), 'package.json 의 main', 1)
    if (typeof j.module === 'string') add(at(norm(j.module)), 'package.json 의 module', 1)
    if (typeof j.bin === 'string') add(at(norm(j.bin)), 'package.json 의 bin', 1)
    else if (j.bin && typeof j.bin === 'object') {
      for (const [k, v] of Object.entries(j.bin)) add(at(norm(v)), `package.json 의 bin.${k}`, 1)
    }
    for (const [k, v] of Object.entries(j.scripts ?? {})) {
      // `node app/server.mjs .` 같은 스크립트에서 파일 경로만 집는다.
      for (const m of String(v).matchAll(/([\w./-]+\.(?:mjs|cjs|js|ts|py))\b/g)) {
        add(at(norm(m[1])), `package.json 의 scripts.${k}`, 1)
      }
    }
  } catch { /* 없거나 못 읽으면 다음 근거로 */ }

  /**
   * 🔴 번들러 앱은 `index.html` 이 매니페스트다.
   *
   * Vite·Parcel 로 만든 앱의 `package.json` 에는 `main` 이 없다. 브라우저가
   * 처음 읽는 것이 `index.html` 이고, 거기 `<script type="module" src>` 가
   * 진짜 진입점을 **선언한다.** 그것을 안 읽으면 rank 1 이 비고, 실측에서
   * `FE/bbiyong-react` 의 진입점이 `tools/fake-ws-harness.mjs` 로 떨어졌다 —
   * 테스트 하네스가 앱의 시작점으로 뜬 것이다.
   */
  try {
    const html = fs.readFileSync(path.join(base, 'index.html'), 'utf8')
    for (const m of html.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/gi)) {
      add(at(norm(m[1].replace(/^\//, ''))), 'index.html 의 module script', 1)
    }
  } catch { /* 없으면 다음 근거로 */ }

  try {
    const py = fs.readFileSync(path.join(base, 'pyproject.toml'), 'utf8')
    const sect = py.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/)?.[1]
    for (const m of (sect ?? '').matchAll(/=\s*["']([\w.]+):/g)) {
      add(at(`${m[1].replace(/\./g, '/')}.py`), 'pyproject.toml 의 project.scripts', 1)
    }
  } catch { /* 없으면 넘어간다 */ }

  /**
   * 🔴 라이브러리에는 "실행 시작점" 이 없다. **공개 표면**이 시작점이다.
   *
   * 실측(clips/pattern)에서 두 번 틀렸다.
   *
   *   ① 처음에는 데모 블록(`if __name__ == '__main__'`)이 든 하위 모듈
   *      `pattern/text/en/__init__.py` 등이 시작점이 됐다. 엉뚱한 데서
   *      출발하니 ③의 도달률이 17% 였다.
   *   ② 그래서 최상위 패키지 하나(`pattern/__init__.py`)만 쓰게 했더니
   *      **1%** 가 됐다. 그 파일은 내부 import 를 하나도 안 한다.
   *
   * 답은 추측이 아니라 매니페스트에 적혀 있었다. `setup.py` 의 `packages=`
   * 가 이 저장소가 배포하는 것을 그대로 나열한다 — pattern, pattern.web,
   * pattern.text, pattern.vector … 라이브러리를 읽는 것은 거기서 시작한다.
   *
   * 점 하나까지만 취한다. `pattern.text.en.wordnet` 까지 넣으면 시작점이
   * 20개를 넘어 "0겹" 이 저장소의 절반이 되고, 그러면 계층이 아니다.
   */
  try {
    const setup = fs.readFileSync(path.join(base, 'setup.py'), 'utf8')
    const list = setup.match(/packages\s*=\s*\[([\s\S]*?)\]/)?.[1]
    for (const m of (list ?? '').matchAll(/["']([\w.]+)["']/g)) {
      if ((m[1].match(/\./g) ?? []).length > 1) continue
      add(at(`${m[1].replace(/\./g, '/')}/__init__.py`), 'setup.py 가 배포하는 패키지', 1)
    }
  } catch { /* setup.py 가 없으면 아래 규칙으로 */ }

  // 매니페스트가 아무 말도 안 하면, 저장소 바로 아래(또는 src/ 아래)의
  // 패키지 뿌리를 쓴다. 그보다 깊으면 하위 모듈이라 뿌리가 아니다.
  if (!found.size) {
    for (const n of nodes) {
      const m = n.id.match(/^(?:src\/)?([^/]+)\/__init__\.py$/)
      if (m) add(n.id, `저장소가 배포하는 패키지 (${m[1]})`, 1)
    }
  }
  // JS 쪽에는 같은 규칙을 두지 않는다. 공개 표면은 package.json 의
  // `main`/`bin`/`exports` 가 이미 1등급으로 말해주고, `index.*` 는 아래
  // 관례 규칙(3등급)이 잡는다. 여기에 또 넣으면 "이름이 그렇게 생겼다" 를
  // 2등급("파일 안에 실행 시작점이 있다")으로 올려 등급의 뜻을 흐린다.

  // ── 2등급: 파일 안에 실행 시작점이 실제로 있는 것 ──────────────────────
  // 내용을 읽어야 알 수 있으므로 후보를 좁혀서 본다. 전부 읽으면 느리다.
  //
  // 🔴 `lang` 으로 막고, 줄머리에 고정한다. 둘 다 필요하다.
  //
  // 이 목록을 처음 썼을 때 **이 파일 자신이 진입점으로 잡혔다.** 아래
  // `what` 에 적힌 설명 문자열 `"if __name__ == '__main__'"` 이 바로 위
  // 정규식에 걸렸기 때문이다. 탐지기가 자기 문서를 탐지했다.
  //
  // 같은 실패를 전에도 한 번 했다 — 토픽 정규식이 `@app.route("/add")` 를
  // 채널로 읽어 가짜 엣지 35개를 만들었다. 패턴은 **그 패턴이 의미를 갖는
  // 언어에서만** 돌려야 하고, 문법 요소는 줄 아무 데나가 아니라 제자리에
  // 있어야 한다.
  /**
   * 진짜 진입점이지만 **그** 진입점은 아닌 곳.
   *
   * 예제·테스트·코드 생성기·빌드 도구는 전부 실행 가능하다. 그래서 탐지에는
   * 걸리는데, 신입이 "이 저장소를 실행하면 어디부터 도나" 를 물을 때의 답은
   * 아니다. 지우지 않고 뒤로 민다 — 지우면 "왜 내 스크립트가 없지" 가 된다.
   */
  // `gotestdata` 처럼 앞뒤에 말이 붙은 것도 잡는다 — syft 에서 실제로
  // `.../internal/gotestdata/go-source/cmd/bin1/main.go` 가 2위로 올라왔다.
  const AUX_ENTRY = /(^|\/)([\w-]*testdata[\w-]*|examples?|tests?|spec|benchmarks?|fixtures?|tools?|scripts?|hack|docs?|generate|gen)(\/|$)/i

  /** Go 의 사실상 선언. `go install ./cmd/...` 이 이 관례 위에 선다. */
  const GO_CMD = /(^|\/)cmd\/[^/]+\/main\.go$/
  const GO_CMD_WHY = 'Go 관례: cmd/<이름>/main.go'

  const MAIN_PAT = [
    { lang: 'go', re: /^\s*func\s+main\s*\(\s*\)/m, need: /^\s*package\s+main\b/m, what: 'func main() (package main)' },
    { lang: 'java', re: /^\s*(public\s+)?static\s+.*\bmain\s*\(/m, need: null, what: 'static void main' },
    { lang: 'python', re: /^\s*if\s+__name__\s*==\s*["']__main__["']/m, need: null, what: "if __name__ == '__main__'" },
    { lang: 'rust', re: /^\s*fn\s+main\s*\(\s*\)/m, need: null, what: 'fn main()' },
  ]
  const readable = nodes.filter((n) => (n.lines ?? 0) > 0 && (n.lines ?? 0) < 3000)
  for (const n of readable) {
    let text = null
    try { text = fs.readFileSync(path.join(root, n.id), 'utf8') } catch { continue }
    for (const p of MAIN_PAT) {
      if (p.lang !== n.lang) continue
      if (!p.re.test(text)) continue
      if (p.need && !p.need.test(text)) continue
      add(n.id, p.what, 2)
      break
    }
    /**
     * 🔴 `@SpringBootApplication` 은 관례가 아니라 **선언**이다.
     *
     * 그래서 rank 2(`static void main`)가 아니라 rank 1 이다. 실측에서
     * BE_system 은 `static void main` 을 가진 Spring 진입점과 `if __name__ ==
     * '__main__'` 을 가진 JIRA 자동화 스크립트가 **같은 rank 2 동률**이 되어,
     * 스크립트 쪽이 목록을 차지했다. 등급이 같으면 순서가 답을 정하는데
     * 그건 근거가 아니다.
     */
    if (/@SpringBootApplication\b/.test(text)) add(n.id, '@SpringBootApplication', 1)
    // 셔뱅도 실행 파일이라는 증거다.
    if (/^#!.*\b(node|python\d?|bash|sh|ruby)\b/.test(text)) add(n.id, '셔뱅(#!)', 2)
  }

  // ── 3등급: 이름이 그렇게 생긴 것 ───────────────────────────────────────
  for (const n of nodes) if (CONVENTIONAL.test(n.id)) add(n.id, '관례적인 파일명', 3)

  // ── 4등급: 그래프에서 아무도 부르지 않는데 남을 부르는 것 ──────────────
  const inDeg = new Map()
  const outDeg = new Map()
  for (const e of edges) {
    if (e.hub) continue
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
    outDeg.set(e.source, (outDeg.get(e.source) ?? 0) + 1)
  }
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0 && (outDeg.get(n.id) ?? 0) > 0) {
      add(n.id, '아무도 import 하지 않는데 남을 import 한다', 4)
    }
  }

  /**
   * 🔴 같은 등급 안의 순서를 out-degree 로만 정하면 안 된다.
   *
   * syft(Go)에서 정면으로 드러났다. `func main()` 을 가진 파일이 **264개**였고
   * 앞의 8개가 전부 `examples/<이름>/main.go` 와 코드 생성기였다. 정작 제품 진입점
   * `cmd/syft/main.go` 는 목록에 없어서 신입이 직접 검색해 찾아야 했다.
   *
   * 예제가 이긴 이유는 단순하다 — 예제는 라이브러리를 많이 부르므로 out-degree 가
   * 높다. 그런데 **"많이 부른다" 는 "진입점이다" 가 아니다.** 오히려 제품 진입점은
   * 얇은 경우가 많다(플래그 파싱하고 한 곳으로 넘긴다).
   *
   * 파이썬 저장소에서는 이런 파일이 적어 우연히 맞았다. 등급(rank)은 근거의
   * 종류라 건드리지 않는다 — 바꾸면 라벨이 거짓말한다. 순서만 고친다.
   */
  const depthOf = (p) => p.split('/').length
  const rankKey = (e) => [
    e.rank,
    // 예제·테스트·생성기·도구에도 진짜 진입점이 있다. 다만 그것은 *그* 진입점이
    // 아니다. 지우지 않고 뒤로 민다.
    AUX_ENTRY.test(e.path) ? 1 : 0,
    // Go 는 go.mod 가 바이너리를 선언하지 않는다. `cmd/<이름>/main.go` 가
    // 사실상의 선언이고 툴체인(`go install ./cmd/...`)도 그 관례 위에 선다.
    GO_CMD.test(e.path) ? 0 : 1,
    depthOf(e.path),          // 얕을수록 뿌리에 가깝다
    -(outDeg.get(e.path) ?? 0), // 그래도 남으면 많이 부르는 쪽
    e.path,                   // 완전한 결정론
  ]
  return [...found.values()]
    .map((e) => ({
      ...e,
      out: outDeg.get(e.path) ?? 0,
      in: inDeg.get(e.path) ?? 0,
      evidence: GO_CMD.test(e.path) && !e.evidence.includes(GO_CMD_WHY)
        ? [...e.evidence, GO_CMD_WHY] : e.evidence,
    }))
    .sort((a, b) => {
      const ka = rankKey(a), kb = rankKey(b)
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1
        if (ka[i] > kb[i]) return 1
      }
      return 0
    })
}

const RANK_LABEL = {
  1: '매니페스트가 선언했다',
  2: '파일 안에 실행 시작점이 있다',
  3: '이름이 그렇게 생겼다',
  4: '아무도 부르지 않는데 남을 부른다',
}

function stepEnter(root, nodes, edges, { limit = 8, prefix = '' } = {}) {
  const all = entryCandidates(root, nodes, edges, { prefix })
  const gaps = []
  if (!all.length) {
    gaps.push('진입점을 하나도 못 찾았다 — 라이브러리이거나, 실행을 코드 밖(설정·컨테이너)에서 시작하는 저장소일 수 있다')
  } else if (all[0].rank >= 3) {
    gaps.push('가장 센 근거가 "이름이 그렇게 생겼다" 뿐이다 — 열어서 확인해야 한다')
  }
  const rows = all.slice(0, limit)
  const groups = []
  for (const r of rows) {
    let g = groups.find((x) => x.rank === r.rank)
    if (!g) { g = { rank: r.rank, label: RANK_LABEL[r.rank], rows: [] }; groups.push(g) }
    g.rows.push(r)
  }

  return {
    n: 2,
    key: 'enter',
    question: '실행은 어디서 시작하나',
    why: '읽는 순서를 코드가 실행되는 순서에 맞추면, 파일이 아니라 동작이 보인다.',
    answer: { groups, total: all.length, shown: rows.length },
    focus: rows.map((r) => r.path),
    focusKind: 'file',
    done: '이 저장소를 실행했을 때 가장 먼저 읽히는 파일을 하나 짚을 수 있다.',
    next: '시작점을 알았으면, 거기서 무엇이 차례로 불리는지를 본다.',
    gaps,
  }
}

// ---------------------------------------------------------------------------
// ③ 그 다음에 무엇이 불리나
// ---------------------------------------------------------------------------

/**
 * 시작점 여러 개에서 동시에 BFS 를 돌려 계층을 만든다.
 *
 * 🔴 `analyze.mjs` 의 `depths()` 는 시작점이 **하나**다. 흐름에서는 진입점이
 *    여럿이라(bin 여러 개, 서버와 CLI가 따로) 각각 재서 최솟값을 취해야 한다.
 *    하나만 골라서 재면 나머지 진입점에서만 닿는 코드가 통째로 "안 닿음"이 된다.
 *
 * 🔴 정적 엣지만 쓴다. 공변경 엣지는 방향이 없어서 "다음에 불린다" 를
 *    말할 수 없다. 섞으면 계층이 아니라 그냥 이웃 목록이 된다.
 */
/**
 * 진입점 하나에서 뻗어나가는 **방향 있는** import 체인.
 *
 * 🔴 계층 목록만으로는 "무엇이 무엇을 부르나" 를 못 읽는다.
 *
 * 벤치마크 기준선에서 신입이 M3(진입점→기능 경로)에 도달하는 데 노드를 다섯 번
 * 눌러 손으로 이어붙였고, 그러고도 방향은 **파일명 의미로 추측**했다. 원문:
 *
 * > "안정된 경계 목록에 방향 표기가 없다. cli.go 패널에 main.go 와
 * >  clio_setup_config.go 가 같은 목록에 섞여 나왔다 — 누가 누구를 import
 * >  하는지 구분하는 화살표가 없었다."
 * > "step=3 레이어 목록은 8개 진입점을 전부 섞어서 보여줘 cmd/syft/main.go
 * >  단독 경로를 알려주지 않았다."
 *
 * 그래서 여기서는 **시작점 하나**만 잡고, **부모를 명시**하고, 방향을 아는 것과
 * 모르는 것을 **가른다.** 모르는 것을 아는 척하면 신입은 그것을 사실로 읽는다.
 *
 * 반환은 **미리 순회(pre-order) 순서**다. 그대로 들여쓰면 위에서 아래로 읽는
 * 것이 곧 경로가 된다 — 어느 줄에서든 위로 훑으면 시작점까지 이어진다.
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {string} start  시작 파일 하나
 * @param {object} opts
 *   maxDepth  몇 겹까지 (기본 4)
 *   perNode   한 파일이 부르는 것 중 몇 개까지 (기본 5)
 */
export function importTree(nodes, edges, start, { maxDepth = 4, perNode = 5 } = {}) {
  const have = new Set(nodes.map((n) => n.id))
  if (!have.has(start)) return { start: null, rows: [], reached: 0, why: '시작점이 그래프에 없다' }

  const lines = new Map(nodes.map((n) => [n.id, n.lines ?? 0]))

  /** source → [{to, directed}] — 허브와 공변경은 쓰지 않는다 (layersFrom 과 같은 이유). */
  const out = new Map()
  const push = (a, b, directed) => {
    if (!out.has(a)) out.set(a, [])
    if (!out.get(a).some((x) => x.to === b)) out.get(a).push({ to: b, directed })
  }
  for (const e of edges) {
    if (e.hub) continue
    if (e.origin === 'cochange') continue
    if (!have.has(e.source) || !have.has(e.target)) continue
    push(e.source, e.target, e.directed !== false)
    // 🔴 방향을 모르는 엣지는 양쪽으로 두되 **모른다고 표시**한다.
    //    없는 것으로 치면 조용히 빠뜨리고, 안다고 치면 거짓말이 된다.
    if (e.directed === false) push(e.target, e.source, false)
  }

  // 최단 거리로 부모를 정한다 — 같은 파일에 여러 경로가 있으면 가장 짧은 것이 읽기 쉽다.
  const parent = new Map([[start, null]])
  const depth = new Map([[start, 0]])
  const dirOf = new Map()
  let frontier = [start]
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next = []
    for (const a of frontier) {
      for (const { to, directed } of out.get(a) ?? []) {
        if (depth.has(to)) continue
        depth.set(to, d); parent.set(to, a); dirOf.set(to, directed)
        next.push(to)
      }
    }
    frontier = next
  }

  const kids = new Map()
  for (const [child, par] of parent) {
    if (par === null) continue
    if (!kids.has(par)) kids.set(par, [])
    kids.get(par).push(child)
  }

  /**
   * 🔴 자식을 **줄 수**로 정렬하면 안 된다.
   *
   * 처음에 큰 것부터 폈다. syft 에서 그 결과가 이랬다 — `main.go` 가 처음 펼치는
   * 가지가 CLI 부팅·UI 이벤트·로그 배선이고, 정작 이 저장소의 본질인 패키지
   * 카탈로징으로 가는 가지는 "7개 더" 에 접혀 있었다. 벤치마크 관찰자가
   * *"이건 이벤트 파싱 기능이지 SBOM 카탈로징이 아니다"* 라고 적었다.
   *
   * 큰 파일이 중요한 파일은 아니다. **그 가지가 코드베이스를 얼마나 여는가**로
   * 정렬한다 — 본류는 많은 것으로 이어지고 곁가지는 금방 끝난다.
   */
  const subtree = new Map()
  const sizeOf = (id) => {
    if (subtree.has(id)) return subtree.get(id)
    subtree.set(id, 1)   // 순환은 없지만 방어적으로 먼저 넣는다
    let n2 = 1
    for (const c of kids.get(id) ?? []) n2 += sizeOf(c)
    subtree.set(id, n2)
    return n2
  }
  for (const id of parent.keys()) sizeOf(id)
  for (const arr of kids.values()) {
    arr.sort((a, b) => sizeOf(b) - sizeOf(a) || (lines.get(b) ?? 0) - (lines.get(a) ?? 0) || (a < b ? -1 : 1))
  }

  const rows = []
  const walk = (id, d) => {
    const all = kids.get(id) ?? []
    for (const c of all.slice(0, perNode)) {
      rows.push({
        path: c,
        depth: d + 1,
        from: id,
        // 이 연결의 방향을 아는가. 모르면 화면이 그렇게 말해야 한다.
        directed: dirOf.get(c) === true,
        lines: lines.get(c) ?? 0,
        // 이 가지가 여는 파일 수. 정렬 근거를 화면에도 낼 수 있어야 한다.
        opens: sizeOf(c),
      })
      if (d + 1 < maxDepth) walk(c, d + 1)
    }
    if (all.length > perNode) {
      rows.push({ more: all.length - perNode, depth: d + 1, from: id })
    }
  }
  walk(start, 0)

  return {
    start,
    rows,
    reached: depth.size - 1,
    // 방향을 모르는 연결이 섞였으면 그 수를 낸다. 화면이 조용히 넘어가지 않게.
    unknownDir: rows.filter((r) => r.path && !r.directed).length,
    why: rows.length ? null : `${start} 이 import 로 부르는 것을 하나도 못 찾았다`,
  }
}

export function layersFrom(nodes, edges, starts) {
  const have = new Set(nodes.map((n) => n.id))
  const adj = new Map()
  for (const e of edges) {
    if (e.hub) continue                      // 허브 경유는 계층을 뭉갠다 (D9)
    if (e.origin === 'cochange') continue    // 방향이 없다
    if (!have.has(e.source) || !have.has(e.target)) continue
    if (!adj.has(e.source)) adj.set(e.source, new Set())
    adj.get(e.source).add(e.target)
    // 방향을 모르는 엣지는 양쪽으로 통과시킨다 — 모른다고 없는 것으로 치면
    // 조용히 빠뜨리게 된다 (depths() 의 같은 판단).
    if (e.directed === false) {
      if (!adj.has(e.target)) adj.set(e.target, new Set())
      adj.get(e.target).add(e.source)
    }
  }

  const depth = new Map()
  let frontier = starts.filter((s) => have.has(s))
  for (const s of frontier) depth.set(s, 0)
  let d = 0
  while (frontier.length) {
    d++
    const next = []
    for (const n of frontier) {
      for (const m of adj.get(n) ?? []) {
        if (!depth.has(m)) { depth.set(m, d); next.push(m) }
      }
    }
    frontier = next
  }

  const byDepth = new Map()
  for (const [id, dd] of depth) {
    if (!byDepth.has(dd)) byDepth.set(dd, [])
    byDepth.get(dd).push(id)
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const layers = [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depthN, ids]) => ({
      depth: depthN,
      count: ids.length,
      /**
       * 🔴 시작점(0겹)만은 ②가 정한 순서를 그대로 쓴다.
       *
       * 예전에는 여기서도 줄 수로 정렬했다. 그래서 ②가 1위로 지목한
       * `cmd/syft/main.go`(35줄)가 ③에서는 5번째로 내려가고, 그 위에 예제와
       * 생성기가 앉았다. 같은 화면 두 곳이 같은 질문에 다른 순서를 준 것이다.
       * 신입은 어느 쪽을 믿어야 할지 알 수 없다.
       *
       * 1겹 아래는 크기 순이 맞다 — 거기서는 "무엇이 큰가" 가 읽는 순서다.
       */
      files: (depthN === 0
        ? starts.filter((p) => ids.includes(p)).map((id) => byId.get(id)).filter(Boolean)
        : ids.map((id) => byId.get(id)).sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
      ).map((n) => ({ path: n.id, lines: n.lines })),
    }))

  return { layers, reached: depth.size, total: nodes.length, maxDepth: Math.max(0, d - 1) }
}

/** 계층이 믿을 만한지. 도달률이 낮으면 정적 파싱이 덜 된 것이다. */
const COVERAGE_LOW = 0.4

/**
 * 시작점에서 안 닿는 것을 갈래별로 센다.
 *
 * 🔴 "도달 8%" 는 숫자만 보면 고장으로 읽힌다. 실제로는 아니었다.
 *
 * clips/pattern 은 파일 130개 중 예제가 52개, 테스트가 18개다. 그것들은
 * 라이브러리를 **쓰는** 쪽이라 라이브러리에서 출발하면 당연히 안 닿는다.
 * 안 닿는 게 맞는 것과 못 닿는 것을 같은 숫자에 넣으면, 사용자는 도구가
 * 고장 났다고 판단하거나(그럼 안 쓴다) 코드가 죽었다고 판단한다(그럼 틀린다).
 *
 * 그래서 갈래로 가른다. 남는 "그 밖에" 만이 진짜로 설명이 필요한 몫이다.
 */
const CONSUMER = [
  { key: 'test', label: '테스트', re: /(^|\/)(tests?|spec|__tests__|testing)(\/|$)|(^|\/)test_[^/]*$|_test\.[^/]+$/i },
  { key: 'example', label: '예제', re: /(^|\/)(examples?|samples?|demos?|tutorials?)(\/|$)/i },
  { key: 'doc', label: '문서', re: /(^|\/)(docs?|documentation|website)(\/|$)/i },
  { key: 'build', label: '빌드·도구', re: /(^|\/)(scripts?|tools?|bench(marks?)?|\.github|ci)(\/|$)/i },
]

export function classifyUnreached(ids) {
  const out = CONSUMER.map((c) => ({ key: c.key, label: c.label, count: 0 }))
  let rest = 0
  for (const id of ids) {
    const i = CONSUMER.findIndex((c) => c.re.test(id))
    if (i >= 0) out[i].count++
    else rest++
  }
  return { groups: out.filter((g) => g.count > 0), rest }
}

function stepLayers(nodes, edges, starts, { perLayer = 8 } = {}) {
  const r = layersFrom(nodes, edges, starts)
  const coverage = nodes.length ? r.reached / nodes.length : 0
  const gaps = []

  const reachedSet = new Set(r.layers.flatMap((l) => l.files.map((f) => f.path)))
  const unreachedIds = nodes.map((n) => n.id).filter((id) => !reachedSet.has(id))
  const un = classifyUnreached(unreachedIds)
  // 라이브러리를 쓰는 쪽(예제·테스트·문서)을 뺀 몫. 이쪽이 진짜 도달률이다.
  const consumers = un.groups.reduce((a, g) => a + g.count, 0)
  const coreTotal = nodes.length - consumers
  const coreCoverage = coreTotal > 0 ? r.reached / coreTotal : 0

  if (!starts.length) {
    gaps.push('시작점이 없어 계층을 만들 수 없다 — ②가 먼저다')
  } else if (coreCoverage < COVERAGE_LOW) {
    // 🔴 이게 Go·Java 에서 우리를 물었던 실패다. 그때는 아무 말도 없이
    //    빈 결과를 결과로 내놨다. 이번에는 숫자를 붙여서 말한다.
    //
    // 판정은 **예제·테스트를 뺀** 도달률로 한다. 그것들이 안 닿는 것은
    // 고장이 아니라 방향이 반대라서다 (라이브러리를 쓰는 쪽이다).
    gaps.push(
      `예제·테스트를 뺀 코드 ${coreTotal}개 중 시작점에서 닿는 것이 ${r.reached}개`
      + ` (${Math.round(coreCoverage * 100)}%) 뿐이다. 계층을 전부 믿지 말 것 —`
      + ' 정적 파싱이 못 푼 연결(동적 로딩·리플렉션·설정 기반 등록)이 있거나,'
      + ' 진입점이 더 있다.',
    )
  }
  if (r.layers.length > 1 && r.layers.at(-1).depth >= 12) {
    gaps.push('계층이 12겹을 넘는다 — 순환 import 가 있거나 유틸을 타고 번졌을 수 있다')
  }

  return {
    n: 3,
    key: 'layers',
    question: '그 다음에 무엇이 불리나',
    why: '한 겹씩 내려가면 파일 목록이 호출 순서가 된다. 이 순서가 곧 읽는 순서다.',
    answer: {
      starts,
      /**
       * 🔴 계층 목록 **위에** 방향 있는 체인을 둔다.
       *
       * 벤치마크 기준선에서 신입이 M3 에 도달하는 데 노드를 다섯 번 눌러 손으로
       * 이어붙였고, 방향은 파일명 의미로 추측했다. 계층은 "몇 겹에 몇 개" 를
       * 말할 뿐 "무엇이 무엇을 부르나" 를 말하지 않는다.
       *
       * 시작점은 **하나**만 쓴다 — 여덟 개를 섞으면 그것이 정확히 기준선의
       * 불만이었다("cmd/syft/main.go 단독 경로를 알려주지 않았다").
       */
      chain: starts.length ? importTree(nodes, edges, starts[0]) : null,
      layers: r.layers.map((l) => ({ ...l, files: l.files.slice(0, perLayer), truncated: Math.max(0, l.count - perLayer) })),
      reached: r.reached,
      total: nodes.length,
      coveragePct: Math.round(coverage * 100),
      // 예제·테스트를 뺀 도달률. 화면은 이쪽을 크게 보여준다.
      coreTotal,
      coreCoveragePct: Math.round(coreCoverage * 100),
      unreached: nodes.length - r.reached,
      unreachedBy: un,
    },
    focus: r.layers.slice(0, 3).flatMap((l) => l.files.slice(0, perLayer).map((f) => f.path)),
    focusKind: 'file',
    done: '1겹과 2겹에 무엇이 있는지 말할 수 있고, 그 둘의 역할 차이를 안다.',
    next: '구조를 알았으면, 그중 어디가 실제로 자주 바뀌고 위험한지를 본다.',
    gaps,
  }
}

// ---------------------------------------------------------------------------
// ④⑤
// ---------------------------------------------------------------------------

function stepRisk(entry) {
  // 🔴 키 이름을 지어내지 않는다. entry.mjs 가 쓰는 것은
  //    churn · hub · risk · isolated 다. 처음에 'hot' 이라고 썼더니
  //    조용히 null 이 되어 ④의 절반이 빈 채로 화면에 나갔다 —
  //    빈 목록은 "여기는 활발한 곳이 없다" 로 읽힌다.
  const hot = entry?.lists?.find((l) => l.key === 'churn')
  const risk = entry?.lists?.find((l) => l.key === 'risk')
  const gaps = []
  if (!risk?.rows?.length) gaps.push('숨은 결합이 하나도 안 잡혔다 — 히스토리가 짧거나 공변경 문턱에 못 미쳤다')

  return {
    n: 4,
    key: 'risk',
    question: '어디가 활발하고, 어디가 위험한가',
    why: '구조는 어제의 결정이고 히스토리는 오늘의 현실이다. 둘이 다른 곳이 사고가 나는 곳이다.',
    answer: { hot: hot ?? null, risk: risk ?? null },
    focus: [...(hot?.rows ?? []).slice(0, 5), ...(risk?.rows ?? []).slice(0, 5)].map((r) => r.path),
    focusKind: 'file',
    done: '"여기는 건드리면 같이 깨진다" 라고 말할 수 있는 파일이 하나 있다.',
    next: '위험한 곳을 알았다. 이제 무언가를 새로 만들 차례다.',
    gaps,
  }
}

/**
 * ⑤ 여기에 새로 만들려면 어디를 고치나.
 *
 * 🔴 이 걸음이 없을 때 온보딩 실험이 실패했다.
 *
 * 맥락 없는 에이전트가 ①~④ 를 전부 통과하고도 "새 데이터 소스를 추가하려면
 * 어디를 고치나" 에서 멈췄다. 정확히는 멈추지 않고 **추론했다** —
 * 숨은 결합 점수를 눈으로 조합해서 답을 만들어냈다. 그건 도구가 답한 게 아니다.
 *
 * ④까지는 "읽는" 걸음이고 이것이 첫 번째 "쓰는" 걸음이다. 신입이 실제로
 * 겁내는 자리이기도 하다 — 무엇을 하는 물건인지는 README 가 말해주지만
 * 내가 어디를 건드려야 하는지는 코드를 다 읽은 사람만 안다.
 *
 * 판정은 newfile.mjs 가 한다. 여기는 그 결과를 걸음으로 감싸기만 한다.
 */
function stepAdd(newFile, claims) {
  /**
   * 🔴 "여기를 고쳐라" 와 "그건 지금 누가 잡고 있다" 를 한 화면에서 말한다.
   *
   * 5회차 온보딩 실험의 마지막 지적이 이것이었다 —
   * "새 파일을 추가했을 때 기존 claim 과 충돌할지 시뮬레이션해주지 않는다.
   *  Q3(동반 수정 파일)와 M7(현재 claim)을 사람이 직접 겹쳐봐야 한다."
   *
   * 두 축이 각자 맞는 답을 내는데 서로를 모르면, 그 둘을 겹치는 일은 결국
   * 사람 몫이 된다. 신입이 가장 못 하는 일이 바로 그것이다.
   */
  const points = (newFile?.points ?? []).map((pt) => {
    const owner = (claims ?? []).find((c) => coversPath(c.paths ?? [], pt.path))
    if (!owner) return pt
    return {
      ...pt,
      heldBy: owner.agent ?? null,
      heldTask: owner.task ?? null,
      heldIntent: owner.intent ?? null,
      // 파일을 직접 잡은 것과 폴더에 딸려온 것은 사람에게 다른 정보다.
      heldVia: (owner.paths ?? []).find((q) => coversPath([q], pt.path)) ?? null,
    }
  })
  const clash = points.filter((p) => p.heldBy)

  const gaps = []
  if (!newFile) gaps.push('git 히스토리를 읽지 못해 이 걸음은 답할 수 없다')
  else if (!newFile.answered) gaps.push(newFile.why)
  else if (newFile.capped) gaps.push(`최근 ${newFile.capped}건까지만 봤다 — 그 이전은 세지 않았다`)
  // 거부가 아니라 알림이다. 프로토콜 판정은 건드리지 않는다 (adjacent.mjs 와 같은 원칙).
  if (clash.length) gaps.push(`등록 지점 ${clash.length}곳을 지금 다른 사람이 잡고 있다 — 손대기 전에 알려라`)

  return {
    n: 5,
    key: 'add',
    question: '여기에 새로 만들려면 어디를 고치나',
    why: '누군가 전에 같은 일을 했다. 그때 함께 고친 파일이 등록 지점이다 — 추측이 아니라 관측이다.',
    answer: { ...(newFile ?? { answered: false, points: [], scope: null }), points, clash },
    // 등록 지점을 그래프에서도 비춰준다. 말과 그림이 같은 곳을 가리켜야 믿을 수 있다.
    focus: (newFile?.points ?? []).map((p) => p.path),
    focusKind: 'file',
    done: '"새로 하나 만들면 이 파일들도 같이 고쳐야 한다" 를 말할 수 있다.',
    next: '고칠 곳을 알았다. 손대기 전에 선점한다.',
    gaps,
  }
}

function stepYours(claims) {
  return {
    n: 6,
    key: 'yours',
    question: '이제 당신 차례 — 어디를 잡을 것인가',
    why: '이해가 끝나면 코드를 고친다. 고치기 전에 선점하면 남과 겹치지 않는다 (D14 3단계).',
    answer: {
      active: claims ?? [],
      how: 'axmap claim <경로> --task <작업ID> --intent "<한 줄>"',
    },
    focus: (claims ?? []).flatMap((c) => c.paths ?? []),
    focusKind: 'file',
    done: '내가 고칠 경로를 잡았고, 그것이 남의 것과 겹치지 않는다.',
    next: null,
    gaps: [],
  }
}

// ---------------------------------------------------------------------------

/**
 * 다섯 걸음을 만든다.
 *
 * @param {string} root
 * @param {{nodes:object[], edges:object[]}} graph
 * @param {object} opts
 *   overlay  오버레이 엣지 (④가 쓴다)
 *   entry    entryPoints() 결과 (④가 쓴다)
 *   newFile  registrationPoints() 결과 (⑤가 쓴다)
 *   claims   현재 선점 (⑥이 쓴다)
 */
/**
 * ②걸음의 결과에서 ③이 쓸 시작점을 뽑는다.
 *
 * 🔴 사다리 뷰(`/api/ladder`)가 이걸 그대로 부른다. 예전에는 서버가
 *    `entryPoints()` 로 따로 뽑았는데, 그러면 같은 저장소를 두고 안내록 ③과
 *    오른쪽 사다리가 **서로 다른 시작점**을 쓰게 된다. 신입에게는 그게
 *    "이 도구는 자기 말을 못 지킨다" 로 읽힌다.
 *
 * 1등급이 하나라도 있으면 그것만 쓰는 규칙의 근거는 basicFlow 주석에 있다.
 */
export function startsOf(s2) {
  const pick = (max) => s2.answer.groups.filter((g) => g.rank <= max).flatMap((g) => g.rows.map((r) => r.path))
  const strong = pick(1).length ? pick(1) : pick(2)
  return strong.length ? strong : s2.focus.slice(0, 3)
}

/** 저장소에서 바로 시작점을 얻는다. 사다리처럼 ③ 전체가 필요 없는 쪽을 위해. */
export function entryStarts(root, nodes, edges, opt = {}) {
  return startsOf(stepEnter(root, nodes, edges, opt))
}

export function basicFlow(root, graph, { entry = null, claims = [], edges = null, newFile = null } = {}) {
  const nodes = graph.nodes
  const useEdges = edges ?? graph.edges

  const s1 = stepWhat(root, nodes)
  const s2 = stepEnter(root, nodes, useEdges)
  /**
   * ③은 ②의 결과에 기댄다. 시작점을 헐겁게 잡으면 계층이 부풀어 아무 데서나
   * 출발한 것처럼 된다.
   *
   * 🔴 1등급이 하나라도 있으면 **그것만** 쓴다.
   *
   * 실측(clips/pattern): 2등급까지 썼더니 `test/test_en.py` 와 데모 블록이 든
   * `pattern/text/de/__init__.py` 가 시작점 8개에 섞였다. 이 저장소가 실제로
   * 배포하는 것은 `pattern` 하나다. 매니페스트가 선언한 것이 있는데 추측을
   * 같이 넣을 이유가 없다 — 선언이 곧 저자의 답이다.
   */
  const starts = startsOf(s2)
  const s3 = stepLayers(nodes, useEdges, starts)
  const s4 = stepRisk(entry)
  const s5 = stepAdd(newFile, claims)
  const s6 = stepYours(claims)

  const steps = [s1, s2, s3, s4, s5, s6]
  return {
    steps,
    // 🔴 흐름 전체가 얼마나 믿을 만한지 한 줄로. 걸음마다 gaps 를 내도
    //    사용자가 다섯 개를 다 읽지는 않는다.
    gaps: steps.flatMap((s) => s.gaps.map((g) => ({ step: s.n, text: g }))),
  }
}
