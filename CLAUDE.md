# axMap 작업 규칙

axMap은 여러 AI 에이전트의 작업 경로를 선점하고 충돌을 예방하는 CLI·MCP 협업 도구다.
쪽지와 로컬 세션 연결도 이 범위에 포함한다. 현재 제품 결정은 `docs/DECISIONS.md`를 따른다.
산문은 `axMap`, 식별자와 명령은 `axmap`, npm 패키지는 `axmap-cli`를 쓴다.

개발 기준은 `main`이다. 소스 확인에는 `node bin/axmap.mjs`를 사용한다.
PATH의 `axmap`은 npm 설치본일 수 있다.

## 작업 절차

1. `docs/DECISIONS.md`, `docs/THREADS.md`, `docs/SPEC.md`, `docs/INVARIANTS.md`에서 관련 내용을 읽는다.
2. 세션마다 고유한 `AXMAP_AGENT`와 `AXMAP_SESSION`을 정하고, 변경 전에 필요한 경로를 선점한다.
3. 선점이 겹치면 다른 영역으로 옮긴다. 작업이 끝나면 같은 신원으로 반납한다.
4. 선점 없는 커밋을 만들거나 `git commit --no-verify`로 훅을 우회하지 않는다. push 대상 원격과 브랜치를 확인한다.

## 구현 기준

Node 20+와 Git을 사용한다. 터미널 연결 의존성은 npm 설치에 포함하며 별도 컴파일러 설치를 요구하지 않는다.
새 의존성은 추가 전에 사용자와 논의한다. 이번 터미널 의존성 추가는 사용자가 승인했다.

없는 데이터와 읽지 못한 데이터를 구별한다. 판정을 못 하면 통과시키지 않는다.
주석에는 구현 이유를 쓰고, 수치에는 측정 조건과 근거를 붙인다. 테스트 개수나 미측정 성능을 문서에 쓰지 않는다.
가짜 provider의 테스트 결과를 실제 AI CLI 연결 성공으로 소개하지 않는다.

## 검증

```bash
npm test
npm run demo
npm run demo:compare
npm run demo:chaos
```

프로토콜 변경은 회귀 테스트와 경합 데모로 검증한다. 설치 변경은 격리된 사용자 환경에서 검사한다.
성공 여부는 종료 코드로 판단한다. 필요한 실행 환경이 없으면 검증 제한을 보고한다.
