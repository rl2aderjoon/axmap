<#
  axMap MCP 전역 설치 (Windows) — 팀 저장소 밖의 사람도 이 한 줄로 붙는다.

    powershell -ExecutionPolicy Bypass -File axmap\mcp\install.ps1

  🔴 이 파일은 **UTF-8 BOM 으로 저장한다. BOM 을 지우지 마라.**

  Windows PowerShell 5.1 은 BOM(**파일 맨 앞에 붙는 3바이트 표식. "이 파일은
  UTF-8 이다" 를 알린다**)이 없는 스크립트를 UTF-8 이 아니라 시스템 ANSI 코드페이지
  (한국어 윈도우면 CP949)로 읽는다. 이 파일에는 한글이 가득하고, CP949 디코더는
  한글의 UTF-8 바이트를 잘못 묶으면서 뒤따르는 ASCII 바이트까지 삼킨다. 삼켜지는
  것이 하필 겹따옴표나 줄바꿈이면 문자열이 엉뚱한 곳에서 닫히고 **파일 전체가
  문법 오류**가 된다. 고친 줄과 아무 상관없는 줄 번호에 "Unexpected token" 이 뜬다.
  같은 사고가 저장소 루트의 setup.ps1 에서 실제로 한 번 났다.

  고친 뒤에는 문법 검사를 돌린다 (npm test 는 이 파일을 실행하지 않는다):
    $t=$null; $e=$null
    [System.Management.Automation.Language.Parser]::ParseFile('axmap\mcp\install.ps1',[ref]$t,[ref]$e)
    $e.Count   # 0 이어야 한다

  ── 무엇을 하나 ───────────────────────────────────────────────────────────

    1. node 20 이상이 있는지 본다
    2. 이 PC 에서 쓸 이름을 정한다 (사람마다 달라야 한다)
    3. axMap 을 %USERPROFILE%\.axmap\app 으로 복사한다
    4. node ...\tools\mcp-register.mjs 로 이 PC 의 AI CLI 에 등록한다
    5. CLI 마다 붙었는지 한 줄씩 찍고, 하나라도 실패하면 종료 코드 1 을 낸다

  ── 왜 홈 디렉터리에 복사하나 ─────────────────────────────────────────────

  목표가 "아무 저장소에서나 붙는다" 이기 때문이다. 작업할 저장소 안에 axMap 파일을
  하나도 남기지 않는다 — 남기면 남의 저장소에 우리 파일이 커밋되거나, 남의
  .gitignore 를 고치게 만든다. 프로그램은 홈에, 데이터(장부)는 대상 저장소에.

  git clone 이 아니라 복사인 이유: git 이 없어도 설치가 끝나야 한다. 여기까지
  왔다는 것은 이미 axMap 파일을 어떤 방법으로든 손에 넣었다는 뜻이다.

  ── 🔴 AXMAP_REPO 는 어디에도 적지 않는다 ─────────────────────────────────

  MCP 서버는 도구를 부를 때마다 대상 저장소를 다시 정한다(axmap/docs/DECISIONS.md 의
  D19). 그 순서의 맨 위가 AXMAP_REPO 다. 전역 등록인데 여기에 한 폴더를 박아 두면
  다른 저장소를 열어도 아무 오류 없이 엉뚱한 장부에 claim 이 쌓인다.
  비워 두면 CLI 를 켠 폴더가 그대로 대상이 된다.

  ── 🔴 AXMAP_AGENT 는 반대로 반드시 적는다 ────────────────────────────────

  tools\mcp-register.mjs 는 이름을 어디에도 적지 않는다. 그건 저장소에 커밋되는
  .mcp.json 에 이름이 들어가면 clone 한 모두가 한 사람이 되기 때문이고, 그 판단은
  옳다. 여기는 사정이 다르다 — 우리가 쓰는 곳은 %USERPROFILE% 아래의 개인 설정이라
  커밋되지 않는다. 그리고 전역 설치는 팀 저장소가 아닌 폴더에서도 뜨는데, 그런
  폴더에는 git config user.name 이 없을 수 있다. 그러면 서버가 이름을 못 정하고
  그냥 죽는다(exit 1). 그래서 설치할 때 사람마다 다른 이름을 한 번 박아 둔다.
#>
param(
  [string]$Source = '',
  [string]$Dest   = '',
  [string]$Name   = ''
)

$ErrorActionPreference = 'Stop'

function Say($m)  { Write-Host $m }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Hm($m)   { Write-Host "  ~~  $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  !!  $m" -ForegroundColor Red }
function Fail($m) { Write-Host ''; Write-Host "중단: $m" -ForegroundColor Red; exit 1 }

# ── 이 아래 세 개의 JS 조각은 install.sh 의 것과 같아야 한다 ─────────────────
#
# 셸 두 벌에 같은 판단을 적으면 반드시 한쪽만 고쳐지고, 그 순간 두 OS 의 사용자가
# 서로 다른 설정을 갖게 된다. 그래서 판단은 node 에 몰아넣고 셸은 부르기만 한다.
# (한 파일로 합치지 못한 이유: 이 작업은 파일 넷 안에서 끝나야 했다.)

# 이름이 쓸 수 있는 이름인지 — 저장소의 검사기를 그대로 부른다. 여기서 다시 짜면
# 설치기가 통과시킨 이름을 서버가 거부하는 일이 생긴다.
$JS_NAME = @'
const { pathToFileURL } = require('url')
import(pathToFileURL(process.argv[1]).href).then((m) => {
  const err = m.agentNameError(process.argv[2])
  if (err) { console.error(err); process.exit(1) }
})
'@

# Claude Code 의 user 범위 등록(~/.claude.json)을 들여다본다.
#   NONE 없다 / OTHER 다른 것이 들어 있다 / MATCH 원하는 그대로 / UNREADABLE 못 읽었다
$JS_CLAUDE = @'
const fs = require('fs'), path = require('path'), os = require('os')
const file = path.join(os.homedir(), '.claude.json')
const want = process.argv[1], name = process.argv[2]
let raw = null
try { raw = fs.readFileSync(file, 'utf8') } catch (e) { console.log('NONE'); process.exit(0) }
let cfg = null
try { cfg = JSON.parse(raw) } catch (e) { console.log('UNREADABLE'); process.exit(0) }
const s = cfg && cfg.mcpServers && cfg.mcpServers.axmap
if (!s) { console.log('NONE'); process.exit(0) }
const argsOk = String((s.args || [])[0]) === want
const nameOk = (s.env || {}).AXMAP_AGENT === name
console.log(argsOk && nameOk ? 'MATCH' : 'OTHER')
'@

# Antigravity(agy) 의 전역 설정에 이름만 덧쓴다.
# 항목 자체는 mcp-register 가 만든다. 여기서는 AXMAP_AGENT 한 줄을 더할 뿐이다.
# 🔴 항목이 우리 서버를 가리킬 때만 손댄다. 남이 만든 axmap 항목을 덮어쓰지 않는다.
$JS_AGY = @'
const fs = require('fs'), path = require('path'), os = require('os')
const file = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json')
const want = process.argv[1], name = process.argv[2]
let raw = null
try { raw = fs.readFileSync(file, 'utf8') } catch (e) { console.log('NONE'); process.exit(0) }
let cfg = null
try { cfg = JSON.parse(raw) } catch (e) { console.log('UNREADABLE'); process.exit(0) }
const s = cfg && cfg.mcpServers && cfg.mcpServers.axmap
if (!s) { console.log('NONE'); process.exit(0) }
if (String((s.args || [])[0]) !== want) { console.log('OTHER'); process.exit(0) }
s.env = s.env || {}
if (s.env.AXMAP_AGENT === name) { console.log('MATCH'); process.exit(0) }
s.env.AXMAP_AGENT = name
try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n') }
catch (e) { console.log('WRITEFAIL'); process.exit(0) }
console.log('STAMPED')
'@

Say ''
Say 'axMap MCP 전역 설치'
Say ''

# ── 1. node ─────────────────────────────────────────────────────────────────
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Fail 'node 를 찾을 수 없습니다. Node 20 이상을 설치한 뒤 다시 실행하세요.' }
$ver = (& node --version) -replace '^v', ''
if ([int](($ver -split '\.')[0]) -lt 20) { Fail "Node $ver 입니다. 20 이상이 필요합니다." }
Ok "node $ver"

# ── 2. 원본 ─────────────────────────────────────────────────────────────────
#
# 기본값은 이 스크립트가 들어 있는 axmap\ 폴더다. 저장소 루트를 -Source 로 줘도
# 알아듣는다 — 사람이 둘을 자주 헷갈리는데, 여기서 틀리면 "파일이 없습니다" 만 보인다.
if ($Source -eq '') { $Source = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path -LiteralPath $Source)) { Fail "원본 폴더가 없습니다: $Source" }
$Source = (Resolve-Path -LiteralPath $Source).Path
if (-not (Test-Path -LiteralPath (Join-Path $Source 'bin\axmap.mjs'))) {
  $inner = Join-Path $Source 'axmap'
  if (Test-Path -LiteralPath (Join-Path $inner 'bin\axmap.mjs')) { $Source = (Resolve-Path -LiteralPath $inner).Path }
}
foreach ($need in @('bin\axmap.mjs', 'mcp\server.mjs', 'src\protocol.mjs', 'tools\mcp-register.mjs', 'app\lib\agentcli.mjs', 'package.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source $need))) {
    Fail @"
axMap 원본이 온전하지 않습니다. 없는 파일: $need
  본 곳: $Source

이 스크립트만 따로 내려받으면 설치할 수 없습니다. 저장소를 통째로 받은 뒤
그 안의 axmap\mcp\install.ps1 을 실행하거나, -Source 로 axmap\ 폴더를 지정하세요.
"@
  }
}
Ok "원본 $Source"

# ── 3. 이름 ─────────────────────────────────────────────────────────────────
#
# [!] 여기서 모두에게 같은 기본값을 주면 안 된다. 장부에 한 명만 존재하게 되고,
#     겹침 판정은 자기 claim 을 겹침으로 보지 않으므로 팀 전원이 서로의 영역을
#     아무 경고 없이 덮어쓴다. 락이 조용히 여러 명에게 발급되는 것이고, 그게 이
#     도구가 막으려는 사고 그 자체다.
#
#     그래서 이 PC 에서 사람마다 이미 다른 값만 후보로 쓴다. 사람에게 묻지는
#     않는다 — 물어보는 순간 AI 에이전트가 대신 지어낸다.
#
# 🔴 이름은 이 스크립트를 켠 폴더의 git 설정에서 나온다. git 은 저장소 안이면
#    그 저장소의 user.name 을, 밖이면 전역 user.name 을 답한다. 그래서 앞으로
#    일할 저장소 안에서 실행하는 것이 맞다 — 그래야 MCP 가 쓰는 이름과, 같은
#    저장소에서 손으로 axmap 을 칠 때의 이름이 같아진다. 다르면 한 사람이 장부에서
#    둘이 되고, 자기가 잡은 것을 자기가 반납하지 못한다(release 종료 코드 5).
$nameFrom = '-Name 인자'
if ($Name -eq '') {
  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if ($gitCmd) {
    $g = (& git config user.name)
    if ($LASTEXITCODE -eq 0 -and $g) { $Name = "$g".Trim(); $nameFrom = 'git config user.name' }
  }
}
if ($Name -eq '' -and $env:USERNAME) { $Name = "$env:USERNAME".Trim(); $nameFrom = 'Windows 사용자 이름' }
if ($Name -eq '' -and $env:COMPUTERNAME) { $Name = "$env:COMPUTERNAME".Trim(); $nameFrom = '컴퓨터 이름' }
if ($Name -eq '') { Fail '이 PC 에서 쓸 이름을 정하지 못했습니다. -Name "홍길동" 으로 직접 주세요.' }

& node -e $JS_NAME (Join-Path $Source 'src\protocol.mjs') $Name
if ($LASTEXITCODE -ne 0) { Fail "이 이름은 장부에서 쓸 수 없습니다: $Name  (-Name 으로 다른 이름을 주세요)" }
Ok "이름 $Name  ($nameFrom)"

# ── 4. 복사 ─────────────────────────────────────────────────────────────────
#
# [!] 이미 설치돼 있어도 묻지 않고 갱신한다. 물어보는 설치기는 AI 에이전트가
#     실행할 수 없다 — 프롬프트 앞에서 멈춰 버린다. 대신 무엇을 갱신했는지 찍는다.
$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = $HOME }
if ($Dest -eq '') { $Dest = Join-Path $homeDir '.axmap\app' }

Say ''
Say "복사합니다 -> $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# desktop\ 은 뺀다. Electron 껍데기라 MCP 에 필요 없고 node_modules 가 수백 MB 다.
foreach ($item in @('bin', 'src', 'mcp', 'tools', 'app', 'package.json', 'LICENSE')) {
  $from = Join-Path $Source $item
  $to   = Join-Path $Dest $item
  if (-not (Test-Path -LiteralPath $from)) { Hm "$item 없음 — 건너뜁니다"; continue }

  $verb = '새로'
  if (Test-Path -LiteralPath $to) { $verb = '갱신'; Remove-Item -LiteralPath $to -Recurse -Force }
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force

  if (Test-Path -LiteralPath $to -PathType Container) {
    # 혹시 원본에 node_modules 가 딸려 있으면 여기서 뗀다. 크고, 쓰지도 않는다.
    Get-ChildItem -LiteralPath $to -Recurse -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    $n = @(Get-ChildItem -LiteralPath $to -Recurse -File).Count
    Ok "$verb  $item  ($n 개 파일)"
  } else {
    Ok "$verb  $item"
  }
}

& node (Join-Path $Dest 'tools\run.mjs') install-runtime $Source
if ($LASTEXITCODE -ne 0) { Fail '터미널 런타임 설치에 실패했습니다.' }

$server = Join-Path $Dest 'mcp\server.mjs'
if (-not (Test-Path -LiteralPath $server)) { Fail "복사가 끝났는데 서버가 없습니다: $server" }

# ── 5. 등록 ─────────────────────────────────────────────────────────────────
#
# 이 PC 에 어떤 CLI 가 있는지 찾고 각자의 설정에 넣는 일은 tools\mcp-register.mjs 가
# 이미 한다. 여기서 다시 짜지 않는다.
Say ''
& node (Join-Path $Dest 'tools\mcp-register.mjs')
if ($LASTEXITCODE -ne 0) { Fail 'AI CLI 전역 등록을 확인하지 못했습니다. 위 오류를 해결하고 setup을 다시 실행하세요.' }
Say '      (위에 claude 가 ".mcp.json 이 없습니다" 로 나왔다면, 그건 "저장소 안의'
Say '       .mcp.json" 을 찾는 검사입니다. 전역 설치에는 그 파일이 없는 것이 정상이고,'
Say '       Claude Code 는 바로 아래에서 따로 등록합니다.)'

# ── 6. CLI 마다 붙었는지 확인한다 ────────────────────────────────────────────
#
# 🔴 여기가 이 스크립트가 mcp-register 위에 얹는 유일한 층이다.
#
#    mcp-register 의 안내는 if (!any) 라서 셋 중 하나라도 찾으면 아무 말이 없다.
#    Claude Code 만 깔린 PC 에서 Codex 로 일하는 사람은 "OK claude" 만 보고 자기
#    도구는 안 붙은 채 넘어간다. 그래서 여기서 CLI 마다 한 줄씩 찍는다.
#
#    그리고 mcp-register 는 Claude Code 에 아무것도 등록하지 않는다 — 저장소의
#    .mcp.json 이 알아서 발견되는 것에 기대기 때문이다. 전역 설치에는 그 파일이
#    없으므로 여기서 user 범위(이 PC 의 모든 폴더에 적용되는 개인 설정)로 직접 넣는다.
$stClaude = ''; $whyClaude = ''
$stAgy    = ''; $whyAgy    = ''
$stCodex  = ''; $whyCodex  = ''

# Claude Code
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  $stClaude = 'skip'; $whyClaude = '이 PC 에 claude 가 없습니다'
} else {
  $before = "$(& node -e $JS_CLAUDE $server $Name)".Trim()
  if ($before -eq 'UNREADABLE') {
    $stClaude = 'fail'; $whyClaude = '~/.claude.json 을 읽지 못했습니다 — 건드리지 않았습니다'
  } elseif ($before -eq 'MATCH') {
    $stClaude = 'ok'; $whyClaude = '이미 그대로 등록돼 있습니다 (user 범위)'
  } else {
    if ($before -eq 'OTHER') { & claude mcp remove -s user axmap | Out-Null }
    & claude mcp add -s user axmap -e "AXMAP_AGENT=$Name" -e 'AXMAP_ACTOR=agent' -e 'AXMAP_TTL=45m' '--' node $server | Out-Null
    $after = "$(& node -e $JS_CLAUDE $server $Name)".Trim()
    if ($after -eq 'MATCH') { $stClaude = 'ok'; $whyClaude = 'user 범위에 등록했습니다 (~/.claude.json)' }
    else { $stClaude = 'fail'; $whyClaude = "claude mcp add 뒤에도 확인되지 않습니다 ($after)" }
  }
}

# Antigravity (agy) — 항목은 mcp-register 가 만들고, 이름만 여기서 덧쓴다
if (-not (Get-Command agy -ErrorAction SilentlyContinue)) {
  $stAgy = 'skip'; $whyAgy = '이 PC 에 agy 가 없습니다'
} else {
  $r = "$(& node -e $JS_AGY $server $Name)".Trim()
  if ($r -eq 'STAMPED' -or $r -eq 'MATCH') {
    $stAgy = 'ok'; $whyAgy = '~/.gemini/config/mcp_config.json (전역) — 이름까지 적었습니다'
  } elseif ($r -eq 'NONE') {
    $stAgy = 'fail'; $whyAgy = 'mcp_config.json 에 axmap 항목이 없습니다 — 위 mcp-register 줄을 보세요'
  } elseif ($r -eq 'OTHER') {
    $stAgy = 'fail'; $whyAgy = 'axmap 항목이 다른 서버를 가리킵니다 — 건드리지 않았습니다'
  } elseif ($r -eq 'WRITEFAIL') {
    $stAgy = 'fail'; $whyAgy = 'mcp_config.json 에 쓰지 못했습니다 (권한 또는 잠금)'
  } else {
    $stAgy = 'fail'; $whyAgy = 'mcp_config.json 을 읽지 못했습니다 — 건드리지 않았습니다'
  }
}

# Codex — 등록은 mcp-register 가 codex 자신의 명령으로 한다. 여기서는 확인만 한다.
#
# 🔴 이름(AXMAP_AGENT)은 codex 설정에 넣지 못한다. mcp-register 가 codex mcp add 를
#    부를 때 이름을 빼고 부르고, 이미 등록돼 있으면 다시 부르지도 않기 때문이다.
#    확인 안 된 도구(이 팀에 codex 가 있는 PC 가 아직 없다)의 설정을 우리가 추측으로
#    덮어쓰는 것보다, 한 줄을 손으로 넣게 하는 편이 낫다.
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
  $stCodex = 'skip'; $whyCodex = '이 PC 에 codex 가 없습니다'
} else {
  $listed = "$(& codex mcp list)"
  if ($listed -match 'axmap') {
    $stCodex = 'ok'
    $whyCodex = '~/.codex/config.toml (codex mcp list로 확인). 작업 repo는 실행 위치에서 결정하고 이름은 git 설정을 사용합니다.'
  } else {
    $stCodex = 'fail'; $whyCodex = 'codex mcp list 에 axmap 이 없습니다 — 위 TOML 조각을 손으로 넣으세요'
  }
}

# ── 7. 보고 ─────────────────────────────────────────────────────────────────
#
# [!] "설치했습니다" 한 줄로 끝내지 않는다. 이 도구의 실패는 대부분 조용해서,
#     오류가 안 났다는 것이 붙었다는 뜻이 아니다. CLI 마다 한 줄씩 찍는다.
function Line($label, $st, $why) {
  if ($st -eq 'ok')   { Ok  ("$label".PadRight(8) + $why); return }
  if ($st -eq 'skip') { Hm  ("$label".PadRight(8) + "$why (건너뜀 — 실패가 아닙니다)"); return }
  Bad ("$label".PadRight(8) + $why)
}

Say ''
Say '등록 결과'
Line 'claude' $stClaude $whyClaude
Line 'agy'    $stAgy    $whyAgy
Line 'codex'  $stCodex  $whyCodex

Say ''
Say "설치 위치: $Dest"
Say "이 PC 의 이름: $Name  ($nameFrom)"
Say ''

$failed = @(@($stClaude, $stAgy, $stCodex) | Where-Object { $_ -eq 'fail' })
if ($failed.Count -gt 0) {
  Say '🔴 위의 !! 줄이 남아 있습니다. 그 CLI 에서는 axMap 이 뜨지 않습니다.'
  Say ''
  exit 1
}

$good = @(@($stClaude, $stAgy, $stCodex) | Where-Object { $_ -eq 'ok' })
if ($good.Count -eq 0) {
  Say '🔴 이 PC 에서 AI CLI 를 하나도 찾지 못했습니다. 설치한 뒤 이 스크립트를 다시 실행하세요.'
  Say ''
  exit 1
}

Say '다음: AI CLI 를 완전히 껐다가 다시 켠 뒤, 작업할 저장소에서 "ax_status 로 지금 누가 뭘 잡고 있는지 보여줘" 라고 시켜 보세요.'
Say ''
exit 0
