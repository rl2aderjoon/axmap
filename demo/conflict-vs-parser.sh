#!/usr/bin/env bash
#
# axMap 이 "git 의 텍스트 충돌"이 아니라 "직접 짠 파서"로 겹침을 판정하는 이유.
# 같은 입력을 두 판정기에 넣어 답을 비교한다.
#
#   bash demo/conflict-vs-parser.sh
#
set -u

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="${AXMAP_DEMO_DIR:-${TMPDIR:-/tmp}}/axmap-compare"

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; R=$'\033[31m'; N=$'\033[0m'

rm -rf "$LAB"; mkdir -p "$LAB"; cd "$LAB"

# --- 판정기 1: git ---------------------------------------------------------
# 정렬된 단일 장부에 각자 한 줄씩 추가하고, git 이 병합할 수 있는지 본다.
git_verdict() { # $1=base장부  $2=A의줄  $3=B의줄
  rm -rf origin.git seed a b
  git init --bare -q origin.git
  git init -q seed && cd seed
  git config user.email t@t; git config user.name t
  printf '%s' "$1" > LOCKS.tsv
  git add -A; git commit -qm base
  git push -q ../origin.git HEAD:refs/heads/claims
  cd ..
  git clone -q -b claims origin.git a 2>/dev/null
  git clone -q -b claims origin.git b 2>/dev/null
  for d in a b; do (cd $d; git config user.email t@t; git config user.name t); done

  add_line() { { head -1 LOCKS.tsv; { tail -n +2 LOCKS.tsv; printf '%s\n' "$1"; } | grep -v '^$' | sort; } > .t && mv .t LOCKS.tsv; }

  cd a; add_line "$2"; git commit -qam a; git push -q origin claims; cd ..
  cd b; add_line "$3"; git commit -qam b
  PUSH=$(git push origin claims 2>&1 | grep -c 'rejected')
  git pull --no-rebase -q origin claims >/dev/null 2>&1
  if grep -q '<<<<<<<' LOCKS.tsv 2>/dev/null; then VERDICT="거부"; else VERDICT="통과"; fi
  cd ..
  echo "$PUSH|$VERDICT"
}

# --- 판정기 2: axMap 파서 -----------------------------------------------
parser_verdict() { # $1=A경로  $2=B경로  $3=제3자경로(선택)
  # PROJ 로 이동해서 상대 경로로 import 한다.
  # git bash 의 /c/... 경로는 윈도우 node 가 file URL 로 해석하지 못한다.
  cd "$PROJ" && BM_A="$1" BM_B="$2" BM_THIRD="${3:-}" node -e '
    import("./src/protocol.mjs").then(({ checkOverlap }) => {
      const now = Date.parse("2026-08-15T09:10:00Z")
      const mk = (agent, p) => ({ agent, task: "t", since: "2026-08-15T09:00:00Z", ttlMs: 1800000, paths: [p] })
      const claims = [mk("agent-a", process.env.BM_A)]
      if (process.env.BM_THIRD) claims.push(mk("agent-c", process.env.BM_THIRD))
      const r = checkOverlap({ requested: [process.env.BM_B], claims, me: "agent-b", now })
      console.log(r.ok ? "통과" : "거부")
    })
  '
}

# ---------------------------------------------------------------------------
run_case() { # $1=이름 $2=base $3=A줄 $4=B줄 $5=A경로 $6=B경로 $7=제3자경로 $8=정답
  # 함수는 자기 자신의 위치 인자를 가지므로 정답을 변수로 옮겨둔다.
  EXPECT="$8"
  printf '\n%s%s%s\n' "$B" "$1" "$N"
  printf '  A: %s\n  B: %s\n' "$5" "$6"
  printf '  올바른 판정: %s%s%s\n' "$B" "$EXPECT" "$N"

  IFS='|' read -r PUSH GITV <<< "$(git_verdict "$2" "$3" "$4")"
  PARV=$(parser_verdict "$5" "$6" "${7:-}")

  mark() { if [ "$1" = "$EXPECT" ]; then printf '%s맞음%s' "$G" "$N"; else printf '%s틀림%s' "$R" "$N"; fi; }
  printf '  ─────────────────────────────────────────────\n'
  printf '  관문 1  git push CAS      : %s\n' "$([ "$PUSH" -gt 0 ] && echo '거부 (순번 정리 - 내용과 무관)' || echo '통과')"
  printf '  관문 2  git 텍스트 충돌   : %-6s  %s\n' "$GITV" "$(mark "$GITV")"
  printf '  관문 2  axMap 파서        : %-6s  %s\n' "$PARV" "$(mark "$PARV")"
}

HDR=$'# path\tagent\tsince\ttask\n'
SEP=$'# path\tagent\tsince\ttask\nsrc/core/config.ts\tagent-c\tT08:00\ttask-01\n'
A_LINE=$'src/auth/login.ts\tagent-a\tT09:00\ttask-12'
B_LINE=$'src/user/profile.ts\tagent-b\tT09:02\ttask-13'
B_SAME=$'src/auth/login.ts\tagent-b\tT09:02\ttask-13'

printf '%s같은 입력을 두 판정기에 넣어 비교한다%s\n' "$B" "$N"

run_case "CASE 1 · 서로 다른 파일 · 장부에 다른 항목 없음" \
  "$HDR" "$A_LINE" "$B_LINE" "src/auth/login.ts" "src/user/profile.ts" "" "통과"

run_case "CASE 2 · 서로 다른 파일 · 장부에 제3자 항목이 하나 있음" \
  "$SEP" "$A_LINE" "$B_LINE" "src/auth/login.ts" "src/user/profile.ts" "src/core/config.ts" "통과"

run_case "CASE 3 · 같은 파일" \
  "$HDR" "$A_LINE" "$B_SAME" "src/auth/login.ts" "src/auth/login.ts" "" "거부"

cat <<EOS

$B결론$N
  CASE 1 과 CASE 2 는 A/B 가 요청한 경로가 완전히 같다.
  다른 것은 무관한 제3자가 장부에 남긴 줄 하나뿐인데, git 판정은 답이 갈렸다.

  git 이 답하는 질문 : "둘이 장부의 같은 줄 자리에 썼는가"
  우리가 묻고 싶은 것 : "둘이 요청한 경로가 겹치는가"
  두 질문의 답은 우연히만 일치한다.

  관문 1(CAS)은 세 케이스 모두에서 작동한다. 선택의 대상이 아니며,
  실패는 거절이 아니라 "최신 장부를 받아 다시 하라"는 순번 신호다.
EOS
