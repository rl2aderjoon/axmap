// Generated from src/monitor.mts. Edit the .mts source and run npm run build.
/** Local observation only: no model submission, Git fetch, ledger bootstrap or approval. */
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHome, repoKey, requestResult } from './bridge.mjs';
import { sessionStatus } from './session-status.mjs';
import { errorCode, errorMessage } from './session-types.mjs';
const uuidFile = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/i;
const pending = new Set(['sending', 'submitted', 'unknown']);
const requestLabels = { sending: '전달 중', submitted: '응답 대기', completed: '완료', failed: '실패', unknown: '전송 확인 필요', superseded: '다른 입력으로 대체됨' };
const sessionLabels = { starting: '시작 중', running: '작업 중', idle: '대기', awaiting_user: '사용자 승인 필요', settling: '대기 전환 중', closed: '종료', unknown: '상태 미확인' };
const dialogueLabels = { queued: '접수', running: '중계 중', stopping: '중단 대기', completed: '완료', failed: '실패', cancelled: '중단', token_limit: '토큰 한도', unknown: '확인 필요', usage_unavailable: '사용량 미확인', message_limit: '메시지 한도', invalid_response: '응답 형식 확인 필요', turn_limit: '횟수 한도' };
function records(directory, issues, label, uuidOnly = true) {
    try {
        const files = fs.readdirSync(directory).filter(name => uuidOnly ? uuidFile.test(name) : name.endsWith('.json'))
            .map(name => ({ name, stat: fs.statSync(path.join(directory, name)) }))
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        if (files.length > 500)
            issues.push(`${label}: 최근 500개 기록만 표시합니다.`);
        const result = [];
        for (const { name, stat } of files.slice(0, 500)) {
            if (stat.size > 1024 * 1024) {
                issues.push(`${label}: 큰 기록을 건너뛰었습니다 (${name}).`);
                continue;
            }
            try {
                result.push(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
            }
            catch {
                issues.push(`${label}: 읽을 수 없는 기록 (${name}).`);
            }
        }
        return result;
    }
    catch (e) {
        if (errorCode(e) !== 'ENOENT')
            issues.push(`${label}: ${errorMessage(e)}`);
        return [];
    }
}
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v) => typeof v === 'string' ? Date.parse(v) || 0 : 0;
export function createMonitor(cwd, options = {}) {
    const workspace = path.resolve(cwd), repo = repoKey(workspace);
    const probe = options.probe || sessionStatus, resolve = options.resolve || requestResult, now = options.now || Date.now;
    const observed = new Map(), events = new Map();
    const event = (id, at, label, tone = 'info') => events.set(id, { id, at, label, tone });
    return async () => {
        const checkedAt = new Date(now()).toISOString(), issues = [];
        let sessions = [];
        try {
            sessions = await probe(workspace);
        }
        catch (e) {
            issues.push(`세션 확인: ${errorMessage(e)}`);
        }
        const requests = [];
        for (const raw of records(path.join(bridgeHome(), 'requests'), issues, '요청')) {
            if (!object(raw) || raw.repo !== repo)
                continue;
            if (typeof raw.id !== 'string' || typeof raw.to !== 'string' || typeof raw.prompt !== 'string' || typeof raw.from !== 'string' || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || typeof raw.state !== 'string' || !requestLabels[raw.state]) {
                issues.push('형식이 올바르지 않은 요청 기록이 있습니다.');
                continue;
            }
            requests.push(raw);
        }
        requests.sort((a, b) => time(b.createdAt) - time(a.createdAt));
        // Refresh at most one pending request per session, never submit or retry it.
        const refreshed = new Set();
        for (let index = 0; index < requests.length && refreshed.size < 4; index++) {
            const request = requests[index];
            if (!['submitted', 'unknown'].includes(request.state) || refreshed.has(request.to))
                continue;
            refreshed.add(request.to);
            try {
                requests[index] = resolve(request.id, workspace);
            }
            catch (e) {
                issues.push(`요청 ${request.id.slice(0, 8)}: ${errorMessage(e)}`);
            }
        }
        for (const request of requests) {
            const key = `request:${request.id}`, previous = observed.get(key);
            event(`${key}:created`, request.createdAt, `요청 접수 · ${request.from} → ${request.to.slice(0, 8)}`);
            if (request.completedAt)
                event(`${key}:completed`, request.completedAt, `완료 확인 · ${request.to.slice(0, 8)}`, 'success');
            if (previous !== undefined && previous !== request.state && !(request.state === 'completed' && request.completedAt))
                event(`${key}:${request.state}`, checkedAt, `${requestLabels[request.state]} · ${request.to.slice(0, 8)}`, request.state === 'completed' ? 'success' : request.state === 'submitted' ? 'info' : 'warning');
            observed.set(key, request.state);
        }
        for (const session of sessions) {
            const key = `session:${session.id}`, value = `${session.connection}:${session.state}`, previous = observed.get(key);
            if (previous !== undefined && previous !== value)
                event(`${key}:${value}`, checkedAt, `${session.provider} ${session.id.slice(0, 8)} · ${sessionLabels[session.state]}`, session.state === 'awaiting_user' || session.connection === 'unreachable' ? 'warning' : 'info');
            observed.set(key, value);
        }
        const dialogues = [];
        for (const raw of records(path.join(bridgeHome(), 'dialogues'), issues, '대화')) {
            if (!object(raw) || raw.repo !== repo)
                continue;
            if (typeof raw.id !== 'string' || typeof raw.state !== 'string' || !dialogueLabels[raw.state] || !Array.isArray(raw.turns)) {
                issues.push('형식이 올바르지 않은 대화 기록이 있습니다.');
                continue;
            }
            dialogues.push(raw);
        }
        dialogues.sort((a, b) => time(b.createdAt) - time(a.createdAt));
        const claims = [];
        const ledger = path.join(path.dirname(repo), '.axmap', 'ledger', 'claims');
        for (const raw of records(ledger, issues, '선점', false)) {
            if (!object(raw) || typeof raw.agent !== 'string' || !Array.isArray(raw.paths) || !raw.paths.every(p => typeof p === 'string') || typeof raw.since !== 'string' || typeof raw.ttlMs !== 'number') {
                issues.push('형식이 올바르지 않은 선점 기록이 있습니다.');
                continue;
            }
            const expiresAt = time(raw.since) + raw.ttlMs;
            if (!Number.isFinite(expiresAt) || expiresAt <= now())
                continue;
            claims.push({ agent: raw.agent, paths: raw.paths, expiresAt,
                session: typeof raw.session === 'string' ? raw.session : null, task: typeof raw.task === 'string' ? raw.task : null, intent: typeof raw.intent === 'string' ? raw.intent : null });
        }
        const recent = [...events.values()].sort((a, b) => time(b.at) - time(a.at)).slice(0, 40);
        events.clear();
        for (const entry of recent)
            events.set(entry.id, entry);
        return { cwd: workspace, repo, checkedAt, sessions, requests: requests.slice(0, 50), dialogues: dialogues.slice(0, 20), claims, events: recent, issues };
    };
}
/** Strip untrusted terminal controls, including OSC, CSI and bidi overrides. */
export function terminalText(value) {
    return String(value ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function cellWidth(text) {
    if (/\p{Extended_Pictographic}/u.test(text))
        return 2;
    const cp = text.codePointAt(0) || 0;
    if (/^\p{Mark}+$/u.test(text))
        return 0;
    return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
        cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff ||
        cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000) ? 2 : 1;
}
export function fitTerminal(value, width) {
    const text = terminalText(value), parts = [...segmenter.segment(text)].map(s => s.segment);
    if (parts.reduce((n, c) => n + cellWidth(c), 0) <= width)
        return text;
    let out = '', used = 0;
    for (const part of parts) {
        const next = cellWidth(part);
        if (used + next > width - 1)
            break;
        out += part;
        used += next;
    }
    return width > 0 ? out + '…' : '';
}
const elapsed = (start, end) => {
    const seconds = Math.max(0, Math.floor((end - time(start)) / 1000));
    return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
};
const clock = (value) => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function renderMonitor(snapshot, { columns = 100, rows = 36, color = false, now = Date.now(), frame = 0 } = {}) {
    const width = Math.max(1, Math.floor(columns)), height = Math.max(1, Math.floor(rows)), lines = [];
    const paint = (text, tone = 'info') => color ? `\x1b[${{ info: 36, success: 32, warning: 33, muted: 90 }[tone]}m${text}\x1b[0m` : text;
    const add = (text, tone) => {
        const indent = Math.min(text.length - text.trimStart().length, 4, width);
        lines.push(paint(' '.repeat(indent) + fitTerminal(text, width - indent), tone));
    };
    const heading = (text) => add(`── ${text} ${'─'.repeat(Math.max(0, width - 4 - [...text].reduce((n, c) => n + cellWidth(c), 0)))}`, 'muted');
    const active = snapshot.requests.filter(r => pending.has(r.state)), attention = snapshot.sessions.filter(s => s.state === 'awaiting_user').length;
    add(`axMap  LIVE  · 진행 확인 ${active.length}개${attention ? `  · 승인 대기 ${attention}` : ''}`, attention ? 'warning' : 'info');
    add(snapshot.cwd, 'muted');
    add(`관측 ${clock(snapshot.checkedAt)} · 확인된 정보만 표시 · 모델 호출 없음`, 'muted');
    if (width < 56 || height < 16) {
        add('터미널을 넓히면 파이프라인과 최근 이벤트가 표시됩니다.', 'muted');
        for (const s of snapshot.sessions.slice(0, Math.max(0, height - 7)))
            add(`${s.provider} ${s.id.slice(0, 8)} · ${sessionLabels[s.state]}`);
        for (const r of active.slice(0, 2))
            add(`${r.id.slice(0, 8)} · ${requestLabels[r.state]}`, 'warning');
    }
    else {
        heading('에이전트');
        if (!snapshot.sessions.length)
            add('연결된 세션 기록이 없습니다. axmap bridge attach / serve로 연결하세요.', 'muted');
        for (const session of snapshot.sessions.slice(0, Math.min(5, Math.max(1, Math.floor((height - 14) / 5))))) {
            const state = sessionLabels[session.state], connection = { connected: '연결됨', closed: '종료됨', unreachable: '연결 확인 불가', unverified: '확인 미지원' }[session.connection];
            const usage = session.usage?.totalTokens == null ? '토큰 미측정' : `처리 ${session.usage.totalTokens.toLocaleString()} 토큰`;
            add(`${session.state === 'idle' ? '○' : session.state === 'running' ? '●' : '◇'} ${session.provider.toUpperCase()}  ${session.id.slice(0, 8)}  ${state} · ${connection} · ${usage}`, session.state === 'awaiting_user' || session.connection === 'unreachable' ? 'warning' : 'info');
            if (session.role)
                add(`  역할  ${session.role}`, 'muted');
            if (session.pendingApproval) {
                const detail = session.pendingApproval.command || session.pendingApproval.commandLine || session.pendingApproval.reason;
                if (typeof detail === 'string')
                    add(`  승인 요청  ${detail}`, 'warning');
            }
        }
        heading('요청 파이프라인');
        const selected = [...active, ...snapshot.requests.filter(r => !pending.has(r.state))].slice(0, height >= 32 ? 3 : 1);
        if (!selected.length) {
            add('새 요청을 기다리는 중', 'muted');
            add('별도 터미널이나 AI에서 요청을 보내면 여기에 흐름이 나타납니다.', 'muted');
        }
        for (const request of selected) {
            const session = snapshot.sessions.find(s => s.id === request.to);
            const target = `${session?.provider || '세션'} ${request.to.slice(0, 8)}`;
            const tone = request.state === 'completed' ? 'success' : ['unknown', 'failed', 'superseded'].includes(request.state) ? 'warning' : 'info';
            add(`${request.from}  →  ${target}  · ${requestLabels[request.state]} · ${elapsed(request.createdAt, request.completedAt ? time(request.completedAt) : now)}`, tone);
            const spin = ['◐', '◓', '◑', '◒'][frame % 4];
            const stages = request.state === 'completed' ? '● 접수 ── ● 전달 ── ● 응답 ── ● 완료 확인' :
                request.state === 'submitted' ? `● 접수 ── ● 전달 ── ${spin} 응답 대기 ── ○ 완료 확인` :
                    request.state === 'sending' ? `● 접수 ── ${spin} 전달 중 ── ○ 응답 ── ○ 완료 확인` :
                        request.state === 'unknown' ? '● 접수 ── ? 전달 확인 필요 ── ○ 완료 미확정' : '● 접수 ── ! 진행 중단 ── ○ 완료 미확정';
            add(`  ${stages}`, tone);
            add(`  작업  ${request.prompt}`, 'muted');
            if (request.error)
                add(`  사유  ${request.error}`, 'warning');
        }
        const dialogue = snapshot.dialogues.find(d => ['queued', 'running', 'stopping'].includes(d.state));
        if (dialogue) {
            const used = dialogue.usage?.totalTokens ?? dialogue.knownUsage?.totalTokens;
            add(`자동 대화  ${dialogueLabels[dialogue.state]} · ${dialogue.turns.length}/${dialogue.limits?.maxTurns ?? '?'}회 · 처리 ${used == null ? '미확인' : used.toLocaleString()} 토큰${dialogue.usagePending ? ' (측정 대기 포함)' : ''}`);
        }
        if (snapshot.claims.length && lines.length < height - 6) {
            heading('작업 선점');
            for (const claim of snapshot.claims.slice(0, 2))
                add(`${claim.agent} · ${claim.intent || claim.task || '작업 중'} · ${claim.paths.slice(0, 2).join(', ')}${claim.paths.length > 2 ? ` 외 ${claim.paths.length - 2}개` : ''}`, 'muted');
        }
        if (lines.length < height - 4) {
            heading('최근 이벤트');
            if (!snapshot.events.length)
                add('관측된 이벤트가 없습니다.', 'muted');
            for (const event of snapshot.events.slice(0, Math.min(5, height - lines.length - 3)))
                add(`${clock(event.at)}  ${event.label}`, event.tone);
        }
    }
    const warnings = snapshot.issues.slice(0, Math.min(2, height - 1)).map(issue => paint(fitTerminal(`! ${issue}`, width), 'warning'));
    const footer = paint(fitTerminal('q / Esc 종료 · 모니터를 닫아도 진행 중인 작업은 계속됩니다.', width), 'muted');
    return [...lines.slice(0, height - 1 - warnings.length), ...warnings, footer].join('\n');
}
