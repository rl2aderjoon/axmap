# axMap 설치와 사용

현재 소스 버전은 **1.5.0**이다. Node.js 20 이상과 Git이 필요하다. setup은 Windows에서는 PowerShell, macOS·Linux에서는 Bash를 사용한다. 연결할 AI CLI는 별도로 설치하고 인증을 마쳐 둔다.

npm 패키지 이름은 **`axmap-cli`**, 설치 후 명령 이름은 **`axmap`**이다. `npx axmap`은 다른 패키지를 실행하므로 사용하지 않는다.

## 설치

```bash
npm install -g axmap-cli@latest
axmap setup
```

Git 저장소 밖을 포함해 어느 폴더에서든 실행한다. `setup`은 이 PC에 프로그램과 전역 명령을 설치하고 AI 도구의 사용자 설정에 MCP를 등록한다. 실행한 폴더의 repo를 초기화하거나 타겟으로 저장하지 않는다. 먼저 확인하려면 `axmap setup --dry-run`을 사용한다. 설정 후 AI 도구를 완전히 종료하고 원하는 Git repo에서 다시 시작한다.

| setup 항목 | 기본 동작 |
|---|---|
| 실행 사본 | `~/.axmap/app`에 CLI·MCP·도구와 터미널 연결 의존성을 준비한다 |
| MCP | 감지한 Claude Code·Codex·Antigravity의 사용자 설정에 등록한다 |
| Claude Code 슬래시 명령 | `~/.claude/commands`에 설치한다. 내용이 다른 기존 파일은 보존한다 |
| CLI 연결 훅 | Antigravity·Codex 훅을 사용자 설정에 병합한다. `axmap run` 세션과 Windows에서 직접 실행한 대화형 `agy`를 등록한다 |
| 저장소 장부·Git 커밋 훅 | 기본 setup에서는 만들지 않는다. 장부는 첫 사용 때 자동 준비하고 커밋 훅은 저장소별로 선택한다 |
| 프롬프트마다 쪽지 확인 | 기본으로 추가하지 않는다. Claude Code에서 필요하면 `setup --hook`을 사용한다 |

CLI 연결 훅, 쪽지 확인 훅, Git 커밋 훅은 각각 별개다. 관리형 `bridge serve` 자체는 전역 훅을 추가하지 않는다. setup 종료 코드는 `0` 성공, `1` 시작 불가, `2` 일부 실패다. 일부 실패라면 출력의 실패 항목을 해결하고 다시 실행한다.

## 표시 이름과 쪽지

1.3.2부터 대화형 setup은 쪽지 표시 이름을 입력받아 `~/.axmap/profile.json`에 저장한다. 기본 후보는 저장된 이름, Git 이름, OS 사용자 이름 순이다. 자동화 환경에서는 입력을 기다리지 않고 후보를 저장하며 `--name "장효준"`으로 명시할 수 있다. `--dry-run`은 프로필도 수정하지 않는다. 이름을 고칠 때도 `axmap setup --name "새 이름"`을 사용한다.

이메일은 입력받거나 전역 프로필에 고정하지 않는다. 실제 작업 repo의 `git config user.email`을 읽고, 최초 CLI 조회·선점 또는 MCP 사용 때 기존 `axmap/users`에 이름·별칭을 자동 공유한다. 원격이 없으면 로컬에만 저장하고, push가 실패하면 공유되지 않았음을 알린 뒤 재시도한다. Git 이메일이 없으면 해당 repo의 Git 설정을 안내한다. 표시 이름은 기존 선점 이름과 분리되어 이름 수정으로 claim 소유자가 바뀌지 않는다.

수신자 목록은 `axmap bus contacts`로 확인한다. 알려진 수신자 이름은 전송 시 이메일로 확정하며, 동명이인은 이메일을 지정해야 한다. 기존 프로필과 읽음 기록은 유지한다. 참여 프로필 공유에는 해당 원격 브랜치 push 권한이 필요하고, 투표권자 명단·MR 정책은 변경하지 않는다.

## 업그레이드

```bash
axmap update
npm install -g axmap-cli@latest
axmap setup
```

`axmap update`는 새 버전 유무만 조회한다. 실제 업그레이드는 npm 설치와 setup을 함께 실행한 뒤 AI CLI를 재시작해야 끝난다. 전역 npm 패키지와 등록된 MCP·연결 훅의 실행 사본을 함께 갱신하기 위한 단계다. 설치된 버전은 `axmap --version`으로 확인한다. 1.3.0에서 남아 있던 setup의 Git repo 필수 조건은 1.3.1에서 제거했다.

## 설치 확인과 첫 사용

원하는 Git repo에서 다음 명령을 실행한다.

```bash
axmap --version
axmap status
axmap doctor
```

MCP를 등록한 AI 도구에는 다음과 같이 요청한다.

```text
ax_brief로 이 저장소를 파악하고, ax_status로 지금 누가 무엇을 선점했는지 보여줘.
파일을 수정하기 전에 ax_claim으로 경로를 선언하고, 작업이 끝나면 ax_release로 반납해.
```

`doctor`의 MCP 검사는 repo의 `.mcp.json`을 대상으로 하므로 전역 등록 성공 여부는 setup 결과와 실제 AI 도구에서도 확인한다.

### 작업 repo와 장부

설치와 MCP 등록은 PC에서 한 번만 한다. 이후 다른 repo에서 AI CLI를 실행하면 해당 세션의 작업 repo를 사용한다. CLI도 현재 폴더의 Git repo를 사용한다. `status`, `claim`, `renew`, `release`, `verify`는 장부가 없으면 자동으로 준비한다. `doctor`는 진단만 한다.

MCP 타겟 우선순위는 `AXMAP_REPO`로 명시한 고정 경로 → 도구의 절대 경로 `cwd` → 클라이언트의 작업 폴더(roots) → MCP 시작 폴더다. roots 변경 알림을 받으면 새 repo로 전환하고 이전 repo에서 이 세션이 잡은 claim을 반납한다. roots가 여러 repo를 가리키고 시작 repo로도 고를 수 없으면 `cwd`를 지정한다. roots 미지원 클라이언트의 실행 중 폴더 변경도 `cwd`로 전달한다.

자동 준비는 원격의 `axmap/claims`가 있으면 이어 쓰고, 없다고 확인된 경우 새 고아 브랜치를 만든다. 원격이 없는 repo는 경고와 함께 로컬 모드로 동작한다. 원격 선택이 모호하거나 원격 확인이 실패하면 요청을 중단한다. GitHub와 GitLab 모두 같은 Git 프로토콜을 사용한다.

같은 repo의 worktree들은 메인 체크아웃의 장부 하나를 공유하며, 동시 초기화는 Git 공통 디렉터리의 잠금으로 직렬화한다. 자동 준비는 `.git/info/exclude`를 사용하므로 프로젝트의 `.gitignore`나 코드 브랜치를 수정하지 않는다. 강제 종료로 `axmap-init.lock`이 남았다면 해당 프로세스가 끝났는지 확인하고 오류에 표시된 잠금 파일을 제거한다.

### CLI 선점과 반납

```bash
axmap claim src/auth --agent my-agent --session my-session --task T-12 --intent "로그인 검증"
axmap status
axmap release --agent my-agent --session my-session
```

각 세션에 고유한 agent·session 조합을 사용하고 선점부터 반납까지 같은 값을 유지한다. 거절 메시지의 점유자와 작업 범위를 확인하고, 겹치지 않는 영역을 선택한다.

## Codex·Antigravity 관리형 세션 연결 (1.4.0)

같은 Git repo의 터미널 두 곳에서 각각 실행한다. 두 CLI가 PATH에서 검색되고 각자 인증된 상태여야 한다.

```bash
axmap bridge serve codex --role "구현 검토 담당"
```

```bash
axmap bridge serve agy --role "리뷰 담당"
```

각 명령은 새 관리형 세션을 시작하고 UUID를 표시한다. 모델을 지정하려면 `--model <이름>`을 추가한다. Antigravity 모델은 `agy models`에서 현재 계정에 제공되는 이름을 확인한다. 이미 열어 둔 일반 CLI 창에 나중에 연결하는 기능은 아니다.

세 번째 터미널도 같은 repo에서 열고 UUID를 확인한 뒤 작업을 stdin으로 전달한다. 다음은 PowerShell 예시다. `<Codex-UUID>`와 `<agy-UUID>`는 실제 값으로 바꾼다.

```powershell
axmap bridge sessions
'변경 검토 방법을 합의하고 합의가 끝나면 종료하세요.' | axmap bridge chat --left '<Codex-UUID>' --right '<agy-UUID>' --max-turns 4 --max-tokens 50000
```

`--background`를 추가하면 접수 ID를 반환하고 백그라운드에서 중계한다. 이후 다음 명령으로 결과를 조회하거나 추가 중계를 중단한다.

```bash
axmap bridge dialogue <대화-UUID>
axmap bridge stop <대화-UUID>
```

MCP에서는 `ax_sessions` → `ax_chat(left, right, prompt)` → `ax_dialogue(id)`를 사용하고, 중단은 `ax_chat_stop(id)`로 요청한다. 단일 작업은 `ax_dispatch`와 `ax_result`로 전달·조회한다.

기본 대화 한도는 모델 실행 4회, 처리 토큰 50000, 메시지 2000자이며 관리형 세션의 기본 누적 한도는 100000 처리 토큰이다. 한도는 다음 실행 전에 검사하므로 첫 요청이나 더 비싼 후속 요청이 예산을 넘을 수 있다. 대기·결과 조회는 모델을 호출하지 않는다. `stop` 뒤에도 이미 제출된 요청은 실행될 수 있으며, 호스트를 종료하려면 해당 터미널에서 Ctrl+C를 누른다.

Codex가 실행 승인을 요청하면 사용자가 `bridge answer`로 결정한다. 세션·요청·대화·사용량 기록은 로컬 `~/.axmap/bridge`에 저장한다. 관리형 연결의 검증 범위, 승인 방법과 비용 해석은 [세션 연결 안내](SESSION-BRIDGE.md)를 따른다.

1.5.0부터 `axmap bridge status [--json]`으로 로컬 연결·작업·승인 대기 상태를 조회한다. `bridge sessions`는 등록 목록을 확인한다. 등록 목록만으로 현재 연결이나 작업 완료를 판단하지 않는다.

### 대화형 터미널 연결 실험

Windows에서 일반 `agy`로 직접 여는 창은 설치된 훅으로 자동 등록한다. 기존 창은 실제 작업
저장소에서 `axmap bridge attach --pid <agy-PID>`로 연결한 뒤 `ax_dispatch`/`ax_result`를
사용한다. 재시작이나 `axmap run`으로 다시 여는 과정은 필요하지 않다. 입력 중에는 전달을
거절하며, 토큰 예산이 필요한 `ax_chat`은 관리형 stdio만 지원한다.
자세한 절차와 실제 연결 검증은 [독립 agy 연결](SESSION-BRIDGE.md#windows에서-따로-실행한-agy-연결)을 참고한다.

`axmap run agy|codex`는 사용자가 직접 여는 대화형 터미널을 연결하는 별도 프로토타입이다. 실제 LLM을 사용한 PTY 연결 검증은 남아 있다. setup의 실행 사본에는 필요한 터미널 의존성을 함께 준비하므로 별도 컴파일러 설치를 기본 절차로 요구하지 않는다. Codex가 새 훅의 신뢰 확인을 요청하면 사용자가 검토해야 하며, Windows 홈 경로에 공백이 있는 경우의 훅 실행에는 현재 제한이 있다.

기존 agentapi 경로의 `bridge install --experimental`도 별도 실험용이다. 일반 설치와 관리형 자동 대화에 이 명령을 실행할 필요는 없다.

## 선택 설정

특정 repo를 미리 초기화하고 커밋 훅도 설치하려면 다음처럼 경로를 명시한다.

```bash
axmap setup --repo <Git-repo-경로>
```

`--remote <이름|URL>`이나 `--commands project`도 명시적 프로젝트 설정 옵션이며 대상 Git repo가 필요하다. URL과 일치하는 원격이 없으면 setup이 `axmap` 원격을 추가한다. 기본 전역 setup에서는 장부와 커밋 훅을 만들지 않는다. `--no-ledger`는 명시적 프로젝트 설정에서도 장부·커밋 훅 준비를 건너뛴다.

슬래시 명령 설치를 생략하려면 `setup --commands none`, 실행 사본 경로를 바꾸려면 `setup --dest <경로>`를 사용한다. 전체 옵션은 `axmap setup --help`로 확인한다.

`axmap init --remote <Git-원격-이름>`과 MCP의 `ax_init(remote: "원격-이름")`은 명시적 준비용으로 유지한다. 커밋 훅은 repo별 선택 사항이며 새 repo에 적용하려면 `axmap hook install`을 실행한다.

Codex 등록은 서버 경로와 환경을 확인해 예전 경로·고정 `AXMAP_REPO`·서버 시작 `cwd`를 갱신하고, 개인 환경값과 다른 MCP 서버는 보존한다.

소스 개발은 [ONBOARD-TEAM.md](ONBOARD-TEAM.md), MCP 연결은 [MCP 안내](../mcp/README.md), 동작 규격은 [SPEC.md](SPEC.md)를 참고한다.
