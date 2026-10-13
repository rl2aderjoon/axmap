#!/usr/bin/env bash
#
# AI 협업 시나리오 — 여러 에이전트가 같은 기능을 동시에 만들 때
# axMap 이 실제로 중재하는지, 그것이 그래프에 보이는지 확인한다.
#
#   bash demo/collab.sh          시나리오 구성 + 검증
#   bash demo/collab.sh --keep   구성만 하고 뷰어로 보게 남겨둔다
#
# demo/chaos.sh 와 다른 점: 저기는 무작위로 두들겨 불변식을 깨려 하고,
# 여기는 **사람이 이해할 수 있는 한 편의 이야기**를 만든다.
# 아침에 뷰어를 열면 이 상황이 그대로 화면에 있다.
#
set -u

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="${AXMAP_COLLAB_DIR:-${TMPDIR:-/tmp}/axmap-collab}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

bm() { node "$PROJ/bin/axmap.mjs" "$@"; }

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
step() { printf '\n%s── %s%s\n' "$B" "$*" "$N"; }
note() { printf '%s   %s%s\n' "$DIM" "$*" "$N"; }
ok()   { printf '%s   ✓ %s%s\n' "$G" "$*" "$N"; }
bad()  { printf '%s   ✗ %s%s\n' "$R" "$*" "$N"; FAIL=1; }

FAIL=0
rm -rf "$LAB"; mkdir -p "$LAB"; cd "$LAB"

# ---------------------------------------------------------------------------
step "0. 로그인 기능이 있는 저장소를 만든다"

git init -q .
git config user.email lead@x
git config user.name 장효준
mkdir -p src/api/auth src/api/user src/ui/login src/ui/home src/core src/jobs

cat > src/api/auth/login.py <<'EOF'
"""로그인 API. /api/auth/login 을 처리한다."""
from src.core.session import issue

def handle(req):
    user = lookup(req["email"])
    return {"token": issue(user), "expiresIn": 3600}
EOF
cat > src/api/auth/token.py <<'EOF'
"""토큰 검증."""
def verify(tok):
    return tok is not None
EOF
cat > src/api/user/profile.py <<'EOF'
"""프로필 조회. /api/user/profile"""
def handle(req):
    return {"name": "x"}
EOF
cat > src/core/session.py <<'EOF'
"""세션 발급 — 로그인과 프로필이 함께 쓴다."""
def issue(user):
    return "tok"
EOF
cat > src/ui/login/screen.py <<'EOF'
"""로그인 화면. /api/auth/login 을 호출한다."""
def render():
    post("/api/auth/login", {"email": "", "password": ""})
EOF
cat > src/ui/home/dash.py <<'EOF'
"""홈 대시보드. /api/user/profile 을 호출한다."""
def render():
    get("/api/user/profile")
EOF
cat > src/jobs/cleanup.py <<'EOF'
"""만료 세션 정리 배치."""
def run():
    pass
EOF

git add -A && git commit -qm "로그인 기능 초안"
git commit -q --allow-empty -m "세션 발급 정리"
note "파일 7개 · 커밋 2개"

AXMAP_AGENT=장효준 bm init >/dev/null 2>&1
ok "장부 준비됨"

# ---------------------------------------------------------------------------
step "1. 사람(장효준)이 세션 로직을 손보기로 한다"

AXMAP_AGENT=장효준 bm claim src/core --actor human --task LOGIN-1 \
  --intent "세션 발급을 리프레시 토큰 방식으로 변경" --ttl 8h | head -1
echo "# 사람이 실제로 수정 중" >> src/core/session.py
ok "src/core 선점 + 실제 수정 시작"

# ---------------------------------------------------------------------------
step "2. 대화형 AI 에이전트가 로그인 API 를 맡는다"

AXMAP_AGENT=claude-api bm claim src/api/auth --actor agent --task LOGIN-2 \
  --intent "로그인 응답에 refreshToken 추가" --ttl 8h | head -1
echo "# claude-api 작업 중" >> src/api/auth/login.py
ok "src/api/auth 선점 (사람과 안 겹침 → 병렬 진행)"

# ---------------------------------------------------------------------------
step "3. 두 번째 에이전트가 같은 곳을 잡으려 한다  ← 여기가 핵심"

if AXMAP_AGENT=claude-ui bm claim src/api/auth/login.py --actor agent --task LOGIN-3 \
     --intent "로그인 응답 형식을 바꾸려 함" >/tmp/collab-reject.txt 2>&1; then
  bad "겹치는데 통과했다 — 중재 실패"
else
  RC=$?
  ok "거부됨 (exit $RC). 이유가 이렇게 전달된다:"
  sed 's/^/     /' /tmp/collab-reject.txt | head -8
fi

# ---------------------------------------------------------------------------
step "4. 거부당한 에이전트가 겹치지 않는 곳으로 옮긴다"

AXMAP_AGENT=claude-ui bm claim src/ui/login --actor agent --task LOGIN-3 \
  --intent "로그인 화면을 새 응답 형식에 맞춤" --ttl 8h | head -1
echo "# claude-ui 작업 중" >> src/ui/login/screen.py
ok "src/ui/login 으로 이동 — 세 주체가 동시에 진행"

# ---------------------------------------------------------------------------
step "5. 백그라운드 에이전트와 다른 팀원도 붙는다"

AXMAP_AGENT=nightly-bot bm claim src/jobs --actor background --task OPS-9 \
  --intent "만료 세션 정리 주기 조정" --ttl 8h | head -1
AXMAP_AGENT=김팀원 bm claim src/api/user --actor team --task USER-4 \
  --intent "프로필 응답에 아바타 추가" --ttl 8h | head -1
echo "# nightly-bot" >> src/jobs/cleanup.py
ok "다섯 주체가 겹치지 않고 동시에 작업 중"

# ---------------------------------------------------------------------------
step "6. 누군가 선언 없이 파일을 고친다  ← 즉시 경고 대상"

echo "# 아무도 선언하지 않은 수정" >> src/ui/home/dash.py
ok "src/ui/home/dash.py 를 선언 없이 수정 (경고로 잡혀야 한다)"

# ---------------------------------------------------------------------------
step "7. 검증"

STATUS=$(AXMAP_AGENT=장효준 bm status --json)
COUNT=$(printf '%s' "$STATUS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).active.length))')
[ "$COUNT" = "5" ] && ok "활성 claim 5건" || bad "활성 claim 이 5건이 아님: $COUNT"

# 상호배제 — 장부 이력 전체를 재생해 사후 증명
AUDIT=$(AXMAP_AGENT=장효준 bm audit 2>&1); ARC=$?
if [ "$ARC" -eq 0 ]; then ok "audit 통과 — 상호배제가 깨진 시점 없음"
else bad "audit 실패"; echo "$AUDIT" | sed 's/^/     /'; fi

# 겹침이 실제로 막혔는지
grep -q '거부' /tmp/collab-reject.txt && ok "겹친 요청은 코드 한 줄 쓰기 전에 막혔다" \
  || bad "거부 메시지가 없다"

printf '\n%s── 결과%s\n' "$B" "$N"
if [ "$FAIL" -eq 0 ]; then
  printf '%s   협업 시나리오 통과%s\n' "$G$B" "$N"
else
  printf '%s   실패 항목 있음%s\n' "$R$B" "$N"
fi

cat <<EOS

${DIM}이 상황을 화면에서 보려면:${N}
  node app/server.mjs "$LAB" 7777
  → 감시 탭

  기대 화면
    src/core        초록  장효준 (사람) 작업 중
    src/api/auth    보라  claude-api (AI)
    src/ui/login    보라  claude-ui (AI)
    src/jobs        하늘  nightly-bot (백그라운드)
    src/api/user    노랑  김팀원 (선점만, 아직 안 건드림)
    src/ui/home     빨강  선언 밖 수정 ⚠
EOS

exit "$FAIL"
