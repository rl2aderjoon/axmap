# axMap 설치와 사용

Node 20 이상과 git이 필요하다. npm 패키지 이름은 `axmap-cli`, 설치 후 명령 이름은 `axmap`이다.

```bash
npm install -g axmap-cli@latest
cd <사용할-git-저장소>
axmap setup
axmap doctor
```

`setup`은 AI 도구의 사용자 설정에 MCP를 등록하고, 현재 저장소의 선점 장부와 커밋 훅을 준비한다. 다른 저장소에 연결하려면 `--remote <git-주소>`를 명시한다. 먼저 확인하려면 `--dry-run`을 사용한다. 설정 후 AI 도구를 다시 시작한다.

```bash
axmap claim src/auth --agent my-agent --session my-session --task T-12 --intent "로그인 검증"
axmap status
axmap release --agent my-agent --session my-session
axmap update
```

각 세션에 고유한 agent와 session을 사용한다. 거절 메시지의 점유자와 작업 범위를 확인하고, 겹치지 않는 영역을 선택한다. 업데이트는 `npm install -g axmap-cli@latest`로 직접 적용한다.

소스 개발은 [ONBOARD-TEAM.md](ONBOARD-TEAM.md), MCP 연결은 [MCP 안내](../mcp/README.md), 동작 규격은 [SPEC.md](SPEC.md)를 참고한다.
