# axMap 없이 손으로 하기

axMap 을 안 깔아도 **투표와 선점은 둘 다 손으로 할 수 있다.** 둘 다 저장소 안의
파일 하나일 뿐이고, git 명령만 있으면 된다.

이 문서가 있는 이유는 하나다. **도구를 깔아야만 참여할 수 있으면 그건 규칙이
아니라 문턱이다.** 표를 던질 자격이 있는 사람이 도구를 못 깔았다고 표를 못
던지면, 막힌 것은 그 사람이 아니라 팀 전체다.

> 🔴 **손으로 하면 안전장치가 없다.** 도구는 겹침을 먼저 막아 주고(선점),
> 이유 없는 표를 먼저 거절해 준다(투표). 손으로 할 때는 그 검사가 안 돈다 —
> **판정하는 쪽은 똑같이 엄격하다.** 틀리게 적으면 그 표는 안 세어지고,
> 안 세어진 이유는 판정문에만 나온다.

---

## 1. 손으로 표 던지기

표는 **고아 브랜치**(orphan branch — 어떤 이력에도 붙어 있지 않은, 코드와 완전히
분리된 브랜치) `axmap/votes` 에 산다. 코드 브랜치와 섞이지 않으므로 표를 던져도
남의 작업과 부딪히지 않는다.

### 1.1 무엇을 알아야 하나

| | |
|---|---|
| 어떤 브랜치에 대한 표인가 | MR 의 **소스 브랜치** 이름 (예: `hotfix/S15P21E201-33-…`) |
| 어떤 커밋에 대한 표인가 | 그 브랜치의 **맨 위 커밋** 40자리 |
| 내 이메일 | `git config user.email` — **커밋에 찍히는 것과 같아야 한다** |

```bash
git fetch origin
BRANCH=hotfix/S15P21E201-33-jinmiri-voter          # 표를 던질 대상
SHA=$(git rev-parse origin/$BRANCH)                # 그 브랜치 맨 위 커밋
echo "$BRANCH  $SHA"
```

> 🔴 **표는 커밋 하나에 묶인다.** 그 브랜치에 커밋이 하나 더 올라오면 앞의 표는
> 효력을 잃는다. 없어지지는 않고 "낡은 커밋의 표" 로 판정문에 남는다.
> 그래서 표를 던지기 직전에 `SHA` 를 다시 잰다.

### 1.2 표를 둘 자리를 편다

같은 저장소의 다른 브랜치를 **옆 폴더로 펼치는 것**을 worktree 라고 한다.
지금 작업 중인 파일을 건드리지 않고 표 브랜치만 다룰 수 있다.

```bash
# 표 브랜치가 이미 있을 때 (보통 이쪽)
git fetch origin axmap/votes
git worktree add ../votes-wt -B axmap/votes origin/axmap/votes

# 아무도 아직 표를 던진 적이 없어 브랜치 자체가 없을 때
git worktree add --detach ../votes-wt
cd ../votes-wt && git checkout --orphan axmap/votes && git rm -rf . --quiet
```

### 1.3 표 파일을 만든다

경로는 **정확히** 이 모양이다. 브랜치 이름의 `/` 는 그대로 폴더 구분자로 둔다.

```
votes/<소스브랜치>/<내이름>-<커밋앞8자>.json
```

```bash
cd ../votes-wt
NAME=$(git config user.name)
MAIL=$(git config user.email)
mkdir -p "votes/$BRANCH"
cat > "votes/$BRANCH/$NAME-${SHA:0:8}.json" <<EOF
{
  "voter": "$NAME",
  "email": "$MAIL",
  "branch": "$BRANCH",
  "sha": "$SHA",
  "vote": "approve",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "note": "무엇을 보고 찬성하는지 한 줄. 반대라면 무엇을 고쳐야 하는지.",
  "agent": { "id": "none" }
}
EOF
```

| 칸 | 값 |
|---|---|
| `vote` | `approve` 또는 `reject` |
| `note` | **이유.** 정책이 요구하면 이유 없는 표는 안 세어진다. 반대야말로 필요하다 — 이유 없는 반대는 "누군가 막고 있다" 만 남기고 무엇을 고쳐야 하는지는 안 남긴다 |
| `agent.id` | 사람이 혼자 던졌으면 `"none"` |

> 🔴 **`committerEmail` 은 적지 않는다.** 그 칸은 판정하는 쪽이 git 에서 직접
> 채워서 위의 `email` 과 **대조**하는 자리다. 표를 쓰는 사람이 적으면 대조가
> 아니라 자기 신고가 되고, 그러면 남의 이름으로 표를 만드는 데 아무 비용이 안 든다.
>
> 그래서 **이 표를 커밋하는 사람의 git 이메일이 `email` 과 같아야 한다.**
> 다르면 그 표는 조용히 안 세어진다.

### 1.4 올린다

```bash
git add -A
git commit -m "vote($NAME): $BRANCH ${SHA:0:8} approve"
git push origin axmap/votes
```

**push 가 거부되면** 그 사이에 누가 먼저 표를 던진 것이다. 받아서 다시 한다 —
git 이 원래 이렇게 동작한다(먼저 쓴 사람이 이긴다).

```bash
git fetch origin axmap/votes && git reset --hard origin/axmap/votes
# 1.3 부터 다시
```

### 1.5 확인한다

```bash
git ls-tree -r --name-only origin/axmap/votes    # 지금까지 던져진 표 전부
```

---

## 2. 손으로 선점하기

장부(누가 무엇을 잡고 있는지 적는 명단)도 같은 방식이다. 고아 브랜치
`axmap/claims` 에 **한 사람당 파일 하나**로 산다. 파일이 사람마다 다르니
두 사람이 동시에 써도 텍스트가 부딪히지 않는다.

```bash
git fetch origin axmap/claims
git worktree add ../claims-wt -B axmap/claims origin/axmap/claims
```

### 2.1 🔴 먼저 남의 것을 읽는다

**이것이 손으로 할 때 제일 중요한 단계다.** 도구는 겹치면 거부해 주지만,
손으로 할 때는 아무도 안 막아 준다. 잡기 전에 직접 본다.

```bash
cd ../claims-wt && cat claims/*.json
```

`paths` 가 내가 건드릴 곳과 겹치는 사람이 있으면 **잡지 않는다.** `intent` 에
그 사람이 무엇을 하려는지 적혀 있으니 읽고, 비어 있는 다른 곳으로 간다.
`since` + `ttlMs` 가 지났으면 그 claim 은 만료된 것이라 무시해도 된다.

### 2.2 내 자리를 적는다

```bash
cat > "claims/$(git config user.name).json" <<EOF
{
  "agent": "$(git config user.name)",
  "task": "S15P21E201-144",
  "intent": "무엇을 왜 건드리는지 한 줄. 이걸 읽고 남이 비켜 준다",
  "actor": "human",
  "session": "손으로",
  "since": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "ttlMs": 2700000,
  "paths": ["frontend/src/pages/Trip.tsx"]
}
EOF
git add -A && git commit -m "claim($(git config user.name)): S15P21E201-144" && git push origin axmap/claims
```

`ttlMs` 는 얼마나 잡고 있을지다 (2700000 = 45분). 시간이 지나면 자동으로 풀린다 —
**잡아 놓고 잊어버린 사람이 팀을 영원히 막는 일이 없어야 하기 때문이다.**

### 2.3 끝나면 즉시 반납한다

파일을 지우는 것이 반납이다.

```bash
git rm "claims/$(git config user.name).json" && git commit -m "release($(git config user.name)): all" && git push origin axmap/claims
```

---

## 3. 이 둘의 공통 규칙

| | |
|---|---|
| **어디에 사나** | 고아 브랜치. 코드와 안 섞이므로 MR 도 머지도 필요 없다 |
| **왜 파일 하나씩인가** | 한 파일에 여러 사람이 줄을 붙이면 텍스트 충돌이 난다. 파일이 다르면 충돌이 **구조적으로 불가능**하다 |
| **먼저 쓴 사람이 이긴다** | push 가 거부되면 받아서 다시 한다. git 이 원래 그렇게 동작한다 |
| **판정은 도구가 아니라 규칙이 한다** | 손으로 적었든 도구로 적었든 똑같이 읽고 똑같이 센다 |
