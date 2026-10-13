#!/usr/bin/env bash
#
# 카오스 테스트.
#
# 진짜 프로세스 여러 개를 진짜 저장소에 붙이고 무작위로 claim / 작업 / 죽음 / 우회를 시킨다.
# 모델 검증기가 볼 수 없는 것을 잡는다 - 실제 CAS 레이스, git 인덱스 경합, --no-verify 우회.
#
#   bash demo/chaos.sh [에이전트수] [라운드수]
#   bash demo/chaos.sh 8 12
#
set -u

AGENTS="${1:-6}"
ROUNDS="${2:-10}"
TTL="${CHAOS_TTL:-8s}"        # 짧게 잡아야 만료와 회수가 테스트 안에서 실제로 일어난다

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="${AXMAP_DEMO_DIR:-${TMPDIR:-/tmp}}/axmap-chaos"

bm() { node "$PROJ/bin/axmap.mjs" "$@"; }

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
section() { printf '\n%s────────────────────────────────────────%s\n%s%s%s\n\n' "$DIM" "$N" "$B" "$*" "$N"; }

PATHS=(src/auth src/auth/login.ts src/auth/token.ts src/authz src/authz/policy.ts
       src/user src/user/profile.ts src/core/config.ts src/api/one.ts src/api/two.ts)

rm -rf "$LAB"; mkdir -p "$LAB"; cd "$LAB"

# ---------------------------------------------------------------------------
section "준비 - 원격과 코드베이스, 에이전트 ${AGENTS}명"

git init --bare -q origin.git
git init -q seed && cd seed
git config user.email c@x; git config user.name seed
mkdir -p src/auth src/authz src/user src/core src/api
for p in "${PATHS[@]}"; do
  case "$p" in */*.ts) echo "export const x=0" > "$p" ;; *) mkdir -p "$p" ;; esac
done
echo 'placeholder' > src/auth/.keep; echo 'placeholder' > src/authz/.keep; echo 'placeholder' > src/user/.keep
git add -A && git commit -qm seed && git push -q ../origin.git HEAD:refs/heads/main
cd ..

for i in $(seq 1 "$AGENTS"); do
  git clone -q -b main origin.git "agent-$i" 2>/dev/null
  ( cd "agent-$i" && git config user.email "a$i@x" && git config user.name "agent-$i" \
    && AXMAP_AGENT="agent-$i" bm init >/dev/null 2>&1
    # CHAOS_NO_HOOK=1 로 훅을 빼면 I5 검사가 실제로 실패해야 한다.
    # 한 번도 실패하지 않는 검사는 검사가 아니므로, 검사기 자신을 확인하는 스위치다.
    [ "${CHAOS_NO_HOOK:-0}" = "1" ] || AXMAP_AGENT="agent-$i" bm hook install >/dev/null 2>&1 )
done
echo "에이전트 ${AGENTS}명 준비 완료. TTL=${TTL}, 라운드 ${ROUNDS}회."
[ "${CHAOS_NO_HOOK:-0}" = "1" ] && printf '%s훅 없이 실행 중 - I5 가 실패해야 정상이다.%s\n' "$Y" "$N"

# ---------------------------------------------------------------------------
section "카오스 주입"

# 한 에이전트의 수명. 무작위로 claim / 커밋 / 반납 / 급사 / 우회를 반복한다.
agent_loop() {
  local me="agent-$1"
  local claimed=""   # 지금까지 잡은 경로 목록 (claim 은 누적된다)
  cd "$LAB/$me" || return
  export AXMAP_AGENT="$me"

  # 어떤 파일이 내 claim 에 덮이는가.
  # 디렉터리 claim 은 그 아래 파일을 덮으므로 문자열 비교로는 안 된다.
  # 여기를 틀리면 정상 동작을 I5 위반으로 오탐한다.
  covered() {
    local f="$1" c
    for c in $claimed; do
      case "$f" in "$c" | "$c"/*) return 0 ;; esac
    done
    return 1
  }

  for r in $(seq 1 "$ROUNDS"); do
    # 급사는 드물게 둔다. 너무 자주 죽으면 정작 경합이 일어나기 전에 다 사라진다.
    case $((RANDOM % 20)) in
      0|1|2|3|4|5|6|7)  # claim
        local p="${PATHS[$((RANDOM % ${#PATHS[@]}))]}"
        if bm claim "$p" --task "r$r" --ttl "$TTL" >/dev/null 2>&1; then
          claimed="$claimed $p"
          echo "$me claim $p" >> "$LAB/ops.log"
        else
          echo "$me blocked $p" >> "$LAB/ops.log"
        fi
        ;;
      8|9|10|11)  # 잡은 곳에 실제로 커밋
        local t
        for t in $claimed; do
          # 디렉터리를 잡았으면 그 안의 파일에 쓴다
          [ -d "$t" ] && t="$t/.keep"
          [ -f "$t" ] || continue
          echo "// $me r$r" >> "$t"
          git add "$t" >/dev/null 2>&1
          if git commit -qm "$me r$r" >/dev/null 2>&1; then
            echo "$me commit $t" >> "$LAB/ops.log"
          else
            echo "$me commit-blocked $t" >> "$LAB/ops.log"
            git reset -q --hard HEAD >/dev/null 2>&1
          fi
          break
        done
        ;;
      12|13)    # 갱신
        bm renew --ttl "$TTL" >/dev/null 2>&1 && echo "$me renew" >> "$LAB/ops.log"
        ;;
      14|15)    # 정상 반납 (전부)
        if bm release >/dev/null 2>&1; then claimed=""; echo "$me release" >> "$LAB/ops.log"; fi
        ;;
      16)       # 급사 - release 없이 그냥 사라진다
        echo "$me DIED (release 없이)" >> "$LAB/ops.log"
        return
        ;;
      *)        # I5 우회 시도 - claim 하지 않은 파일을 커밋
        local victim="${PATHS[$((RANDOM % ${#PATHS[@]}))]}"
        # 내 claim 에 덮이는 파일은 우회가 아니라 정상 작업이다. 건너뛴다.
        if [ -f "$victim" ] && ! covered "$victim"; then
          echo "// $me 우회" >> "$victim"
          git add "$victim" >/dev/null 2>&1
          if git commit -qm "$me 우회 시도" >/dev/null 2>&1; then
            echo "$me BYPASSED $victim" >> "$LAB/ops.log"   # <- 잡히면 I5 위반
          else
            echo "$me bypass-blocked $victim" >> "$LAB/ops.log"
          fi
          git reset -q --hard HEAD >/dev/null 2>&1
        fi
        ;;
    esac
  done
}

touch ops.log
for i in $(seq 1 "$AGENTS"); do agent_loop "$i" & done
wait
echo "총 연산 $(wc -l < ops.log) 회"
printf '%s' "$DIM"; awk '{print $2}' ops.log | sort | uniq -c | sort -rn | sed 's/^/    /'; printf '%s' "$N"

# ---------------------------------------------------------------------------
section "불변식 검사"

FAIL=0

# I5 · 강제 - claim 없는 커밋이 단 한 건이라도 통과했으면 위반
if grep -q 'BYPASSED' ops.log; then
  printf '%s  I5 위반 - claim 없는 커밋이 통과했다:%s\n' "$R" "$N"
  grep 'BYPASSED' ops.log | sed 's/^/      /'
  FAIL=1
else
  BLOCKED=$(grep -c 'bypass-blocked' ops.log || true)
  printf '%s  I5 통과%s - claim 없는 커밋 시도 %s건 전부 차단됨\n' "$G" "$N" "$BLOCKED"
fi

# I3 · 진행성 - 아무도 굶지 않았는가 (claim 을 한 번이라도 성공한 에이전트 수)
GOT=$(grep ' claim ' ops.log | awk '{print $1}' | sort -u | wc -l)
DIED=$(grep -c 'DIED' ops.log || true)
if [ "$GOT" -eq 0 ]; then
  printf '%s  I3 위반 - 아무도 claim 에 성공하지 못했다%s\n' "$R" "$N"; FAIL=1
else
  printf '%s  I3 통과%s - %s명이 claim 성공 (급사 %s명 포함한 전체 %s명 중)\n' "$G" "$N" "$GOT" "$DIED" "$AGENTS"
fi

# I1 · 상호배제 - 장부 이력 전체를 재생해 사후 증명
cd "$LAB/agent-1"
printf '\n%s  axmap audit --fetch%s\n' "$DIM" "$N"
# 파이프로 넘기면 sed 의 종료 코드가 잡히므로 먼저 받아둔다.
AUDIT_OUT=$(AXMAP_AGENT=agent-1 bm audit --fetch 2>&1); AUDIT_RC=$?
printf '%s\n' "$AUDIT_OUT" | sed 's/^/    /'
[ "$AUDIT_RC" -eq 0 ] || FAIL=1

# I4 · 회수 - 모든 TTL 이 지난 뒤에는 아무것도 막히지 않아야 한다
FUTURE=$(node -e "console.log(new Date(Date.now()+86400e3).toISOString())")
STILL=$(AXMAP_AGENT=agent-1 AXMAP_NOW="$FUTURE" bm status --json 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).active.length)}catch{console.log("?")}})')
if [ "$STILL" = "0" ]; then
  printf '\n%s  I4 통과%s - 하루 뒤 유효한 claim 0건. 급사한 에이전트의 락도 전부 회수됨\n' "$G" "$N"
else
  printf '\n%s  I4 위반 - 하루가 지나도 유효한 claim 이 %s건 남아 있다%s\n' "$R" "$STILL" "$N"; FAIL=1
fi

# ---------------------------------------------------------------------------
printf '\n%s────────────────────────────────────────%s\n' "$DIM" "$N"
if [ "$FAIL" -eq 0 ]; then
  printf '%s카오스 테스트 통과%s  (에이전트 %s, 라운드 %s)\n' "$G$B" "$N" "$AGENTS" "$ROUNDS"
else
  printf '%s카오스 테스트 실패%s  실습 저장소: %s\n' "$R$B" "$N" "$LAB"
fi
printf '%s연산 기록: %s/ops.log%s\n\n' "$DIM" "$LAB" "$N"
exit "$FAIL"
