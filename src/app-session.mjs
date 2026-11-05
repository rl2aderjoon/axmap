// Generated from src/app-session.mts. Edit the .mts source and run npm run build.
/** 앱 세션(Claude 데스크톱 앱의 Code 탭, Codex 앱, axMap 래퍼 없는 codex TUI)의 대화 모드.
 *
 * 이 세션들에는 axMap 이 글자를 대신 입력할 콘솔 창이 없다. 그래서 공급자 자신의 훅만 쓴다.
 * - 훅이 올 때마다 대화 ID 로 세션을 등록한다(transport: 'hook').
 * - 대화 모드가 켜진 세션은 응답이 끝날 때(Stop) 상대의 요청이나 회신을 로컬에서 기다린다.
 *   오면 공식 계약 {"decision":"block","reason":...} 으로 같은 대화를 이어 가게 한다.
 * - 쉬고 있는 앱을 밖에서 깨울 방법은 없다. 기다림이 끝난 세션은 사용자가 다음에 말을 걸 때까지 쉰다.
 * 기다리는 동안 모델을 부르지 않고, 새 모델 프로세스를 띄우지 않는다(D26). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { withRepoLock } from './repolock.mjs';
import { bridgeHome, repoKey, readJSON, writeJSON } from './bridge.mjs';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** 공급자 훅 제한 시간(600초, 두 공급자 문서의 기본값)보다 짧게 둔다. 훅이 강제 종료되면
 * 이미 꺼낸 요청을 전달했는지 알 수 없게 되므로, 우리가 먼저 빈손으로 끝낸다. */
export const MAX_WAIT_SECONDS = 540;
/** Claude Code 는 사용자 입력 없이 Stop 훅으로 이어 가는 것을 기본 8회에서 끊는다
 * (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). 기본값을 그보다 크게 잡으면 끝이 우리 한도가 아니라 공급자 한도가 된다. */
const DEFAULT_MAX_TURNS = 8;
/** Claude 는 훅이 넣는 문자열을 1만 자에서 자른다. 머리말을 붙일 자리를 남긴다. */
const MAX_REPLY_CHARS = 8000;
const sessionsDir = () => path.join(bridgeHome(), 'sessions');
const requestsDir = () => path.join(bridgeHome(), 'requests');
const sessionPath = (id) => path.join(sessionsDir(), `${id}.json`);
const requestPath = (id) => path.join(requestsDir(), `${id}.json`);
/** dispatchRequest 가 같은 수신자에 쓰는 잠금과 같은 파일이다. 꺼내기와 넣기가 서로 엇갈리지 않는다. */
const queueLock = (id) => path.join(requestsDir(), `${id}.lock`);
export function appSessionId(provider, conversationId) {
    const hex = createHash('sha256').update(`${provider}-hook:${conversationId}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function claudeHome() { return process.env.AXMAP_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
/** 훅 입력은 공급자가 준 것이지만, 다른 대화의 기록 파일을 가리키지 않는지는 확인한다.
 * null 은 "등록하지 않을 대화"다. 오류가 아니므로 조용히 넘긴다. */
function hookIdentity(input, provider) {
    const conversationId = input.session_id;
    if (typeof conversationId !== 'string' || !UUID.test(conversationId))
        throw new Error('훅 입력에 대화 UUID(session_id)가 없습니다.');
    if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd))
        throw new Error('훅 입력에 작업 폴더(cwd)가 없습니다.');
    const log = input.transcript_path;
    if (provider === 'claude') {
        const relative = typeof log === 'string' ? path.relative(path.join(claudeHome(), 'projects'), path.resolve(log)) : '..';
        if (!log || relative.startsWith('..') || path.isAbsolute(relative) || path.basename(log) !== `${conversationId}.jsonl`) {
            throw new Error('Claude 훅의 대화 기록 경로가 이 대화의 것이 아닙니다.');
        }
        return { conversationId, transcript: path.resolve(log), cwd: input.cwd };
    }
    // Codex 앱은 메시지마다 제목 생성 같은 보조 대화를 띄우고, 이 대화는 기록 파일 없이(transcript_path null)
    // Stop·SessionEnd 도 없이 사라진다(2026-11-05 Codex 앱 실측). 등록하면 '작업 중' 세션으로 영영 남으므로,
    // 이 대화의 rollout 기록 파일이 있는 대화만 받는다. 파일 이름에 대화 ID 가 들어간다(rollout-<시각>-<ID>.jsonl).
    if (typeof log !== 'string' || !path.isAbsolute(log))
        return null;
    const name = path.basename(log);
    if (!name.endsWith(`${conversationId}.jsonl`))
        throw new Error('Codex 훅의 대화 기록 경로가 이 대화의 것이 아닙니다.');
    return { conversationId, transcript: path.resolve(log), cwd: input.cwd };
}
/** Codex 는 사용자가 중단한 차례에 Stop 훅을 부르지 않는다. 기록 파일 끝에 turn_aborted 가
 * 마지막 차례 이벤트로 남아 있으면 그 차례는 끝난 것이다. 못 읽으면 판정하지 않는다(null). */
export function codexTurnAborted(transcript) {
    if (!transcript)
        return null;
    let fd;
    try {
        fd = fs.openSync(transcript, 'r');
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, 256 * 1024);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const lines = buffer.toString('utf8').split('\n').reverse();
        for (const line of lines) {
            if (!line.includes('"event_msg"'))
                continue;
            let type;
            try {
                type = JSON.parse(line)?.payload?.type;
            }
            catch {
                continue;
            }
            if (type === 'turn_aborted')
                return true;
            if (type === 'task_started' || type === 'task_complete')
                return false;
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== undefined)
            fs.closeSync(fd);
    }
}
/** 상태 표시용: 마지막 훅이 '작업 중'이라 적은 Codex 앱 세션이 실제로는 사용자 중단으로 끝났는지. */
export function appTurnAborted(id) {
    try {
        const s = readJSON(sessionPath(id));
        return s.transport === 'hook' && s.provider === 'codex' && s.state === 'running' && codexTurnAborted(s.transcript) === true;
    }
    catch {
        return false;
    }
}
/** 같은 대화가 작업 폴더를 옮기면 훅의 cwd 가 옛 폴더와 새 폴더 사이를 오간다(Claude 앱 실측).
 * 마지막 하나로 덮으면 방금까지 주고받던 저장소에서 사라지므로, 본 적 있는 곳을 최근 순으로 쌓는다. */
const MAX_PLACES = 8;
function remember(previous, value) {
    return [...(previous || []).filter(v => v !== value), value].slice(-MAX_PLACES);
}
function listRequests() {
    if (!fs.existsSync(requestsDir()))
        return [];
    return fs.readdirSync(requestsDir()).filter(n => /^[0-9a-f-]{36}\.json$/i.test(n))
        .flatMap(n => { try {
        return [readJSON(path.join(requestsDir(), n))];
    }
    catch {
        return [];
    } });
}
export function modeActive(mode, now = Date.now()) {
    return !!mode && Date.parse(mode.until) > now && mode.used < mode.maxTurns;
}
/** 이 저장소가 axMap 을 쓰는지. 안 쓰는 저장소의 대화에는 세션 ID 안내를 넣지 않는다(토큰 낭비). */
function usesAxmap(cwd) {
    const r = spawnSync('git', ['for-each-ref', '--count=1', '--format=x', 'refs/heads/axmap/claims', 'refs/remotes/*/axmap/claims'], { cwd, encoding: 'utf8', windowsHide: true });
    return r.status === 0 && r.stdout.trim() === 'x';
}
function announcement(id) {
    return `axMap: 이 대화의 세션 ID는 ${id} 입니다. 다른 AI 세션과 대화 모드로 주고받을 때 ` +
        `ax_dialogue_mode(session) 와 ax_dispatch(from_session) 에 이 값을 씁니다. 사용자가 요청하지 않으면 쓰지 않습니다.`;
}
/** 훅 하나를 처리하고 공급자에게 돌려줄 JSON 을 만든다. 오류는 호출한 쪽이 삼키고 {} 를 낸다 —
 * 훅 실패가 사용자의 대화를 막으면 안 된다. */
export function handleAppHook(input, event, provider, options = {}) {
    if (!['claude', 'codex'].includes(provider))
        return {};
    if (!['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'].includes(event))
        return {};
    const now = options.now || Date.now;
    const sleep = options.sleep || ((ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
    const who = hookIdentity(input, provider);
    if (!who)
        return {};
    const repo = repoKey(who.cwd);
    const id = appSessionId(provider, who.conversationId);
    fs.mkdirSync(requestsDir(), { recursive: true, mode: 0o700 });
    const update = (change) => withRepoLock(queueLock(id), () => {
        const previous = fs.existsSync(sessionPath(id)) ? readJSON(sessionPath(id)) : null;
        const base = { ...(previous || {}), id, provider: provider, transport: 'hook',
            conversationId: who.conversationId, ...(who.transcript ? { transcript: who.transcript } : {}),
            workspaces: remember(previous?.workspaces, path.resolve(who.cwd)), repos: remember(previous?.repos, repo), registeredAt: new Date(now()).toISOString(), event,
            ...(input.model && typeof input.model === 'string' ? { model: input.model } : {}) };
        const next = change(base);
        writeJSON(sessionPath(id), next);
        return { previous, next };
    });
    if (event === 'SessionEnd') {
        update(s => ({ ...s, state: 'closed', fullyIdle: false, dialogueMode: undefined }));
        failQueued(id, '받는 세션이 종료돼 전달하지 않았습니다.');
        return {};
    }
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
        const { previous } = update(s => ({ ...s, state: event === 'SessionStart' ? 'idle' : 'running', fullyIdle: event === 'SessionStart' }));
        if (event === 'UserPromptSubmit')
            supersedeInFlight(id, typeof input.prompt === 'string' ? input.prompt : '');
        if (previous?.announced || !usesAxmap(who.cwd))
            return {};
        update(s => ({ ...s, announced: true }));
        return { hookSpecificOutput: { hookEventName: event, additionalContext: announcement(id) } };
    }
    // Stop: 방금 끝난 차례가 우리가 넣은 요청이었으면 그 답을 결과로 적는다.
    const { next: session } = update(s => ({ ...s, state: 'idle', fullyIdle: true }));
    completeInFlight(id, input, who.transcript);
    if (!modeActive(session.dialogueMode, now()))
        return {};
    const waitMs = Math.min(session.dialogueMode.waitSeconds, MAX_WAIT_SECONDS) * 1000;
    const deadline = Math.min(now() + waitMs, Date.parse(session.dialogueMode.until));
    for (;;) {
        const delivery = takeNext(id, now);
        if (delivery)
            return { decision: 'block', reason: delivery };
        if (now() >= deadline)
            return {};
        sleep(Math.max(0, Math.min(500, deadline - now())));
    }
}
function failQueued(id, reason) {
    withRepoLock(queueLock(id), () => {
        for (const r of listRequests().filter(r => r.to === id && r.state === 'queued')) {
            writeJSON(requestPath(r.id), { ...r, state: 'failed', error: reason });
        }
    });
}
/** 우리가 넣은 요청을 처리하던 중에 사람이 다른 말을 넣었다면, 다음 답은 그 요청의 답이 아니다. */
function supersedeInFlight(id, prompt) {
    withRepoLock(queueLock(id), () => {
        for (const r of listRequests().filter(r => r.to === id && r.state === 'submitted')) {
            // Codex 는 이어 가기 문구를 새 프롬프트로 만들 수 있다. 그 문구에는 우리 표식이 있다.
            if (prompt.includes(`[axMap request ${r.id}]`))
                continue;
            writeJSON(requestPath(r.id), { ...r, state: 'superseded', error: '사용자 입력이 끼어들어 이 요청의 답을 확정할 수 없습니다.' });
        }
    });
}
function lastClaudeAnswer(transcript) {
    if (!transcript || !fs.existsSync(transcript))
        return undefined;
    const lines = fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        }
        catch {
            continue;
        }
        if (entry.type === 'user')
            return undefined;
        if (entry.type !== 'assistant')
            continue;
        const content = entry.message?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content)
            ? content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n') : '';
        if (text.trim())
            return text;
    }
    return undefined;
}
function completeInFlight(id, input, transcript) {
    withRepoLock(queueLock(id), () => {
        for (const r of listRequests().filter(r => r.to === id && r.state === 'submitted')) {
            const answer = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : lastClaudeAnswer(transcript);
            writeJSON(requestPath(r.id), typeof answer === 'string'
                ? { ...r, state: 'completed', result: answer, completedAt: new Date().toISOString() }
                // 답을 못 읽은 것과 답이 없는 것은 다르다. 완료로 치지 않는다.
                : { ...r, state: 'unknown', error: '응답이 끝났지만 마지막 답을 읽지 못했습니다.' });
        }
    });
}
/** 다음에 이어 갈 내용 하나를 꺼낸다: 내게 온 요청(먼저 온 순서), 없으면 내가 보낸 요청의 회신. */
function takeNext(id, now) {
    return withRepoLock(queueLock(id), () => {
        const s = readJSON(sessionPath(id));
        if (!modeActive(s.dialogueMode, now()))
            return null;
        const all = listRequests().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const remaining = s.dialogueMode.maxTurns - s.dialogueMode.used - 1;
        const request = all.find(r => r.to === id && r.state === 'queued');
        const reply = request ? undefined : all.find(r => r.fromSession === id && !r.returnedAt &&
            ['completed', 'failed', 'superseded', 'unknown'].includes(r.state));
        if (!request && !reply)
            return null;
        let text;
        if (request) {
            writeJSON(requestPath(request.id), { ...request, state: 'submitted', deliveredAt: new Date(now()).toISOString() });
            text = `[axMap request ${request.id}]\n요청자: ${request.fromSession ? `세션 ${request.fromSession}` : request.from}\n${request.prompt}\n\n` +
                `— axMap 대화 모드: 이 요청에 대한 마지막 답변이 그대로 요청자에게 전달됩니다.` +
                (request.fromSession ? ` 답과 별개로 상대에게 새로 맡길 일이 있을 때만 ax_dispatch(to="${request.fromSession}", from_session="${id}")를 쓰세요.` : '') +
                ` 남은 자동 이어 가기 ${remaining}회.`;
        }
        else {
            const r = reply;
            writeJSON(requestPath(r.id), { ...r, returnedAt: new Date(now()).toISOString() });
            const body = typeof r.result === 'string' ? r.result : '';
            const clipped = body.length > MAX_REPLY_CHARS ? `${body.slice(0, MAX_REPLY_CHARS)}\n…(잘림. 전체는 ax_result(id="${r.id}"))` : body;
            text = `[axMap reply ${r.id}]\n세션 ${r.to}에 보낸 요청이 ${r.state === 'completed' ? '끝났습니다. 답:' : `완료되지 않았습니다(${r.state}): ${r.error || ''}`}\n${clipped}\n\n` +
                `— axMap 대화 모드: 이어서 맡길 일이 있으면 ax_dispatch(to="${r.to}", from_session="${id}")로 보내고, 작업이 끝났으면 보내지 마세요. 남은 자동 이어 가기 ${remaining}회.`;
        }
        writeJSON(sessionPath(id), { ...s, state: 'running', fullyIdle: false,
            dialogueMode: { ...s.dialogueMode, used: s.dialogueMode.used + 1 } });
        return text;
    });
}
/** 앱 세션으로 가는 요청은 언제나 대기열에 넣는다. 꺼내는 것은 받는 쪽의 Stop 훅뿐이다. */
export function enqueueAppRequest(s, request) {
    if (s.state === 'closed')
        throw new Error('받는 앱 세션이 종료됐습니다.');
    if (!modeActive(s.dialogueMode))
        throw new Error('받는 앱 세션의 대화 모드가 꺼져 있습니다. 그 세션에서 ax_dialogue_mode 로 켠 뒤 보내세요.');
    return withRepoLock(queueLock(s.id), () => {
        if (listRequests().filter(r => r.to === s.id && r.state === 'queued').length >= 100)
            throw new Error('받는 앱 세션의 대기열이 가득 찼습니다.');
        const record = { ...request, id: randomUUID(), createdAt: new Date().toISOString(), baseline: null, state: 'queued' };
        writeJSON(requestPath(record.id), record);
        return record;
    });
}
export function setDialogueMode({ session, cwd, on, minutes = 30, maxTurns = DEFAULT_MAX_TURNS, waitSeconds = MAX_WAIT_SECONDS }) {
    if (!UUID.test(session || ''))
        throw new Error('세션 ID는 UUID여야 합니다.');
    for (const [name, value, max] of [['minutes', minutes, 240], ['maxTurns', maxTurns, 50], ['waitSeconds', waitSeconds, MAX_WAIT_SECONDS]]) {
        if (!Number.isSafeInteger(value) || value < 1 || value > max)
            throw new Error(`${name} 는 1~${max} 정수여야 합니다.`);
    }
    if (!fs.existsSync(sessionPath(session)))
        throw new Error('등록되지 않은 세션입니다.');
    const repo = repoKey(cwd);
    const result = withRepoLock(queueLock(session), () => {
        const s = readJSON(sessionPath(session));
        if (!s.repos.includes(repo))
            throw new Error('이 세션은 현재 작업 저장소에 등록되지 않았습니다.');
        if (s.transport !== 'hook')
            throw new Error('대화 모드는 앱 세션(transport: hook)에만 있습니다. 터미널·관리형 세션은 이미 바로 받습니다.');
        if (on && s.state === 'closed')
            throw new Error('종료된 세션입니다.');
        const dialogueMode = on
            ? { until: new Date(Date.now() + minutes * 60000).toISOString(), maxTurns, used: 0, waitSeconds } : undefined;
        writeJSON(sessionPath(session), { ...s, dialogueMode });
        return { session, on, ...(dialogueMode ? { dialogueMode } : {}) };
    });
    if (!on)
        failQueued(session, '받는 세션의 대화 모드가 꺼져 전달하지 않았습니다.');
    return { ...result, note: on
            ? '이 세션은 응답이 끝날 때마다 최대 ' + waitSeconds + '초 동안 상대의 요청·회신을 기다렸다가 같은 대화에서 이어 갑니다. 기다리는 동안 앱은 작업 중으로 보입니다.'
            : '대화 모드를 껐습니다. 아직 전달하지 않은 요청은 failed 로 적었습니다.' };
}
