#!/usr/bin/env bash
#
# axMap MCP 전역 설치 (macOS / Linux) — 팀 저장소 밖의 사람도 이 한 줄로 붙는다.
#
#   bash axmap/mcp/install.sh
#
# ── 무엇을 하나 ─────────────────────────────────────────────────────────────
#
#   1. node 20 이상이 있는지 본다
#   2. 이 PC 에서 쓸 이름을 정한다 (사람마다 달라야 한다)
#   3. axMap 을 ~/.axmap/app 으로 복사한다
#   4. node ~/.axmap/app/tools/mcp-register.mjs 로 이 PC 의 AI CLI 에 등록한다
#   5. CLI 마다 붙었는지 한 줄씩 찍고, 하나라도 실패하면 종료 코드 1 을 낸다
#
# ── 왜 홈 디렉터리에 복사하나 ───────────────────────────────────────────────
#
# 목표가 "아무 저장소에서나 붙는다" 이기 때문이다. 작업할 저장소 안에 axMap 파일을
# 하나도 남기지 않는다 — 남기면 남의 저장소에 우리 파일이 커밋되거나, 남의
# .gitignore 를 고치게 만든다. 프로그램은 홈에, 데이터(장부)는 대상 저장소에.
#
# git clone 이 아니라 복사인 이유: git 이 없어도 설치가 끝나야 한다. 여기까지 왔다는
# 것은 이미 axMap 파일을 어떤 방법으로든 손에 넣었다는 뜻이다.
#
# ── 🔴 AXMAP_REPO 는 어디에도 적지 않는다 ───────────────────────────────────
#
# MCP 서버는 도구를 부를 때마다 대상 저장소를 다시 정한다(axmap/docs/DECISIONS.md 의
# D19). 그 순서의 맨 위가 AXMAP_REPO 다. 전역 등록인데 여기에 한 폴더를 박아 두면
# 다른 저장소를 열어도 아무 오류 없이 엉뚱한 장부에 claim 이 쌓인다.
# 비워 두면 CLI 를 켠 폴더가 그대로 대상이 된다.
#
# ── 🔴 AXMAP_AGENT 는 반대로 반드시 적는다 ──────────────────────────────────
#
# tools/mcp-register.mjs 는 이름을 어디에도 적지 않는다. 그건 저장소에 커밋되는
# .mcp.json 에 이름이 들어가면 clone 한 모두가 한 사람이 되기 때문이고, 그 판단은
# 옳다. 여기는 사정이 다르다 — 우리가 쓰는 곳은 홈 디렉터리 아래의 개인 설정이라
# 커밋되지 않는다. 그리고 전역 설치는 팀 저장소가 아닌 폴더에서도 뜨는데, 그런
# 폴더에는 git config user.name 이 없을 수 있다. 그러면 서버가 이름을 못 정하고
# 그냥 죽는다(exit 1). 그래서 설치할 때 사람마다 다른 이름을 한 번 박아 둔다.
#
# ── 이 파일과 install.ps1 은 짝이다 ─────────────────────────────────────────
#
# 한쪽만 고치면 두 OS 의 사용자가 서로 다른 설정을 갖게 된다. 아래 세 개의 JS
# 조각은 install.ps1 의 것과 글자까지 같아야 한다 — 판단은 node 에 몰아넣고 셸은
# 부르기만 한다. (한 파일로 합치지 못한 이유: 이 작업은 파일 넷 안에서 끝나야 했다.)

set -u

SOURCE=''
DEST=''
NAME=''

while [ $# -gt 0 ]; do
  case "$1" in
    --source) SOURCE="${2:-}"; shift 2 ;;
    --dest)   DEST="${2:-}";   shift 2 ;;
    --name)   NAME="${2:-}";   shift 2 ;;
    -h|--help)
      echo "사용법: bash install.sh [--source <axmap 폴더>] [--dest <설치 위치>] [--name <내 이름>]"
      exit 0 ;;
    *) echo "모르는 인자: $1"; exit 1 ;;
  esac
done

if [ -t 1 ]; then C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
else C_G=''; C_Y=''; C_R=''; C_0=''; fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s  OK  %s%s\n' "$C_G" "$*" "$C_0"; }
hm()   { printf '%s  ~~  %s%s\n' "$C_Y" "$*" "$C_0"; }
bad()  { printf '%s  !!  %s%s\n' "$C_R" "$*" "$C_0"; }
fail() { printf '\n%s중단: %s%s\n\n' "$C_R" "$*" "$C_0"; exit 1; }

# 이름이 쓸 수 있는 이름인지 — 저장소의 검사기를 그대로 부른다. 여기서 다시 짜면
# 설치기가 통과시킨 이름을 서버가 거부하는 일이 생긴다.
JS_NAME=$(cat <<'JSEOF'
const { pathToFileURL } = require('url')
import(pathToFileURL(process.argv[1]).href).then((m) => {
  const err = m.agentNameError(process.argv[2])
  if (err) { console.error(err); process.exit(1) }
})
JSEOF
)

# Claude Code 의 user 범위 등록(~/.claude.json)을 들여다본다.
#   NONE 없다 / OTHER 다른 것이 들어 있다 / MATCH 원하는 그대로 / UNREADABLE 못 읽었다
JS_CLAUDE=$(cat <<'JSEOF'
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
JSEOF
)

# Antigravity(agy) 의 전역 설정에 이름만 덧쓴다.
# 항목 자체는 mcp-register 가 만든다. 여기서는 AXMAP_AGENT 한 줄을 더할 뿐이다.
# 🔴 항목이 우리 서버를 가리킬 때만 손댄다. 남이 만든 axmap 항목을 덮어쓰지 않는다.
JS_AGY=$(cat <<'JSEOF'
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
JSEOF
)

say ''
say 'axMap MCP 전역 설치'
say ''

# ── 1. node ─────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || fail 'node 를 찾을 수 없습니다. Node 20 이상을 설치한 뒤 다시 실행하세요.'
VER=$(node --version | sed 's/^v//')
MAJOR=${VER%%.*}
[ "$MAJOR" -ge 20 ] 2>/dev/null || fail "Node $VER 입니다. 20 이상이 필요합니다."
ok "node $VER"

# ── 2. 원본 ─────────────────────────────────────────────────────────────────
#
# 기본값은 이 스크립트가 들어 있는 axmap/ 폴더다. 저장소 루트를 --source 로 줘도
# 알아듣는다 — 사람이 둘을 자주 헷갈리는데, 여기서 틀리면 "파일이 없습니다" 만 보인다.
HERE=$(cd "$(dirname "$0")" && pwd)
[ -n "$SOURCE" ] || SOURCE=$(dirname "$HERE")
[ -d "$SOURCE" ] || fail "원본 폴더가 없습니다: $SOURCE"
SOURCE=$(cd "$SOURCE" && pwd)
if [ ! -f "$SOURCE/bin/axmap.mjs" ] && [ -f "$SOURCE/axmap/bin/axmap.mjs" ]; then
  SOURCE=$(cd "$SOURCE/axmap" && pwd)
fi
for need in bin/axmap.mjs mcp/server.mjs src/protocol.mjs tools/mcp-register.mjs src/agentcli.mjs package.json; do
  if [ ! -e "$SOURCE/$need" ]; then
    fail "axMap 원본이 온전하지 않습니다. 없는 파일: $need
  본 곳: $SOURCE

이 스크립트만 따로 내려받으면 설치할 수 없습니다. 저장소를 통째로 받은 뒤
그 안의 axmap/mcp/install.sh 를 실행하거나, --source 로 axmap/ 폴더를 지정하세요."
  fi
done
ok "원본 $SOURCE"

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
NAME_FROM='--name 인자'
if [ -z "$NAME" ] && command -v git >/dev/null 2>&1; then
  G=$(git config user.name 2>/dev/null || true)
  if [ -n "$G" ]; then NAME="$G"; NAME_FROM='git config user.name'; fi
fi
if [ -z "$NAME" ]; then
  U=$(id -un 2>/dev/null || true)
  if [ -n "$U" ]; then NAME="$U"; NAME_FROM='OS 사용자 이름'; fi
fi
if [ -z "$NAME" ]; then
  H=$(hostname 2>/dev/null || true)
  if [ -n "$H" ]; then NAME="$H"; NAME_FROM='호스트 이름'; fi
fi
[ -n "$NAME" ] || fail '이 PC 에서 쓸 이름을 정하지 못했습니다. --name "홍길동" 으로 직접 주세요.'

node -e "$JS_NAME" "$SOURCE/src/protocol.mjs" "$NAME" \
  || fail "이 이름은 장부에서 쓸 수 없습니다: $NAME  (--name 으로 다른 이름을 주세요)"
ok "이름 $NAME  ($NAME_FROM)"

# ── 4. 복사 ─────────────────────────────────────────────────────────────────
#
# [!] 이미 설치돼 있어도 묻지 않고 갱신한다. 물어보는 설치기는 AI 에이전트가
#     실행할 수 없다 — 프롬프트 앞에서 멈춰 버린다. 대신 무엇을 갱신했는지 찍는다.
[ -n "$DEST" ] || DEST="$HOME/.axmap/app"
say ''
say "복사합니다 -> $DEST"
mkdir -p "$DEST" || fail "설치 폴더를 만들지 못했습니다: $DEST"

# Copy the CLI, MCP and their shared runtime sources.
for item in bin src mcp tools package.json LICENSE; do
  from="$SOURCE/$item"
  to="$DEST/$item"
  if [ ! -e "$from" ]; then hm "$item 없음 — 건너뜁니다"; continue; fi

  verb='새로'
  if [ -e "$to" ]; then verb='갱신'; rm -rf "$to"; fi
  cp -R "$from" "$to" || fail "복사하지 못했습니다: $item"

  if [ -d "$to" ]; then
    # 혹시 원본에 node_modules 가 딸려 있으면 여기서 뗀다. 크고, 쓰지도 않는다.
    find "$to" -type d -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
    n=$(find "$to" -type f | wc -l | tr -d ' ')
    ok "$verb  $item  ($n 개 파일)"
  else
    ok "$verb  $item"
  fi
done

node "$DEST/tools/run.mjs" install-runtime "$SOURCE" || fail "터미널 런타임 설치에 실패했습니다."

SERVER="$DEST/mcp/server.mjs"
[ -f "$SERVER" ] || fail "복사가 끝났는데 서버가 없습니다: $SERVER"

# ── 5. 등록 ─────────────────────────────────────────────────────────────────
#
# 이 PC 에 어떤 CLI 가 있는지 찾고 각자의 설정에 넣는 일은 tools/mcp-register.mjs 가
# 이미 한다. 여기서 다시 짜지 않는다.
say ''
node "$DEST/tools/mcp-register.mjs" || fail 'AI CLI 전역 등록을 확인하지 못했습니다. 위 오류를 해결하고 setup을 다시 실행하세요.'
say '      (위에 claude 가 ".mcp.json 이 없습니다" 로 나왔다면, 그건 "저장소 안의'
say '       .mcp.json" 을 찾는 검사입니다. 전역 설치에는 그 파일이 없는 것이 정상이고,'
say '       Claude Code 는 바로 아래에서 따로 등록합니다.)'

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
ST_CLAUDE=''; WHY_CLAUDE=''
ST_AGY='';    WHY_AGY=''
ST_CODEX='';  WHY_CODEX=''

if ! command -v claude >/dev/null 2>&1; then
  ST_CLAUDE='skip'; WHY_CLAUDE='이 PC 에 claude 가 없습니다'
else
  BEFORE=$(node -e "$JS_CLAUDE" "$SERVER" "$NAME")
  if [ "$BEFORE" = 'UNREADABLE' ]; then
    ST_CLAUDE='fail'; WHY_CLAUDE='~/.claude.json 을 읽지 못했습니다 — 건드리지 않았습니다'
  elif [ "$BEFORE" = 'MATCH' ]; then
    ST_CLAUDE='ok'; WHY_CLAUDE='이미 그대로 등록돼 있습니다 (user 범위)'
  else
    if [ "$BEFORE" = 'OTHER' ]; then claude mcp remove -s user axmap >/dev/null 2>&1 || true; fi
    claude mcp add -s user axmap \
      -e "AXMAP_AGENT=$NAME" -e 'AXMAP_ACTOR=agent' -e 'AXMAP_TTL=45m' \
      -- node "$SERVER" >/dev/null 2>&1 || true
    AFTER=$(node -e "$JS_CLAUDE" "$SERVER" "$NAME")
    if [ "$AFTER" = 'MATCH' ]; then
      ST_CLAUDE='ok'; WHY_CLAUDE='user 범위에 등록했습니다 (~/.claude.json)'
    else
      ST_CLAUDE='fail'; WHY_CLAUDE="claude mcp add 뒤에도 확인되지 않습니다 ($AFTER)"
    fi
  fi
fi

# Antigravity (agy) — 항목은 mcp-register 가 만들고, 이름만 여기서 덧쓴다
if ! command -v agy >/dev/null 2>&1; then
  ST_AGY='skip'; WHY_AGY='이 PC 에 agy 가 없습니다'
else
  R=$(node -e "$JS_AGY" "$SERVER" "$NAME")
  case "$R" in
    STAMPED|MATCH) ST_AGY='ok';   WHY_AGY='~/.gemini/config/mcp_config.json (전역) — 이름까지 적었습니다' ;;
    NONE)          ST_AGY='fail'; WHY_AGY='mcp_config.json 에 axmap 항목이 없습니다 — 위 mcp-register 줄을 보세요' ;;
    OTHER)         ST_AGY='fail'; WHY_AGY='axmap 항목이 다른 서버를 가리킵니다 — 건드리지 않았습니다' ;;
    WRITEFAIL)     ST_AGY='fail'; WHY_AGY='mcp_config.json 에 쓰지 못했습니다 (권한 또는 잠금)' ;;
    *)             ST_AGY='fail'; WHY_AGY='mcp_config.json 을 읽지 못했습니다 — 건드리지 않았습니다' ;;
  esac
fi

# Codex — 등록은 mcp-register 가 codex 자신의 명령으로 한다. 여기서는 확인만 한다.
#
# 🔴 이름(AXMAP_AGENT)은 codex 설정에 넣지 못한다. mcp-register 가 codex mcp add 를
#    부를 때 이름을 빼고 부르고, 이미 등록돼 있으면 다시 부르지도 않기 때문이다.
#    확인 안 된 도구(이 팀에 codex 가 있는 PC 가 아직 없다)의 설정을 우리가 추측으로
#    덮어쓰는 것보다, 한 줄을 손으로 넣게 하는 편이 낫다.
if ! command -v codex >/dev/null 2>&1; then
  ST_CODEX='skip'; WHY_CODEX='이 PC 에 codex 가 없습니다'
else
  if codex mcp list 2>/dev/null | grep -q axmap; then
    ST_CODEX='ok'
    WHY_CODEX='~/.codex/config.toml (codex mcp list로 확인). 작업 repo는 실행 위치에서 결정하고 이름은 git 설정을 사용합니다.'
  else
    ST_CODEX='fail'; WHY_CODEX='codex mcp list 에 axmap 이 없습니다 — 위 TOML 조각을 손으로 넣으세요'
  fi
fi

# ── 7. 보고 ─────────────────────────────────────────────────────────────────
#
# [!] "설치했습니다" 한 줄로 끝내지 않는다. 이 도구의 실패는 대부분 조용해서,
#     오류가 안 났다는 것이 붙었다는 뜻이 아니다. CLI 마다 한 줄씩 찍는다.
line() {
  case "$2" in
    ok)   ok   "$(printf '%-8s' "$1")$3" ;;
    skip) hm   "$(printf '%-8s' "$1")$3 (건너뜀 — 실패가 아닙니다)" ;;
    *)    bad  "$(printf '%-8s' "$1")$3" ;;
  esac
}

say ''
say '등록 결과'
line 'claude' "$ST_CLAUDE" "$WHY_CLAUDE"
line 'agy'    "$ST_AGY"    "$WHY_AGY"
line 'codex'  "$ST_CODEX"  "$WHY_CODEX"

say ''
say "설치 위치: $DEST"
say "이 PC 의 이름: $NAME  ($NAME_FROM)"
say ''

if [ "$ST_CLAUDE" = 'fail' ] || [ "$ST_AGY" = 'fail' ] || [ "$ST_CODEX" = 'fail' ]; then
  say '🔴 위의 !! 줄이 남아 있습니다. 그 CLI 에서는 axMap 이 뜨지 않습니다.'
  say ''
  exit 1
fi

if [ "$ST_CLAUDE" != 'ok' ] && [ "$ST_AGY" != 'ok' ] && [ "$ST_CODEX" != 'ok' ]; then
  say '🔴 이 PC 에서 AI CLI 를 하나도 찾지 못했습니다. 설치한 뒤 이 스크립트를 다시 실행하세요.'
  say ''
  exit 1
fi

say '다음: AI CLI 를 완전히 껐다가 다시 켠 뒤, 작업할 저장소에서 "ax_status 로 지금 누가 뭘 잡고 있는지 보여줘" 라고 시켜 보세요.'
say ''
exit 0
