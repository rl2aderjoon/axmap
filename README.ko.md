# axMap

[![English](docs/assets/readme-en.svg)](README.md) [![한국어](docs/assets/readme-ko.svg)](README.ko.md)

**여러 AI 에이전트가 같은 git 저장소에서 작업할 때, 수정할 경로를 먼저 선점해 충돌을 예방하는 CLI 도구.**

누가 어디를 고치는지 장부에 기록하고, 겹치는 경로의 선점을 거부한다.
커밋 훅으로 선점 범위를 확인하고, 작업이 끝나면 반납한다.
AI 도구에서는 MCP로 같은 기능을 사용할 수 있다.

Node 20+와 git이 필요하다. CLI의 런타임 의존성은 없다.
npm 패키지 이름은 `axmap-cli`, 실행 명령은 `axmap`이다.

## 설치

사용할 git 저장소에서 실행한다.

```bash
npm install -g axmap-cli@latest
cd <프로젝트-저장소>
axmap setup
axmap doctor
```

`setup`은 저장소의 선점 장부와 커밋 훅을 준비하고, AI 도구의 사용자 설정에 MCP를 등록한다.
MCP를 사용하려면 설정 후 AI 도구를 다시 시작한다.
함께 작업하는 사람과 에이전트는 같은 원격 장부를 사용해야 서로의 선점을 볼 수 있다.

자세한 설치·설정은 [docs/INSTALL.md](docs/INSTALL.md)를 참고한다.

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
프로토콜은 [docs/SPEC.md](docs/SPEC.md), 지켜야 할 성질은 [docs/INVARIANTS.md](docs/INVARIANTS.md)에 있다.

## AI 도구에서 사용

MCP를 연결하면 `ax_claim`, `ax_status`, `ax_release` 등의 도구를 AI가 호출할 수 있다.
에이전트에게 다음 작업 규칙을 전달한다.

```text
파일을 수정하기 전에 ax_claim으로 경로와 목적을 선언한다.
선점이 거절되면 점유자를 확인하고 겹치지 않는 다른 작업을 선택한다.
작업이 끝나면 ax_release로 반납한다.
```

연결 방법과 도구 목록은 [mcp/README.md](mcp/README.md)를 참고한다.

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

루트 CLI를 실행하기 위한 `npm install`은 필요 없다. 데모는 bash 환경에서 실행한다.
소스 확인에는 `node bin/axmap.mjs`를 사용한다.

| 문서 | 내용 |
|---|---|
| [CLAUDE.md](CLAUDE.md) | 소스 작업 규칙 |
| [docs/INSTALL.md](docs/INSTALL.md) | 설치와 사용 |
| [docs/SPEC.md](docs/SPEC.md) | 명령과 선점 프로토콜 |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | 불변식과 검증 기준 |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 제품 범위와 설계 결정 |

## 라이선스

[MIT](LICENSE)
