// Generated from src/app-queue.mts. Edit the .mts source and run npm run build.
/** 앱 협업의 완료는 요청 ID를 지정한 명시적 회신으로만 확정한다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withRepoLock } from './repolock.mjs';
import { repoKey } from './bridge.mjs';
const home = () => path.join(process.env.AXMAP_STATE_DIR || path.join(os.homedir(), '.axmap'), 'bridge');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function read(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
function file(kind, id) {
    if (!uuid.test(id || ''))
        throw new Error('요청·세션 ID는 UUID여야 합니다.');
    return path.join(home(), kind, `${id}.json`);
}
export function pendingAppRequests(session) {
    file('sessions', session);
    const dir = path.join(home(), 'requests');
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir).filter(n => uuid.test(path.basename(n, '.json')) && n.endsWith('.json'))
        .map(n => read(path.join(dir, n)))
        .filter(r => r.to === session && r.nativeRelayId && r.state === 'submitted')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function replyAppRequest({ id, session, cwd, text }) {
    const target = file('requests', id);
    const s = read(file('sessions', session));
    const repo = repoKey(cwd);
    if (s.transport !== 'hook' || !s.repos.includes(repo))
        throw new Error('현재 저장소의 앱 수신 세션이 필요합니다.');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 32768)
        throw new Error('회신은 1~32768바이트여야 합니다.');
    return withRepoLock(file('requests', session) + '.lock', () => {
        const r = read(target);
        if (r.to !== session || r.repo !== repo || !r.nativeRelayId)
            throw new Error('이 세션이 받은 네이티브 협업 요청이 아닙니다.');
        if (r.state === 'completed') {
            if (r.result !== text)
                throw new Error('이미 다른 회신으로 완료된 요청입니다.');
            return { ...r, replayed: true };
        }
        if (r.state !== 'submitted')
            throw new Error('전달이 확인된 요청에만 회신할 수 있습니다. 불명 요청은 재실행하지 마세요.');
        const next = { ...r, state: 'completed', result: text, replyMode: 'explicit', completedAt: new Date().toISOString() };
        const temp = `${target}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
            fs.renameSync(temp, target);
        }
        finally {
            if (fs.existsSync(temp))
                fs.unlinkSync(temp);
        }
        return { ...next, replayed: false };
    });
}
