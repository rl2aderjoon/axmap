# axMap 작업 규칙

axMap은 AI의 작업을 사람이 이해하고 제어하는 도구다. 산문은 `axMap`, 식별자와 명령은 `axmap`, npm 패키지는 `axmap-cli`를 쓴다.

개발 기준은 `main`이다. 이 저장소의 소스 확인에는 `node bin/axmap.mjs`를 사용한다. PATH의 `axmap`은 npm 설치본일 수 있다.

## 작업 절차

1. `docs/DECISIONS.md`, `docs/THREADS.md`, `docs/SPEC.md`, `docs/INVARIANTS.md`에서 관련 결정과 규격을 읽는다.
2. 세션마다 고유한 `AXMAP_AGENT`와 `AXMAP_SESSION`을 정한다. 변경 전에 `node bin/axmap.mjs claim <경로> --task <작업> --intent "목적"`으로 선점한다.
3. 선점이 겹치면 다른 영역으로 옮긴다. 필요한 경로만 잡고, 끝나면 `node bin/axmap.mjs release`로 반납한다.
4. 선점 없는 커밋을 만들거나 `git commit --no-verify`로 훅을 우회하지 않는다. push 대상 원격과 브랜치를 확인한다.

## 구현 기준

루트 CLI는 Node 20+와 git만으로 동작한다. 새 의존성은 추가 전에 사용자와 논의한다. 데스크톱 셸의 기존 의존성은 `desktop/package.json`을 따른다.

없는 데이터와 읽지 못한 데이터를 구별한다. 판정을 못 하면 통과시키지 않는다. 주석에는 구현 이유를 쓰고, 수치에는 측정 조건과 근거를 붙인다. 테스트 개수나 미측정 성능을 문서에 쓰지 않는다.

## 검증

```bash
npm test
npm run demo
npm run demo:compare
npm run demo:chaos
npm run smoke
```

프로토콜 변경은 회귀 테스트와 경합 데모로 검증하고, 화면 변경은 브라우저 스모크를 돌린다. 데스크톱 변경은 설치된 Electron으로 `npm run desktop:smoke`를 추가한다. 성공 여부는 종료 코드로 판단한다. 필요한 실행 환경이 없으면 검증 제한을 보고한다.
