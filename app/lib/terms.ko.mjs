/**
 * 한국어 도메인 용어 → 영어 후보.
 *
 * 왜 필요한가. 커밋 메시지가 한국어인 저장소에서는 한국어 질의가 **그대로 된다**
 * (e101 은 커밋 217개 중 213개가 한국어다). 다리가 필요한 경우는 하나뿐이다 —
 * **커밋이 영어인 저장소에 한국어로 물을 때.**
 *
 * 왜 LLM 이 아닌가. 세 가지다.
 *   1. D1 의 두 번째 사용자가 "좋은 AI 를 쓸 수 없는 환경(폐쇄망)" 이다.
 *      번역이 LLM 에만 있으면 그 사용자에게는 기능이 아예 없다.
 *   2. 같은 질의가 같은 답을 줘야 한다. `axmap audit` 으로 재생 가능해야 한다.
 *   3. 이건 판정이 아니라 **질의 확장**이다. 상류에서 후보를 넓히고
 *      판정은 결정론적 매칭이 한다 — D4 가 정한 자리 그대로다.
 *
 * 🔴 이 사전은 완전하지 않고 완전해질 수도 없다.
 *    그래서 화면에 **어떤 말을 어떤 말로 바꿨는지 반드시 보여준다.**
 *    번역이 틀렸으면 사용자가 영어로 직접 치면 된다.
 *    조용히 바꾸고 결과만 내놓는 것이 최악이다.
 *
 * 값은 배열이고 OR 로 쓰인다. 한 단어가 여러 영어에 걸치는 것이 정상이다 —
 * "사진" 은 코드에서 photo 일 수도 image 일 수도 asset 일 수도 있다.
 */

export const KO_TERMS = {
  // ── 동작 ────────────────────────────────────────────────────────────────
  업로드: ['upload'],
  다운로드: ['download'],
  삭제: ['delete', 'remove', 'destroy'],
  제거: ['remove', 'delete'],
  생성: ['create', 'add', 'new'],
  추가: ['add', 'create'],
  수정: ['update', 'edit', 'modify'],
  편집: ['edit', 'update'],
  조회: ['get', 'fetch', 'read', 'query'],
  검색: ['search', 'query', 'find'],
  정렬: ['sort', 'order'],
  필터: ['filter'],
  복원: ['restore', 'recover'],
  공유: ['share', 'shared'],
  전송: ['send', 'transfer', 'upload'],
  동기화: ['sync', 'synchronize'],
  백업: ['backup'],
  복사: ['copy', 'duplicate'],
  이동: ['move'],
  변환: ['convert', 'transform', 'transcode'],
  압축: ['compress', 'zip', 'archive'],
  재생: ['play', 'playback', 'stream'],
  미리보기: ['preview', 'thumbnail'],
  썸네일: ['thumbnail', 'thumb'],
  가져오기: ['import'],
  내보내기: ['export'],

  // ── 대상 ────────────────────────────────────────────────────────────────
  사진: ['photo', 'image', 'asset', 'picture'],
  이미지: ['image', 'photo', 'asset'],
  영상: ['video', 'media', 'stream'],
  동영상: ['video', 'media'],
  미디어: ['media'],
  파일: ['file', 'asset'],
  앨범: ['album'],
  폴더: ['folder', 'directory'],
  자산: ['asset'],
  사용자: ['user', 'account'],
  계정: ['account', 'user'],
  회원: ['user', 'member', 'account'],
  관리자: ['admin', 'administrator'],
  권한: ['permission', 'access', 'role', 'auth'],
  역할: ['role'],
  태그: ['tag', 'label'],
  댓글: ['comment', 'activity'],
  좋아요: ['like', 'reaction', 'activity'],
  알림: ['notification', 'notify'],
  설정: ['setting', 'config', 'preference'],
  환경설정: ['config', 'setting', 'preference'],
  로그: ['log', 'logging'],
  작업: ['job', 'task', 'work'],
  큐: ['queue', 'job'],
  일정: ['schedule', 'cron'],
  휴지통: ['trash', 'bin', 'recycle'],
  즐겨찾기: ['favorite', 'bookmark'],
  타임라인: ['timeline'],
  지도: ['map', 'location', 'geo'],
  위치: ['location', 'geo', 'position'],
  얼굴: ['face', 'person'],
  인물: ['person', 'people', 'face'],
  중복: ['duplicate', 'dedupe'],
  묶음: ['stack', 'group', 'bundle'],
  메타데이터: ['metadata', 'exif'],

  // ── 인증 ────────────────────────────────────────────────────────────────
  로그인: ['login', 'signin', 'auth'],
  로그아웃: ['logout', 'signout'],
  인증: ['auth', 'authentication', 'login'],
  인가: ['authorization', 'permission', 'access'],
  비밀번호: ['password', 'passwd'],
  토큰: ['token', 'jwt'],
  세션: ['session'],
  회원가입: ['signup', 'register', 'registration'],
  가입: ['signup', 'register'],

  // ── 시스템 ──────────────────────────────────────────────────────────────
  서버: ['server'],
  클라이언트: ['client'],
  데이터베이스: ['database', 'db', 'schema'],
  스키마: ['schema', 'migration'],
  마이그레이션: ['migration', 'migrate'],
  캐시: ['cache'],
  저장소: ['repository', 'storage'],
  미들웨어: ['middleware', 'interceptor'],
  에러: ['error', 'exception', 'fail'],
  오류: ['error', 'exception', 'bug', 'fix'],
  예외: ['exception', 'error'],
  버그: ['bug', 'fix'],
  테스트: ['test', 'spec'],
  배포: ['deploy', 'release'],
  빌드: ['build'],
  성능: ['performance', 'perf', 'optimize'],
  최적화: ['optimize', 'performance', 'perf'],
  보안: ['security', 'secure'],

  // ── 그 밖 ───────────────────────────────────────────────────────────────
  결제: ['payment', 'pay', 'billing'],
  주문: ['order'],
  장바구니: ['cart', 'basket'],
  리뷰: ['review'],
  채팅: ['chat', 'message'],
  메시지: ['message', 'chat'],
  통계: ['statistic', 'stats', 'analytics'],
  추천: ['recommend', 'suggestion'],
  구독: ['subscribe', 'subscription'],
  결합: ['coupling'],
  주행: ['drive', 'driving', 'navigation'],
  경로: ['path', 'route'],
  센서: ['sensor'],
  카메라: ['camera'],
}

const HANGUL = /[가-힣]/

/** 이 토큰이 한국어를 담고 있나. */
export const isKorean = (s) => HANGUL.test(s)

/**
 * 한 토큰을 검색어 후보 집합으로 넓힌다.
 *
 * 원어를 **항상 함께 남긴다.** 커밋이 한국어인 저장소에서는 원어가 정답이고,
 * 사전에 없는 말이어도 그대로 걸려야 하기 때문이다.
 *
 * @returns {{token:string, terms:string[], translated:boolean}}
 */
export function expandTerm(token) {
  const t = token.trim()
  if (!t) return { token: t, terms: [], translated: false }
  if (!isKorean(t)) return { token: t, terms: [t], translated: false }

  const hit = KO_TERMS[t]
  if (hit) return { token: t, terms: [t, ...hit], translated: true }

  // 조사·어미가 붙었을 수 있다. "업로드를", "사진의" 처럼.
  // 사전 키가 접두사로 들어맞으면 그것으로 본다 — 형태소 분석기를 넣지 않는
  // 이유는 의존성 0 이고, 이 정도로 실용적인 범위가 대부분 덮이기 때문이다.
  for (const k of Object.keys(KO_TERMS)) {
    if (t.length > k.length && t.startsWith(k)) {
      return { token: t, terms: [t, k, ...KO_TERMS[k]], translated: true }
    }
  }
  // 사전에 없다. 원어 그대로 쓴다 — 한국어 커밋 저장소에서는 이게 맞다.
  return { token: t, terms: [t], translated: false }
}
