# axMap 소스 개발

```bash
git clone https://github.com/rl2aderjoon/axmap.git
cd axmap
node bin/axmap.mjs --version
npm test
```

기본 브랜치는 `main`이다. 루트 CLI와 웹 서버는 Node 20 이상과 git만으로 동작하며 `npm install`이 필요 없다. 데스크톱 셸은 [desktop/README.md](../desktop/README.md)의 별도 설치 절차를 따른다.

```bash
node app/server.mjs . 7777
```

브라우저에서 `http://127.0.0.1:7777`을 연다. 다른 코드베이스를 분석하려면 `.` 대신 로컬 경로나 공개 git 주소를 준다.

AI 도구는 `node bin/axmap.mjs setup`으로 연결한다. 작업 전 선점과 검증 기준은 [CLAUDE.md](../CLAUDE.md)를 따른다. Git Bash가 있으면 Windows에서도 bash 데모를 실행할 수 있다.

제품 결정은 [DECISIONS.md](DECISIONS.md), 열린 작업은 [THREADS.md](THREADS.md), 프로토콜은 [SPEC.md](SPEC.md), 코퍼스 근거는 [WHY-CORPUS.md](WHY-CORPUS.md)를 참고한다.
