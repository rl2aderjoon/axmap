# axMap

[![English](https://raw.githubusercontent.com/rl2aderjoon/axmap/main/docs/assets/readme-en.svg)](https://github.com/rl2aderjoon/axmap/blob/main/README.md) [![한국어](https://raw.githubusercontent.com/rl2aderjoon/axmap/main/docs/assets/readme-ko.svg)](https://github.com/rl2aderjoon/axmap/blob/main/README.ko.md)

**여러 AI 에이전트가 같은 git 저장소에서 작업할 때, 수정할 경로를 먼저 선점해 충돌을 예방하는 CLI 도구.**

누가 어디를 고치는지 장부에 기록하고, 겹치는 경로의 선점을 거부한다.
커밋 훅으로 선점 범위를 확인하고, 작업이 끝나면 반납한다.
AI 도구에서는 MCP로 같은 기능을 사용할 수 있다.

Node 20+와 git이 필요하다. 터미널 연결용 라이브러리는 npm 설치에 함께 포함된다.
npm 패키지 이름은 `axmap-cli`, 실행 명령은 `axmap`이다.

## 설치

Git 저장소 밖을 포함해 어느 폴더에서든 실행한다.

```bash
npm install -g axmap-cli@latest
axmap setup
```

`setup`은 이 PC에 axMap을 설치하고 AI 도구의 사용자 설정에 MCP를 등록한다. 실행한 폴더에 타겟을 고정하거나 repo를 초기화하지 않는다.
MCP를 사용하려면 설정 후 AI 도구를 다시 시작한다.
함께 작업하는 사람과 에이전트는 같은 원격 장부를 사용해야 서로의 선점을 볼 수 있다.

## 1.3.3: Windows Codex 등록 오류 수정

Windows에서 npm으로 설치한 Codex도 `axmap setup`으로 정상 등록한다. 셸 실행 파일 대신 패키지의 Node 진입점을 직접 실행해 경로와 인수를 그대로 전달한다.

## 1.3.2: 쪽지 표시 이름과 사용자 자동 공유

대화형 `setup`에서 `장효준`, `John Smith`처럼 쪽지에 표시할 이름을 입력한다. 입력 없이 설정하거나 오타를 고치려면 `axmap setup --name "장효준"`을 실행한다. 재설치할 때는 저장된 이름을 유지하며 Git 이름·이메일 설정은 바꾸지 않는다.

각 repo에서 axMap을 처음 사용하면 해당 repo의 Git 이메일을 읽고 기존 `axmap/users` 고아 브랜치에 표시 이름을 자동 공유한다. 코드 커밋이나 repo별 수동 등록은 필요 없다. 다른 팀원은 사용자 정보 동기화 후 수신자로 발견한다. 원격 push 권한이 필요하며, 공유 실패는 경고하고 다음 사용 때 재시도한다. `setup`만 실행하고 사용한 적 없는 repo에는 등록하지 않는다.

`axmap bus contacts`로 수신자 이름·이메일을 확인한다. 아는 이름으로 보낸 쪽지는 이메일 주소로 저장하므로 이름을 고쳐도 수신·읽음 기록이 이어진다. 동명이인은 이메일로 지정한다. 쪽지 자동 등록은 투표권이나 MR 승인 권한을 부여하지 않는다.

자세한 설치·설정은 [docs/INSTALL.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INSTALL.md)를 참고한다.

## 1.3.1: 어느 폴더에서든 setup 한 번, 이후 repo 자동 연결

axMap을 한 번 설정하면 다른 Git 저장소에서도 Codex 등 AI CLI를 열어 바로 사용할 수 있다. 세션의 작업 repo를 자동으로 선택하고, 첫 조회·선점 때 장부를 준비하므로 매번 `axmap init`을 실행하지 않아도 된다.

기존 원격 장부가 있으면 이어 쓰고, 같은 repo의 worktree는 장부 하나를 공유한다. 서로 다른 repo의 동시 세션은 독립적으로 동작한다. 원격 접근 실패를 장부 없음으로 판단해 별도 장부를 만들지 않는다.

MCP는 클라이언트가 알려주는 작업 폴더(roots)를 따라간다. 미지원 클라이언트는 시작 폴더를 사용하며, 도중에 폴더를 바꾸면 도구의 `cwd`에 작업 폴더 절대 경로를 전달한다. 커밋 훅을 적용할 새 repo에서는 `axmap hook install`을 실행한다.

기존 설치를 업그레이드할 때도 어느 폴더에서든 아래 명령을 한 번 실행하고 AI CLI를 다시 시작한다.

```bash
npm install -g axmap-cli@latest
axmap setup
```

`setup`은 MCP와 공유 훅 실행 사본 및 등록을 갱신한다. 이후 repo를 옮길 때는 setup이나 init을 반복하지 않는다. 특정 repo의 장부와 커밋 훅까지 미리 준비하려면 `axmap setup --repo <경로>`를 명시한다.

## 작업 흐름

```bash
# 지금 누가 무엇을 잡고 있는지 확인
axmap status

# 수정 전에 경로와 목적을 선언
axmap claim src/auth --agent my-agent --session my-session --task T-12 --intent "토큰 만료 처리"

# 파일을 수정한 뒤 커밋할 변경을 준비하고 선점 범위를 확인
git add src/auth
axmap verify --agent my-agent --session my-session

# 작업이 끝나면 반납
axmap release --agent my-agent --session my-session
```

에이전트 이름과 세션은 각 작업 세션마다 고유하게 정하고, 선점부터 반납까지 같은 값을 쓴다.
커밋 훅에서도 같은 식별자를 사용하도록 `AXMAP_AGENT`와 `AXMAP_SESSION` 환경변수를 설정한다.
선점이 거절되면 메시지의 점유자·작업·남은 시간을 확인하고 겹치지 않는 영역을 선택한다.
필요한 경로만 잡고, 작업이 길어지면 `axmap renew`에 같은 agent와 session을 지정해 갱신한다.

`git worktree`로 나눈 작업 폴더도 같은 장부를 사용한다.
`release`는 현재 세션이 잡은 경로를 반납한다.

## 동작 방식

git은 변경을 합칠 때 텍스트 충돌을 발견한다.
axMap은 수정 전에 경로를 선점해, 여러 에이전트가 같은 영역을 동시에 고치는 상황을 먼저 막는다.

선점 장부는 전용 git 브랜치에 저장한다. 원격의 최신 장부를 확인하고,
git ref의 원자적 갱신과 경로 겹침 판정으로 선점한다.
커밋 훅은 실제 수정 경로와 선점 범위를 대조한다.
`axmap audit`은 장부 이력을 재생해 규칙 위반을 검사한다.

상태를 읽지 못하면 그 이유를 알리고, 판정할 수 없는 상태를 성공으로 처리하지 않는다.
프로토콜은 [docs/SPEC.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/SPEC.md), 지켜야 할 성질은 [docs/INVARIANTS.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INVARIANTS.md)에 있다.

## AI 도구에서 사용

MCP를 연결하면 `ax_claim`, `ax_status`, `ax_release` 등의 도구를 AI가 호출할 수 있다.
에이전트에게 다음 작업 규칙을 전달한다.

```text
파일을 수정하기 전에 ax_claim으로 경로와 목적을 선언한다.
선점이 거절되면 점유자를 확인하고 겹치지 않는 다른 작업을 선택한다.
작업이 끝나면 ax_release로 반납한다.
```

연결 방법과 도구 목록은 [mcp/README.md](https://github.com/rl2aderjoon/axmap/blob/main/mcp/README.md)를 참고한다.

## 개발과 검증

```bash
git clone https://github.com/rl2aderjoon/axmap.git
cd axmap
node bin/axmap.mjs --version
npm test
npm run demo
npm run demo:compare
npm run demo:chaos
```

선점 CLI는 소스에서 바로 실행할 수 있다. 터미널 연결 개발·검증은 `npm install`로 의존성을 설치한다. 데모는 bash 환경에서 실행한다.
소스 확인에는 `node bin/axmap.mjs`를 사용한다.

| 문서 | 내용 |
|---|---|
| [CLAUDE.md](https://github.com/rl2aderjoon/axmap/blob/main/CLAUDE.md) | 소스 작업 규칙 |
| [docs/INSTALL.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INSTALL.md) | 설치와 사용 |
| [docs/SPEC.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/SPEC.md) | 명령과 선점 프로토콜 |
| [docs/INVARIANTS.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/INVARIANTS.md) | 불변식과 검증 기준 |
| [docs/DECISIONS.md](https://github.com/rl2aderjoon/axmap/blob/main/docs/DECISIONS.md) | 제품 범위와 설계 결정 |

## 라이선스

[MIT](https://github.com/rl2aderjoon/axmap/blob/main/LICENSE)
