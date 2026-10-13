#!/usr/bin/env bash
#
# 여러 AI 에이전트가 한 저장소에서 동시에 일하는 상황을 실제 git 저장소로 재현한다.
# 시뮬레이션이 아니라 진짜 bare 원격 + 진짜 clone + 진짜 push 를 쓴다.
#
#   bash demo/run-demo.sh
#
set -u

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="${AXMAP_DEMO_DIR:-${TMPDIR:-/tmp}/axmap-demo}"

bm() { node "$PROJ/bin/axmap.mjs" "$@"; }

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
section() { printf '\n%s────────────────────────────────────────────────────────────%s\n' "$DIM" "$N"; printf '%s%s%s\n\n' "$B" "$*" "$N"; }
note()    { printf '%s  %s%s\n' "$Y" "$*" "$N"; }
run()     { printf '%s$ %s%s\n' "$DIM" "$*" "$N"; }

rm -rf "$LAB"; mkdir -p "$LAB"; cd "$LAB"

# ---------------------------------------------------------------------------
section "0. 준비 - 공용 원격과 코드베이스"

git init --bare -q origin.git
git init -q seed && cd seed
git config user.email demo@x; git config user.name seed
mkdir -p src/auth src/user src/core src/api
echo 'export function login(){}'   > src/auth/login.ts
echo 'export function verify(){}'  > src/auth/token.ts
echo 'export function profile(){}' > src/user/profile.ts
echo 'export const cfg={}'         > src/core/config.ts
echo 'export const util=()=>{}'    > src/core/util.ts
for f in one two three four; do echo "export const $f=1" > "src/api/$f.ts"; done
git add -A && git commit -qm seed
git push -q ../origin.git HEAD:refs/heads/main
cd ..

clone() {
  git clone -q -b main origin.git "$1"
  ( cd "$1" && git config user.email "$1@x" && git config user.name "$1" )
}

echo "원격 저장소와 4개 디렉터리의 코드베이스를 만들었습니다."

# ---------------------------------------------------------------------------
section "1. agent-a 가 src/auth 를 선점"

clone agent-a
cd agent-a
run "axmap init"
AXMAP_AGENT=agent-a bm init
run "axmap claim src/auth --task task-12"
AXMAP_AGENT=agent-a bm claim src/auth --task task-12 --intent "토큰 검증 로직 리팩토링" --ttl 30m
cd ..

# ---------------------------------------------------------------------------
section "2. agent-b 가 src/user 를 선점  ← git 판정이었다면 여기서 오탐이 났다"

clone agent-b
cd agent-b
AXMAP_AGENT=agent-b bm init
run "axmap claim src/user --task task-13"
AXMAP_AGENT=agent-b bm claim src/user --task task-13 --intent "프로필 페이지 개편"
cd ..
note "docs/EXPERIMENT.md 의 Case 1 과 같은 상황이다."
note "git 의 줄 단위 판정은 장부가 비어 있다는 이유만으로 여기서 충돌을 냈다."
note "경로가 겹치는지를 직접 물으면 오탐이 없다."

# ---------------------------------------------------------------------------
section "3. agent-c 가 src/auth/login.ts 를 선점 시도  ← 진짜 겹침"

clone agent-c
cd agent-c
AXMAP_AGENT=agent-c bm init
run "axmap claim src/auth/login.ts --task task-14"
if AXMAP_AGENT=agent-c bm claim src/auth/login.ts --task task-14; then
  printf '%s예상과 다릅니다 - 통과되면 안 됩니다%s\n' "$R" "$N"
else
  rc=$?
  printf '\n%s거부됨 (exit %s). 이유가 사람과 AI 모두 읽을 수 있는 형태로 나왔다.%s\n' "$G" "$rc" "$N"
fi
cd ..
note "agent-a 는 src/auth 를, agent-c 는 src/auth/login.ts 를 요청했다."
note "문자열이 다르지만 디렉터리가 파일을 덮으므로 겹침으로 판정된다."

# ---------------------------------------------------------------------------
section "4. 4명이 동시에 선점 - 관문 1(CAS) 이 순번을 정리한다"

files=(one two three four)
idx=0
for n in d e f g; do
  clone "agent-$n" >/dev/null 2>&1
  ( cd "agent-$n" && AXMAP_AGENT="agent-$n" bm init >/dev/null 2>&1 )
done
run "4개 프로세스가 동시에 axmap claim 을 실행"
for n in d e f g; do
  f="src/api/${files[$idx]}.ts"
  ( cd "agent-$n" && AXMAP_AGENT="agent-$n" bm claim "$f" --task "task-$n" ) >"log-$n.txt" 2>&1 &
  idx=$((idx + 1))
done
wait
for n in d e f g; do sed "s/^/  [agent-$n] /" "log-$n.txt"; done
note "겹치지 않는 경로라도 같은 ref 를 밀기 때문에 push 는 서로 거부당한다."
note "그것은 실패가 아니라 순번 신호이고, 재시도 루프가 알아서 수렴시킨다."
note "아래 장부에 4명 전부 남아 있으면 아무도 유실되지 않은 것이다."

# ---------------------------------------------------------------------------
section "5. 전체 장부"

cd agent-a
AXMAP_AGENT=agent-a bm status
cd ..

# ---------------------------------------------------------------------------
section "6. TTL - 죽은 에이전트의 유령 락은 스스로 사라진다"

FUTURE=$(node -e "console.log(new Date(Date.now()+2*3600e3).toISOString())")
echo "시계를 2시간 앞으로 돌립니다 (AXMAP_NOW=$FUTURE)"
cd agent-c
run "axmap status   # 2시간 후"
AXMAP_AGENT=agent-c AXMAP_NOW="$FUTURE" bm status | head -20
run "axmap claim src/auth/login.ts   # 아까 거부당했던 그 요청"
AXMAP_AGENT=agent-c AXMAP_NOW="$FUTURE" bm claim src/auth/login.ts --task task-14
cd ..
note "agent-a 가 죽어서 release 를 못 했어도 30분 뒤 락은 저절로 풀린다."
note "살아 있는 에이전트는 axmap renew 로 연장한다."

# ---------------------------------------------------------------------------
section "7. pre-commit - claim 없이 몰래 고치는 것을 막는다"

cd agent-b
AXMAP_AGENT=agent-b bm hook install
echo '// agent-b 가 claim 없이 손댐' >> src/auth/token.ts
git add src/auth/token.ts
run "git commit -m '...'   # agent-b 는 src/user 만 잡고 있다"
if AXMAP_AGENT=agent-b git commit -qm "claim 없이 수정" 2>&1; then
  printf '%s예상과 다릅니다 - 통과되면 안 됩니다%s\n' "$R" "$N"
else
  printf '\n%s커밋이 차단되었습니다.%s\n' "$G" "$N"
fi

git restore --staged src/auth/token.ts && git checkout -- src/auth/token.ts
echo '// agent-b 의 정상 작업' >> src/user/profile.ts
git add src/user/profile.ts
run "git commit -m '...'   # 이번엔 자기가 잡은 영역"
if AXMAP_AGENT=agent-b git commit -qm "정상 작업"; then
  printf '%s통과. 자기 영역은 막지 않는다.%s\n' "$G" "$N"
else
  printf '%s예상과 다릅니다 - 통과되어야 합니다%s\n' "$R" "$N"
fi
cd ..

# ---------------------------------------------------------------------------
section "8. 만료된 claim 은 부활하지 않는다 - fail-open 방어"

clone agent-h; clone agent-i
cd agent-h
AXMAP_AGENT=agent-h bm init >/dev/null
run "agent-h 가 src/core/config.ts 선점 (지금)"
AXMAP_AGENT=agent-h bm claim src/core/config.ts --task task-h | head -2
cd ../agent-i
AXMAP_AGENT=agent-i bm init >/dev/null
run "2시간 뒤 - agent-h 의 TTL 이 만료되어 agent-i 가 정당하게 가져간다"
AXMAP_AGENT=agent-i AXMAP_NOW="$FUTURE" bm claim src/core/config.ts --task task-i | head -2
cd ../agent-h
run "같은 시각 - agent-h 가 전혀 다른 경로를 새로 선점한다"
AXMAP_AGENT=agent-h AXMAP_NOW="$FUTURE" bm claim src/core/util.ts --task task-h2 | head -3

printf '\n  agent-h 의 최종 claim:\n'
sed 's/^/    /' .axmap/ledger/claims/agent-h.json
if grep -q 'config.ts' .axmap/ledger/claims/agent-h.json; then
  printf '%s  실패 - 만료됐던 config.ts 가 부활했다. agent-i 와 동시 소유 상태다.%s\n' "$R" "$N"
else
  printf '%s  정상 - config.ts 는 부활하지 않았다. agent-i 만 소유한다.%s\n' "$G" "$N"
fi
cd ..
note "합집합 병합의 대상은 '내 레코드'가 아니라 '효력이 남은 내 레코드'여야 한다."
note "만료는 레코드가 사라지는 것이 아니라 효력만 잃는 것이기 때문이다."

# ---------------------------------------------------------------------------
printf '\n%s────────────────────────────────────────────────────────────%s\n' "$DIM" "$N"
printf '%s데모 종료.%s 실습 저장소: %s\n' "$B" "$N" "$LAB"
printf '  cd %s/agent-a && node %s/bin/axmap.mjs status\n\n' "$LAB" "$PROJ"
