# axMap 1.11.1

npm의 CLI 분류(`keywords:cli` 검색)에 나오도록 `package.json` 키워드에 `cli`를 더한다.
실행 코드와 설치 동작은 1.11.0과 같다.

## 검증과 배포

`npm test`, `npm run build:check`, 기본·비교·카오스 데모의 종료 코드로 검증한다.
`npm pack` 결과를 격리 prefix에 설치해 CLI 버전과 MCP 도구 목록을 확인한 뒤,
같은 tarball을 npm latest로 게시하고 원격 버전·integrity·키워드를 대조한다.
Git main과 v1.11.1 태그를 같은 릴리스 커밋으로 게시한다.

npm 분류 목록의 순서는 npm 검색 점수로 정해져 키워드만으로 앞쪽 노출을 보장하지 않는다.
