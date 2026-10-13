#!/usr/bin/env node
/**
 * 기준(SSOT) 서버 — 학습 도중에도 지금까지의 기준을 답한다.
 *
 *   node corpus/serve.mjs --data <폴더> [--port 7902]
 *
 *   GET /            사람이 보는 화면
 *   GET /status      지금까지 몇 개를 봤나, 무엇이 쓸 만한가
 *   GET /baseline    스냅샷 전체 (기계용)
 *   GET /ask?lang=python&commits=3000&lines=430&fanout=12
 *                    한 파일을 코퍼스에 비춰본다
 *
 * ── 🔴 답에 반드시 함께 나가는 것 ────────────────────────────────────────
 *
 *   n         몇 개 저장소·파일에서 나온 값인가
 *   조건      어느 언어·규모 칸의 기준인가 (적용 조건 없는 지침은 점성술이다)
 *   version   어느 스냅샷인가 (안 적으면 조언이 소리 없이 바뀐다)
 *   coverage  그 칸에서 우리 파서가 얼마나 보고 있나
 *
 * 표본이 모자라면 **답을 지어내지 않고 모른다고 한다.** 한 번 거짓말한 지침은
 * 그 다음부터 전부 무시당한다.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BINS, MIN_REPOS, SIZE_BUCKETS, bucketOf, cellKey, percentileOf } from './stats.mjs'

const args = process.argv.slice(2)
const flag = (n, d = null) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1] }
const DATA = path.resolve(flag('--data') ?? path.join(process.cwd(), 'corpus-data'))
const PORT = Number(flag('--port') ?? 7902)
const FILE = path.join(DATA, 'baseline.json')

/**
 * 스냅샷을 읽는다.
 *
 * 🔴 캐시하지 않는다. 일꾼이 저장소를 잴 때마다 새로 쓰므로, 캐시하면
 *    "학습 도중에도 지금 기준을 낸다" 는 약속이 깨진다. 파일 하나 읽는
 *    비용은 그 약속보다 싸다. (일꾼은 원자적으로 쓴다 — 반쯤 쓰인 것을 읽지 않는다.)
 */
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return null }
}

/**
 * 레코드 줄 수.
 *
 * 🔴 우리가 우리 규칙을 어긴 자리였다.
 *
 * 처음에는 `readFileSync(...).split('\n').length` 였다. 잘 돌다가
 * `repos.jsonl` 이 **958MB** 가 되자 V8 의 문자열 길이 한계
 * (`Cannot create a string longer than 0x1fffffe8 characters`)에 걸려
 * 던졌고, `catch` 가 그것을 삼켜 **0** 을 냈다.
 *
 * 화면에는 "기록 0" 으로 떴다. 저장소 7,107개를 모아둔 채로.
 * 이 저장소가 락에서 뿌리뽑은 fail-open 이 여기 그대로 있었다 —
 * **없는 것과 못 센 것을 같은 값으로 말한 것.**
 *
 * 고친 것 둘 —
 *   ① 통째로 읽지 않고 조각으로 읽으며 줄바꿈만 센다 (메모리 O(1))
 *   ② 그래도 실패하면 **null 을 낸다.** 화면은 "셀 수 없음" 이라고 말한다.
 *
 * 파일은 덧붙이기 전용이라 크기가 같으면 줄 수도 같다. 크기로 캐시한다 —
 * 매 요청마다 1GB 를 훑으면 서버가 그것만 하게 된다.
 */
let countCache = { size: -1, lines: null }

export function countRecords(file) {
  let size
  try { size = fs.statSync(file).size } catch { return 0 }   // 파일이 없으면 진짜로 0이다
  if (size === countCache.size) return countCache.lines

  let lines = 0
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(1 << 20)
      let read
      while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        for (let i = 0; i < read; i++) if (buf[i] === 10) lines++
      }
    } finally { fs.closeSync(fd) }
  } catch {
    // 🔴 셀 수 없으면 셀 수 없다고 한다. 0 이라고 하지 않는다.
    countCache = { size, lines: null }
    return null
  }
  countCache = { size, lines }
  return lines
}

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body, null, 1))
}

/** 히스토그램을 스냅샷에서 되살린다 (stats() 가 요약만 담으므로 원본이 필요할 때). */
function reconstruct(cellRaw, key) {
  // 스냅샷은 요약만 담는다. 백분위는 요약으로도 근사할 수 있지만, 정확히 하려면
  // 원본 히스토그램이 필요하다. repos.jsonl 을 다시 읽지 않고, 요약의 분위수
  // 사이를 선형 보간해서 답한다 — 근사임을 응답에 적는다.
  return cellRaw
}

/** 요약 분위수(p10..p99) 사이를 보간해 백분위를 추정한다. */
function pctFromStats(s, v) {
  if (!s) return null
  const pts = [[s.p10, 0.10], [s.p25, 0.25], [s.p50, 0.50], [s.p75, 0.75], [s.p90, 0.90], [s.p95, 0.95], [s.p99, 0.99]]
    .filter(([x]) => Number.isFinite(x))
  if (!pts.length) return null
  if (v <= pts[0][0]) return pts[0][1] * (v / (pts[0][0] || 1))
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, p0] = pts[i]
    const [x1, p1] = pts[i + 1]
    if (v <= x1) {
      const f = x1 === x0 ? 0 : (v - x0) / (x1 - x0)
      return p0 + (p1 - p0) * f
    }
  }
  return 0.99   // p99 위 — 얼마나 위인지는 모른다. 외삽하지 않는다.
}

function ask(q) {
  const snap = load()
  if (!snap) return { known: false, why: '아직 스냅샷이 없다 — 일꾼이 첫 저장소를 재는 중이다' }

  const lang = (q.get('lang') ?? '').toLowerCase()
  const commits = Number(q.get('commits'))
  if (!lang || !Number.isFinite(commits)) {
    return { known: false, why: 'lang 과 commits 가 필요하다. 기준은 언어·규모 칸 안에서만 뜻이 있다.' }
  }
  const key = cellKey(lang, commits)
  const cell = key ? snap.cells[key] : null
  if (!cell) {
    return {
      known: false, key,
      why: `이 조건(${lang} · 커밋 ${commits})으로 본 저장소가 아직 없다`,
      haveKeys: Object.keys(snap.cells).filter((k) => snap.cells[k].usable),
    }
  }
  if (!cell.usable) return { known: false, key, why: cell.why, repos: cell.repos }

  const out = {
    known: true,
    key,
    // 🔴 적용 조건. 이게 없으면 지침이 아니라 점성술이다.
    appliesTo: {
      language: lang,
      size: SIZE_BUCKETS.find((b) => b.key === bucketOf(commits))?.label,
      repos: cell.repos,
      files: cell.fileLines?.n ?? 0,
    },
    version: snap.version,
    at: snap.at,
    approx: true,
    // 🔴 우리가 이 칸에서 얼마나 보고 있는지. 낮으면 import 기반 답은 못 믿는다.
    parseCoverage: cell.parseCoverage,
    answers: [],
  }

  const add = (name, label, v, s, outcome) => {
    if (!Number.isFinite(v) || !s) return
    const p = pctFromStats(s, v)
    const t = outcome?.trend
    out.answers.push({
      metric: name,
      label,
      value: v,
      percentile: p === null ? null : Math.round(p * 100),
      median: s.p50,
      p90: s.p90,
      n: s.n,
      // 🔴 "남들은 이만큼 쓴다" 와 "그래서 나중에 더 고치게 된다" 는 다른 말이다.
      //    코퍼스가 결과로 뒷받침하지 못하면 지침을 내지 않는다.
      outcome: !t?.usable ? { usable: false, why: t?.why ?? '표본 부족' }
        : t.direction === 'flat' ? { usable: true, direction: 'flat', say: '이 축은 재수정률과 뚜렷한 관계가 없다 — 길이만으로 판단하지 말 것' }
          : {
            usable: true,
            direction: t.direction,
            ratio: t.ratio,
            say: t.direction === 'up'
              ? `이 축이 클수록 재수정률이 높았다 (아래 ${t.low.toFixed(3)} → 위 ${t.high.toFixed(3)}, ${t.ratio.toFixed(2)}배)`
              : `이 축이 클수록 재수정률이 낮았다 (${t.ratio.toFixed(2)}배)`,
          },
      table: outcome?.table ?? null,
    })
  }

  add('fileLines', '파일 길이(줄)', Number(q.get('lines')), cell.fileLines, cell.outcome?.linesToFix)
  add('fanout', '함께 바뀌는 이웃 수', Number(q.get('fanout')), cell.fanout, cell.outcome?.fanoutToFix)
  add('depth', '디렉터리 깊이', Number(q.get('depth')), cell.depth, cell.outcome?.depthToFix)
  add('fileCommits', '이 파일을 건드린 커밋 수', Number(q.get('commitsOnFile')), cell.fileCommits, null)

  if (!out.answers.length) out.why = 'lines · fanout · depth · commitsOnFile 중 하나는 줘야 한다'
  return out
}

// ---------------------------------------------------------------------------

const PAGE = `<!doctype html><meta charset="utf-8"><title>axMap 기준(SSOT)</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#000;--panel:#0a0a0a;--line:#1e1e1e;--fg:#dcdcdc;--dim:#7a7a7a;--dim2:#4a4a4a;--ok:#7ac4ff;--warn:#e0534a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:13px/1.6 "Pretendard","Malgun Gothic",system-ui,sans-serif;padding:20px;max-width:900px;margin:0 auto}
h1{font-size:16px;margin:0 0 4px}h2{font-size:13px;color:var(--dim);margin:22px 0 8px;font-weight:600}
.sub{color:var(--dim);font-size:11px;margin-bottom:18px}
.card{border:1px solid var(--line);border-radius:6px;padding:12px 14px;background:var(--panel);margin-bottom:10px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:600;font-size:11px}
td.n{text-align:right;font-family:ui-monospace,Consolas,monospace}
.pill{font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid var(--line);color:var(--dim2)}
.pill.ok{color:var(--ok);border-color:#24435a}
.warn{color:var(--warn)}
.note{color:var(--dim);font-size:11px}
code{font-family:ui-monospace,Consolas,monospace;color:var(--dim)}
</style>
<h1>axMap 기준 (SSOT)</h1>
<div class="sub" id="sub">불러오는 중…</div>
<div id="body"></div>
<script>
const f=(x,d=1)=>x==null?'—':(typeof x==='number'?x.toFixed(d).replace(/\\.0+$/,''):x)
fetch('status').then(r=>r.json()).then(s=>{
  document.getElementById('sub').innerHTML =
    '저장소 <b>'+s.reposSeen+'</b>개를 봤고, 그중 <b>'
    + (s.recorded==null ? s.inSnapshot+'</b>개가 기준에 들어갔습니다 (파일 줄 수는 셀 수 없었습니다). '
                        : s.recorded+'</b>개가 기록됐습니다. ')
    + '스냅샷 v'+s.version+' · '+(s.at??'-')
    + '<br>분위수는 히스토그램 근사값입니다. 표본이 모자란 칸은 답하지 않습니다 (저장소 '+s.minRepos+'개 필요).'
  const b=document.getElementById('body')
  if(!s.cells.length){b.innerHTML='<div class="card">아직 아무 칸도 채워지지 않았습니다. 일꾼이 첫 저장소를 재는 중입니다.</div>';return}
  b.innerHTML = s.cells.map(c=>
    '<div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline">'
    + '<b>'+c.key+'</b> <span class="pill '+(c.usable?'ok':'')+'">'+(c.usable?'쓸 수 있음':'표본 부족')+'</span></div>'
    + '<div class="note">저장소 '+c.repos+'개 · 파일 '+(c.files??0).toLocaleString()+'개'
    + ' · 우리 파서 커버리지 '+(c.parseCoverage==null?'—':(c.parseCoverage*100).toFixed(0)+'%')
    + (c.usable?'':' — '+c.why)+'</div>'
    + (c.usable? '<table><tr><th>지표</th><th>중앙값</th><th>상위 10%</th><th>결과와의 관계</th></tr>'
      + c.rows.map(r=>'<tr><td>'+r.label+'</td><td class="n">'+f(r.p50)+'</td><td class="n">'+f(r.p90)
      + '</td><td class="'+(r.dir==='up'?'warn':'')+'">'+r.say+'</td></tr>').join('')+'</table>' : '')
    + '</div>').join('')
})
</script>
<h2>기계로 쓰기</h2>
<div class="card note">
<code>GET baseline</code> — 스냅샷 전체<br>
<code>GET ask?lang=python&commits=3000&lines=430&fanout=12</code> — 파일 하나를 코퍼스에 비춰본다<br>
답에는 언제나 <b>n · 적용 조건 · 스냅샷 버전 · 우리 파서 커버리지</b>가 함께 나갑니다.
</div>
`

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://x:${PORT}`)
  const p = url.pathname.replace(/^.*\/(?=[^/]*$)/, '')   // 하위 경로로 프록시돼도 마지막 마디만 본다

  if (p === '' || p === 'index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(PAGE)
  }
  if (p === 'baseline') {
    const s = load()
    return s ? json(res, s) : json(res, { error: '아직 스냅샷이 없다' }, 503)
  }
  if (p === 'ask') return json(res, ask(url.searchParams))
  if (p === 'status') {
    const s = load()
    const recorded = countRecords(path.join(DATA, 'repos.jsonl'))
    if (!s) return json(res, { reposSeen: 0, recorded, version: 0, at: null, minRepos: MIN_REPOS, cells: [] })
    // 스냅샷이 아는 저장소 수 — 줄 수를 못 셌을 때 대신 쓸 수 있는 값이다.
    const inSnapshot = Object.values(s.cells).reduce((a, c) => a + (c.repos ?? 0), 0)
    const cells = Object.entries(s.cells).map(([key, c]) => ({
      key,
      repos: c.repos,
      files: c.fileLines?.n ?? 0,
      usable: c.usable,
      why: c.why,
      parseCoverage: c.parseCoverage,
      rows: [
        ['파일 길이(줄)', c.fileLines, c.outcome?.linesToFix?.trend],
        ['함께 바뀌는 이웃', c.fanout, c.outcome?.fanoutToFix?.trend],
        ['디렉터리 깊이', c.depth, c.outcome?.depthToFix?.trend],
        ['재수정률', c.fixRate, null],
      ].filter(([, st]) => st).map(([label, st, t]) => ({
        label, p50: st.p50, p90: st.p90, n: st.n,
        dir: t?.direction ?? null,
        say: !t ? '—' : !t.usable ? '표본 부족' :
          t.direction === 'up' ? `클수록 더 고치게 됨 (${t.ratio?.toFixed(2)}배)` :
            t.direction === 'down' ? `클수록 덜 고침 (${t.ratio?.toFixed(2)}배)` : '관계 없음',
      })),
    })).sort((a, b) => b.repos - a.repos)
    return json(res, {
      reposSeen: s.reposSeen ?? 0,
      recorded,
      // recorded 가 null 일 때 화면이 대신 쓸 수 있는 수. 뜻이 다르므로 이름을 나눈다 —
      // recorded 는 "파일에 적힌 줄", inSnapshot 은 "칸에 들어간 저장소" 다.
      inSnapshot,
      version: s.version ?? 0,
      at: s.at,
      minRepos: MIN_REPOS,
      cells,
    })
  }
  json(res, { error: '없는 경로', paths: ['/', '/status', '/baseline', '/ask'] }, 404)
})

/**
 * 🔴 import 만으로 서버가 뜨면 안 된다.
 *
 * 테스트가 `countRecords` 를 쓰려고 이 파일을 import 했더니 포트를 잡으려다
 * EADDRINUSE 로 죽었다. 순수 로직과 부수효과를 섞지 말라는 규칙(CLAUDE.md)이
 * 여기서 지켜지지 않았다. 직접 실행할 때만 듣는다.
 */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`기준 서버  http://127.0.0.1:${PORT}  (데이터 ${DATA})`)
  })
}
