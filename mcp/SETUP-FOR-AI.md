# AI 도구에 axMap 연결하기

이 문서의 공개 주소: https://github.com/rl2aderjoon/axmap/blob/main/mcp/SETUP-FOR-AI.md

Node 20 이상과 git을 확인한다. npm 패키지 이름은 `axmap-cli`다.

```bash
npm install -g axmap-cli@latest
```

사용자가 지정한 git 저장소에서 다음 명령을 실행한다. 대상 저장소가 불분명하면 먼저 확인한다.

```bash
axmap setup --dry-run
axmap setup
axmap doctor
```

`setup`은 AI CLI의 사용자 설정에 MCP를 등록하고 대상 저장소에 장부와 훅을 만든다. 전역 MCP 등록에 `AXMAP_REPO`를 특정 폴더로 고정하지 않는다. 다른 원격을 공유하려면 `--remote <git-주소>`를 명시한다.

1.3.0부터 다른 repo로 이동할 때 `setup`이나 `init`을 반복하지 않는다. 새 작업 repo에서 AI CLI를 실행하면 첫 조회·선점 시 장부를 자동 준비한다. MCP roots가 지원되면 작업 폴더 변경도 따라간다. 지원되지 않거나 여러 repo가 열려 있으면 도구의 `cwd`에 현재 작업 폴더 절대 경로를 전달한다. 커밋 훅을 새 repo에도 적용하려면 `axmap hook install`을 실행한다.

명령의 종료 코드를 확인하고 실패한 단계를 보고한다. AI CLI를 완전히 종료한 뒤 다시 시작해 `ax_*` 도구를 확인한다. 설치 과정에서 커밋하거나 push할 필요는 없다. 기존 소스 폴더를 삭제하지 않는다.

소스 설치는 [개발 안내](../docs/ONBOARD-TEAM.md), 명령 사용은 [INSTALL.md](../docs/INSTALL.md)를 참고한다.
