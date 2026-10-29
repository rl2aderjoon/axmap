# 배포 경로

소스: https://github.com/rl2aderjoon/axmap

npm: https://www.npmjs.com/package/axmap-cli

루트 패키지는 `axmap-cli`이며 실행 명령은 `axmap`이다. `package.json`의 `files`가 CLI·MCP·거버넌스·설정 도구의 npm 배포 범위를 정한다. 터미널 연결에 필요한 의존성은 npm이 함께 설치하며, 사용자가 별도로 준비하지 않는다. 테스트는 소스 저장소에서 제공한다.

```bash
npm pack --dry-run
```

배포 전 패키지 내용과 검증 결과를 확인한다. 버전 변경과 실제 `npm publish`는 별도 릴리스 작업으로 진행한다. npm에 이미 배포된 버전의 저장소 링크는 GitHub 이관만으로 갱신되지 않는다.

1.7.0의 변경 범위와 패키지 검증 절차는 [릴리스 기록](RELEASE-1.7.0.md)을 따른다.

axMap은 npm 패키지와 이 소스 저장소로만 배포한다. 팀 저장소 안에 코드를 복사해 두던 방식(`tools/vendor.mjs` → `ci/axmap/`)은 2026-10-29에 폐기했다([D31](DECISIONS.md)). 팀 CI와 커밋 훅은 설치한 `axmap` 명령(`axmap gate`·`axmap vote` 등)을 부른다. [거버넌스 도구](../governance/GOVERNANCE.md)의 적용 환경을 확인한다.
