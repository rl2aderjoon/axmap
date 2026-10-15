# axMap 설치와 사용

Node 20 이상과 git이 필요하다. npm 패키지 이름은 `axmap-cli`, 설치 후 명령 이름은 `axmap`이다.

```bash
npm install -g axmap-cli@latest
axmap setup
```

Git 저장소 밖을 포함해 어느 폴더에서든 실행한다. `setup`은 이 PC에 프로그램과 전역 명령을 설치하고 AI 도구의 사용자 설정에 MCP를 등록한다. 실행한 폴더의 repo를 초기화하거나 타겟으로 저장하지 않는다. 먼저 확인하려면 `--dry-run`을 사용한다. 설정 후 AI 도구를 다시 시작하고 원하는 Git repo에서 실행한다.

## 1.3.1부터: 어디서든 setup 한 번, repo는 실행 위치에서 결정한다

기존 설치를 업그레이드할 때는 `npm install -g axmap-cli@latest` 뒤에 어느 폴더에서든 `axmap setup`을 한 번 실행하고 AI CLI를 재시작한다. 전역 npm 패키지와 등록된 MCP·공유 훅 실행 사본을 함께 갱신하기 위한 단계다. 1.3.0에서 남아 있던 setup의 Git repo 필수 조건은 1.3.1에서 제거했다.

설치와 MCP 등록은 한 번만 한다. 이후 201에서 109로 옮겨 AI CLI를 실행하면 해당 세션의 작업 repo를 사용한다. CLI도 현재 폴더의 Git repo를 사용한다. `status`, `claim`, `renew`, `release`, `verify`는 장부가 없으면 자동으로 준비한다. `doctor`는 진단만 한다.

MCP 타겟 우선순위는 `AXMAP_REPO`로 명시한 고정 경로 → 도구의 절대 경로 `cwd` → 클라이언트의 작업 폴더(roots) → MCP 시작 폴더다. 앱의 전역 `current.json`은 CLI 세션의 타겟을 바꾸지 않는다. roots 변경 알림을 받으면 새 repo로 전환하고 이전 repo에서 이 세션이 잡은 claim을 반납한다. roots가 여러 repo를 가리키고 시작 repo로도 고를 수 없으면 `cwd`를 지정한다. roots 미지원 클라이언트의 실행 중 폴더 변경도 `cwd`로 전달한다.

자동 준비는 원격의 `axmap/claims`가 있으면 이어 쓰고, 없다고 확인된 경우 새 고아 브랜치를 만든다. 원격이 없는 repo는 경고와 함께 로컬 모드로 동작한다. 원격 선택이 모호하거나 원격 확인이 실패하면 요청을 중단한다. GitHub와 GitLab 모두 같은 Git 프로토콜을 사용한다.

같은 repo의 worktree들은 메인 체크아웃의 장부 하나를 공유하며, 동시 초기화는 Git 공통 디렉터리의 잠금으로 직렬화한다. 자동 준비는 `.git/info/exclude`를 사용하므로 프로젝트의 `.gitignore`나 코드 브랜치를 수정하지 않는다. 강제 종료로 `axmap-init.lock`이 남았다면 해당 프로세스가 끝났는지 확인하고 오류에 표시된 잠금 파일을 제거한다.

`axmap init --remote <Git-원격-이름>`과 MCP의 `ax_init(remote: "원격-이름")`은 명시적 준비용으로 유지한다. 커밋 훅은 repo별 선택 사항이며 새 repo에 적용하려면 `axmap hook install`을 실행한다.

특정 repo를 미리 초기화하고 커밋 훅도 설치하려면 `axmap setup --repo <경로>`를 명시한다. `--remote <이름|URL>`이나 `--commands project`도 명시적 프로젝트 설정 옵션이며 대상 Git repo가 필요하다. 기본 전역 setup에서는 장부와 커밋 훅을 만들지 않는다. Codex 등록은 서버 경로와 환경을 확인해 예전 경로·고정 `AXMAP_REPO`·서버 시작 `cwd`를 갱신하고, 개인 환경값과 다른 MCP 서버는 보존한다.

```bash
axmap claim src/auth --agent my-agent --session my-session --task T-12 --intent "로그인 검증"
axmap status
axmap release --agent my-agent --session my-session
axmap update
```

각 세션에 고유한 agent와 session을 사용한다. 거절 메시지의 점유자와 작업 범위를 확인하고, 겹치지 않는 영역을 선택한다. 업데이트는 `npm install -g axmap-cli@latest`로 직접 적용한다.

소스 개발은 [ONBOARD-TEAM.md](ONBOARD-TEAM.md), MCP 연결은 [MCP 안내](../mcp/README.md), 동작 규격은 [SPEC.md](SPEC.md)를 참고한다.
