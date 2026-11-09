// Generated from src/app-native.mts. Edit the .mts source and run npm run build.
/** 기존 앱의 로컬 수신 API만 연결한다. 모델 프로세스·대화 생성·권한 변경은 하지 않는다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { withRepoLock } from './repolock.mjs';
import { nativeRequestText, nativeReplyText } from './app-language.mjs';
import { pendingAppRequests } from './app-queue.mjs';
const home = () => path.join(process.env.AXMAP_STATE_DIR || path.join(os.homedir(), '.axmap'), 'bridge');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function recordFile(kind, id) {
    if (!uuid.test(id))
        throw new Error('로컬 기록 ID는 UUID여야 합니다.');
    return path.join(home(), kind, `${id}.json`);
}
function read(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
function write(p, value) {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const temp = `${p}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(temp, p);
    }
    finally {
        if (fs.existsSync(temp))
            fs.unlinkSync(temp);
    }
}
export function nativeRelayActive(s) {
    if (!s.nativeRelay)
        return false;
    try {
        const lease = read(recordFile('native-relays', s.nativeRelay.id));
        if (lease.pid !== s.nativeRelay.pid || !lease.sessions.includes(s.id) || lease.validUntil <= Date.now())
            return false;
        process.kill(lease.pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** Codex 앱이 자식에게 제공한 Named Pipe의 길이 헤더 + JSON-RPC 계약. */
export function codexAppRPC(pipe, method, params, timeoutMs = 10000) {
    if (!pipe || !(pipe.startsWith('\\\\.\\pipe\\') || path.isAbsolute(pipe)))
        throw new Error('앱이 제공한 로컬 파이프 경로가 필요합니다.');
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(pipe);
        let buffer = Buffer.alloc(0), sent = false, done = false;
        const finish = (error, result) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            socket.destroy();
            if (error)
                reject(Object.assign(error, { notDelivered: !sent }));
            else
                resolve(result);
        };
        const timer = setTimeout(() => finish(new Error('Codex 앱 응답을 확인하지 못했습니다. 자동 재전송하지 않습니다.')), timeoutMs);
        socket.on('error', () => finish(new Error('Codex 앱 파이프 연결 오류')));
        socket.on('close', () => finish(new Error('Codex 앱 파이프가 응답 전에 닫혔습니다.')));
        socket.once('connect', () => {
            const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
            const header = Buffer.alloc(4);
            header.writeUInt32LE(body.length);
            sent = true;
            socket.write(Buffer.concat([header, body]));
        });
        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 4)
                return;
            const length = buffer.readUInt32LE(0);
            if (length > 8 * 1024 * 1024)
                return finish(new Error('앱 응답이 로컬 프레임 크기를 초과했습니다.'));
            if (buffer.length < length + 4)
                return;
            try {
                const value = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
                if (value.id !== 1)
                    return finish(new Error('Codex 앱 응답 ID가 다릅니다.'));
                if (value.error)
                    return finish(new Error('Codex 앱이 요청을 거절했습니다.'));
                finish(undefined, value.result);
            }
            catch {
                finish(new Error('Codex 앱 응답을 해석하지 못했습니다.'));
            }
        });
    });
}
/** 수신 대화 UUID와 키의 프로세스 신원을 대조한다. 키 값은 로그·axMap 기록에 쓰지 않는다. */
export function claudePeer(conversationId, directory = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions')) {
    if (!uuid.test(conversationId))
        throw new Error('Claude 대화 UUID가 필요합니다.');
    const matches = fs.readdirSync(directory).filter(n => /^\d+\.json$/.test(n)).flatMap(n => {
        let r;
        try {
            r = read(path.join(directory, n));
        }
        catch {
            return [];
        }
        if (r.sessionId !== conversationId || !r.messagingSocketPath)
            return [];
        try {
            process.kill(r.pid, 0);
        }
        catch {
            return [];
        }
        if (!r.messagingSocketPath.startsWith('\\\\.\\pipe\\') && !path.isAbsolute(r.messagingSocketPath))
            return [];
        const canonical = r.messagingSocketPath.startsWith('\\\\.\\pipe\\') ? r.messagingSocketPath.toLowerCase() : r.messagingSocketPath;
        const digest = createHash('sha256').update(canonical).digest('hex');
        const keyPath = path.join(directory, `${r.pid}.${digest}.key`);
        if (fs.lstatSync(keyPath).isSymbolicLink())
            throw new Error('Claude 인증 키의 심볼릭 링크는 사용할 수 없습니다.');
        const key = read(keyPath);
        if ((key.procStartFt || key.procStart) !== r.procStart || (key.pidDomain && key.pidDomain !== r.pidDomain) || !/^[0-9a-f]{32}$/.test(key.peerToken))
            throw new Error('Claude 수신 파이프의 프로세스 신원이 다릅니다.');
        return [{ ...r, token: key.peerToken }];
    });
    if (matches.length !== 1)
        throw new Error('실행 중인 Claude 수신 대화를 하나로 확인하지 못했습니다.');
    return matches[0];
}
export async function sendClaude(conversationId, text, requestId, directory) {
    let peer;
    try {
        peer = claudePeer(conversationId, directory);
    }
    catch (e) {
        throw Object.assign(e, { notDelivered: true });
    }
    // 사용자 입력을 사칭하지 않으며 수신자의 inbound 정책을 그대로 적용한다.
    const frame = { msgV: 1, msg_id: requestId, type: 'user', session_id: conversationId,
        message: { role: 'user', content: text }, priority: 'next' };
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(peer.messagingSocketPath);
        let sent = false, done = false;
        const finish = (error) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            socket.destroy();
            if (error)
                reject(Object.assign(error, { notDelivered: !sent }));
            else
                resolve();
        };
        const timer = setTimeout(() => finish(new Error('Claude 파이프 전송을 확인하지 못했습니다.')), 10000);
        socket.on('error', () => finish(new Error('Claude 수신 파이프 연결 오류')));
        socket.once('connect', () => {
            sent = true;
            socket.end(JSON.stringify({ type: 'auth', token: peer.token }) + '\n' + JSON.stringify(frame) + '\n', () => finish());
        });
        socket.on('close', () => { if (!done)
            finish(new Error('Claude 수신 파이프가 닫혔습니다.')); });
    });
}
export async function startNativeRelay(options) {
    const ids = [...new Set([options.codex, options.claude, ...(options.additionalSessions || [])])];
    const load = (id) => read(recordFile('sessions', id));
    const targets = ids.map(load);
    for (const [i, s] of targets.entries()) {
        if (s.provider !== (i === 0 ? 'codex' : 'claude') || s.transport !== 'hook' || (s.state === 'closed' && !options.reconnect) || !s.repos.includes(options.repo))
            throw new Error('현재 저장소의 기존 앱 세션 두 개를 지정해야 합니다.');
        if (nativeRelayActive(s))
            throw new Error('이미 이 앱 대화에 네이티브 중계가 연결되어 있습니다.');
    }
    if (!options.pipe)
        throw new Error('Codex 앱 안에서 실행해야 합니다. 앱 파이프를 찾지 못했습니다.');
    const catalog = await codexAppRPC(options.pipe, 'tools/list', { threadStartKind: 'all' });
    const tool = catalog.tools?.find((t) => t.name === 'send_message_to_thread');
    if (!tool)
        throw new Error('Codex 앱이 기존 대화 메시지 도구를 제공하지 않습니다.');
    claudePeer(targets[1].conversationId);
    const id = options.relayId || randomUUID(), leaseFile = recordFile('native-relays', id);
    const refresh = () => write(leaseFile, { id, pid: process.pid, sessions: ids, validUntil: Date.now() + 15000 });
    refresh();
    for (const s of targets)
        write(recordFile('sessions', s.id), { ...load(s.id),
            ...(options.reconnect && s.state === 'closed' ? { state: 'idle', fullyIdle: true, event: 'native-reconnect' } : {}), nativeRelay: { id, pid: process.pid } });
    const requests = path.join(home(), 'requests');
    fs.mkdirSync(requests, { recursive: true });
    let stopped = false, scanning = false, pending = false;
    const send = async (to, text, request) => {
        const s = load(to);
        if (s.state === 'closed' || !s.repos.includes(options.repo))
            throw new Error('수신 대화가 종료되었거나 저장소가 바뀌었습니다.');
        if (s.provider === 'claude')
            return sendClaude(s.conversationId, text, request);
        const r = await codexAppRPC(options.pipe, 'tools/call', { namespace: tool.namespace, tool: tool.name,
            arguments: { threadId: s.conversationId, prompt: text }, callerSource: 'codex',
            threadId: targets[0].conversationId, callId: `axmap-${request}`, turnId: `axmap-${request}` });
        if (r.success !== true)
            throw new Error('Codex 앱의 메시지 도구가 전달을 확인하지 않았습니다.');
    };
    const change = (request, fn) => {
        const before = read(recordFile('requests', request));
        withRepoLock(path.join(requests, `${before.to}.lock`), () => write(recordFile('requests', request), fn(read(recordFile('requests', request)))));
    };
    // 훅과 같은 잠금으로 idle을 선점한다. 읽은 상태가 오래됐거나 사람이 먼저 입력하면 전달하지 않는다.
    const reserveIdle = (to, action) => withRepoLock(path.join(requests, `${to}.lock`), () => {
        const s = load(to);
        if (s.state !== 'idle' || s.fullyIdle !== true || s.pendingApproval)
            return false;
        if (!action())
            return false;
        write(recordFile('sessions', to), { ...s, state: 'running', fullyIdle: false, event: 'native-queue-delivery' });
        return true;
    });
    const releaseUnsent = (to) => withRepoLock(path.join(requests, `${to}.lock`), () => {
        const s = load(to);
        if (s.event === 'native-queue-delivery')
            write(recordFile('sessions', to), { ...s, state: 'idle', fullyIdle: true });
    });
    const notifyMailbox = async (to) => {
        const mailbox = recordFile('mailboxes', to);
        if (!fs.existsSync(mailbox))
            return;
        const b = read(mailbox);
        const waiting = b.messages.filter(m => m.repo === options.repo && m.state === 'queued' && Date.parse(m.expiresAt) > Date.now()).map(m => m.id).sort();
        if (!waiting.length)
            return;
        const key = createHash('sha256').update(JSON.stringify(waiting)).digest('hex');
        const notice = path.join(home(), 'native-mail-notices', `${to}-${key}.json`);
        if (fs.existsSync(notice))
            return; // 전송 불명도 재전송하지 않는다. 편지함 원본은 보존한다.
        if (!reserveIdle(to, () => { write(notice, { to, ids: waiting, state: 'sending' }); return true; }))
            return;
        try {
            await send(to, `axMap 협업 편지함에 ${waiting.length}건이 대기 중입니다. 최신 사용자 작업이 우선입니다. 작업 경계에서 ax_mailbox(to="${to}", take=true, at="checkpoint")로 회수하고 필요한 결정만 처리하세요. 단순 알림에는 ACK하지 마세요. Computer Use는 사용하지 않습니다.`, randomUUID());
            write(notice, { to, ids: waiting, state: 'submitted' });
            options.onEvent?.({ event: 'mailbox-notified', to, count: waiting.length });
        }
        catch (e) {
            if (e.notDelivered) {
                fs.unlinkSync(notice);
                releaseUnsent(to);
            }
            else
                write(notice, { to, ids: waiting, state: 'unknown' });
        }
    };
    const notifyPendingRequests = async (to) => {
        const waiting = pendingAppRequests(to).filter(r => r.repo === options.repo && r.nativeRelayId === id);
        if (!waiting.length)
            return;
        const s = load(to);
        // 복구/작업 종료 경계마다 큐 위치만 알린다. 원래 작업을 자동 재실행하지 않는다.
        const key = createHash('sha256').update(JSON.stringify([waiting.map(r => r.id), s.registeredAt, s.event])).digest('hex');
        const notice = path.join(home(), 'native-request-notices', `${to}-${key}.json`);
        if (fs.existsSync(notice))
            return;
        if (!reserveIdle(to, () => { write(notice, { to, ids: waiting.map(r => r.id), state: 'sending' }); return true; }))
            return;
        try {
            await send(to, `axMap에 전달됐지만 명시적 회신이 없는 요청이 보존돼 있습니다: ${waiting.map(r => r.id).join(', ')}. 최신 사용자 작업이 우선입니다. 작업 경계에서 ax_result로 원문과 기존 실행 결과를 확인하고 이미 수행한 작업은 반복하지 마세요. 요청별로 ax_reply에 회신을 저장하세요. 도구가 없으면 axmap bridge reply --request <요청 UUID> --session ${to} --cwd <대상 저장소> 명령에 본문을 stdin으로 전달하세요. 일반 마지막 답변은 자동 전송되지 않습니다. Computer Use는 사용하지 않습니다.`, randomUUID());
            write(notice, { to, state: 'submitted' });
            options.onEvent?.({ event: 'pending-requests-notified', to, count: waiting.length });
        }
        catch (e) {
            if (e.notDelivered) {
                fs.unlinkSync(notice);
                releaseUnsent(to);
            }
            else
                write(notice, { to, state: 'unknown' });
        }
    };
    const scan = async () => {
        if (stopped)
            return;
        if (scanning) {
            pending = true;
            return;
        }
        scanning = true;
        try {
            do {
                pending = false;
                const ordered = fs.readdirSync(requests).filter(n => /^[0-9a-f-]{36}\.json$/i.test(n)).sort((a, b) => {
                    try {
                        return read(path.join(requests, a)).createdAt.localeCompare(read(path.join(requests, b)).createdAt);
                    }
                    catch {
                        return a.localeCompare(b);
                    }
                });
                for (const name of ordered) {
                    let r;
                    try {
                        r = read(path.join(requests, name));
                    }
                    catch {
                        continue;
                    }
                    if (r.repo !== options.repo || !ids.includes(r.to) || r.nativeRelayId !== id)
                        continue;
                    if (r.state === 'queued') {
                        // 미회신 요청은 보존하되, 다른 요청의 FIFO 전달을 막지 않는다.
                        const inFlight = fs.readdirSync(requests).filter(n => /^[0-9a-f-]{36}\.json$/i.test(n)).some(n => {
                            try {
                                const p = read(path.join(requests, n));
                                return p.to === r.to && p.id !== r.id && ['sending', 'unknown'].includes(p.state);
                            }
                            catch {
                                return true;
                            }
                        });
                        if (inFlight)
                            continue;
                        const claimed = reserveIdle(r.to, () => {
                            const latest = read(recordFile('requests', r.id));
                            if (latest.state !== 'queued')
                                return false;
                            write(recordFile('requests', r.id), { ...latest, state: 'sending', replyMode: 'explicit' });
                            return true;
                        });
                        if (!claimed)
                            continue;
                        const start = performance.now();
                        try {
                            await send(r.to, nativeRequestText(r), r.id);
                            change(r.id, latest => latest.state === 'sending' ? { ...latest, state: 'submitted', deliveredAt: new Date().toISOString() } : latest);
                            options.onEvent?.({ event: 'submitted', request: r.id, localSubmitMs: performance.now() - start });
                        }
                        catch (e) {
                            const unsent = e.notDelivered;
                            change(r.id, latest => latest.state !== 'sending' ? latest : { ...latest,
                                state: unsent ? 'queued' : 'unknown', error: e.message });
                            if (unsent)
                                releaseUnsent(r.to);
                        }
                    }
                    else if (r.state === 'completed' && r.fromSession && ids.includes(r.fromSession) && !r.returnedAt && !r.nativeReplyState) {
                        if (!reserveIdle(r.fromSession, () => true))
                            continue;
                        let claimed = false;
                        change(r.id, latest => { if (latest.returnedAt || latest.nativeReplyState)
                            return latest; claimed = true; return { ...latest, nativeReplyState: 'sending' }; });
                        if (!claimed) {
                            releaseUnsent(r.fromSession);
                            continue;
                        }
                        try {
                            await send(r.fromSession, nativeReplyText(r), r.id);
                            change(r.id, latest => ({ ...latest, returnedAt: new Date().toISOString(), nativeReplyState: 'submitted' }));
                            options.onEvent?.({ event: 'reply-submitted', request: r.id });
                        }
                        catch (e) {
                            const unsent = e.notDelivered;
                            change(r.id, latest => ({ ...latest, nativeReplyState: unsent ? undefined : 'unknown' }));
                            if (unsent)
                                releaseUnsent(r.fromSession);
                        }
                    }
                }
                for (const target of ids) {
                    await notifyPendingRequests(target);
                    await notifyMailbox(target);
                }
            } while (pending && !stopped);
        }
        finally {
            scanning = false;
        }
    };
    const wake = () => { void scan().catch(() => options.onEvent?.({ event: 'scan-error' })); };
    const watcher = fs.watch(requests, wake);
    const mailboxDir = path.join(home(), 'mailboxes');
    fs.mkdirSync(mailboxDir, { recursive: true });
    const mailWatcher = fs.watch(mailboxDir, wake);
    const sessionWatcher = fs.watch(path.join(home(), 'sessions'), wake);
    const heartbeat = setInterval(() => { refresh(); wake(); }, 5000);
    wake();
    return { id, close: () => {
            stopped = true;
            watcher.close();
            mailWatcher.close();
            sessionWatcher.close();
            clearInterval(heartbeat);
            // 네이티브 전달을 선택한 세션은 연결이 끊겨도 긴 훅 대기로 되돌리지 않는다.
            // 세션의 선택은 보존하고 생존 lease만 회수한다. 다음 연결이 이 식별자를 교체한다.
            if (fs.existsSync(leaseFile))
                fs.unlinkSync(leaseFile);
        } };
}
