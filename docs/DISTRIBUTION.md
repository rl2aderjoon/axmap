# 배포 경로

소스: https://github.com/rl2aderjoon/axmap

npm: https://www.npmjs.com/package/axmap-cli

루트 패키지는 `axmap-cli`이며 실행 명령은 `axmap`이다. `package.json`의 `files`가 CLI·MCP·거버넌스·설정 도구의 npm 배포 범위를 정한다. 터미널 연결에 필요한 의존성은 npm이 함께 설치하며, 사용자가 별도로 준비하지 않는다. 테스트는 소스 저장소에서 제공한다.

```bash
npm pack --dry-run
```

배포 전 패키지 내용과 검증 결과를 확인한다. 버전 변경과 실제 `npm publish`는 별도 릴리스 작업으로 진행한다. npm에 이미 배포된 버전의 저장소 링크는 GitHub 이관만으로 갱신되지 않는다.

1.7.0의 변경 범위와 패키지 검증 절차는 [릴리스 기록](RELEASE-1.7.0.md)을 따른다.

팀 CI에 사본이 필요한 경우 `node tools/vendor.mjs --to <대상-저장소> --repo https://github.com/rl2aderjoon/axmap.git`을 사용한다. 원본 주소와 해시를 함께 기록하며 [거버넌스 도구](../governance/GOVERNANCE.md)의 적용 환경을 확인한다.
