# axMap 소스 개발

```bash
git clone https://github.com/rl2aderjoon/axmap.git
cd axmap
npm install
node bin/axmap.mjs --version
npm test
```

Node 20+와 Git이 필요하다. 기본 브랜치는 `main`이다.
터미널 연결 의존성은 npm 설치에 포함되며, 선점 CLI는 소스에서 직접 실행할 수 있다.
PATH의 `axmap`은 설치본일 수 있으므로 소스 검증에는 `node bin/axmap.mjs`를 쓴다.

## 구성

| 경로 | 역할 |
|---|---|
| `bin/` | CLI 진입점과 Git 장부·커밋 훅 |
| `src/` | 선점 판정, 신원·설정, 로컬 세션 연결 |
| `mcp/` | AI 도구 연결과 설치기 |
| `tools/` | 설정, 쪽지, 버전과 배포 보조 명령 |
| `governance/` | 표 기록과 병합 게이트 |
| `test/`, `demo/` | 회귀 검증과 실제 Git 경합 재현 |

작업 전 선점과 검증 기준은 [CLAUDE.md](../CLAUDE.md)를 따른다.
Git Bash가 있으면 Windows에서도 bash 데모를 실행할 수 있다.
설치한 도구를 AI CLI에 연결할 때는 `node bin/axmap.mjs setup`을 사용한다.

[제품 결정](DECISIONS.md) · [진행 중인 작업](THREADS.md) · [프로토콜](SPEC.md) · [세션 연결 상태](SESSION-BRIDGE.md)
