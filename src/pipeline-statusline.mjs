// Generated from src/pipeline-statusline.mts. Edit the .mts source and run npm run build.
/** Native CLI adapter. Reads local records only and preserves the user's old status command. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bridgeHome, repoKey, readJSON, writeJSON } from './bridge.mjs';
import { createMonitor, fitTerminal, terminalText } from './monitor.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const savedFile = (home, provider) => path.join(home, '.axmap', 'bridge', `statusline-${provider}.json`);
function client(value) { if (value !== 'claude' && value !== 'agy')
    throw new Error('claude 또는 agy를 지정하세요.'); return value; }
function settings(home, provider) { return provider === 'claude' ? path.join(home, '.claude', 'settings.json') : path.join(home, '.gemini', 'antigravity-cli', 'settings.json'); }
export function installPipelineStatusline(providerName, home = os.homedir(), remove = false) {
    const provider = client(providerName), target = settings(home, provider), file = savedFile(home, provider);
    const original = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const config = original === null ? {} : JSON.parse(original);
    if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Error('기존 설정을 읽지 못했습니다. 변경하지 않았습니다.');
    const current = config.statusLine;
    if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current)))
        throw new Error('기존 statusLine 설정이 객체가 아닙니다. 변경하지 않았습니다.');
    const owned = typeof current?.command === 'string' && current.command.includes(`axmap-statusline-${provider}`);
    if (remove && !owned)
        return { provider, changed: false, note: '다른 상태줄 설정을 유지합니다.' };
    const saved = fs.existsSync(file) ? readJSON(file) : null;
    if (owned && !saved)
        throw new Error('기존 상태줄 복원 정보를 찾지 못했습니다. 변경하지 않았습니다.');
    const previous = owned ? saved.previous : current;
    const script = path.join(root, 'tools', 'pipeline.mjs');
    const wrapper = path.join(home, '.axmap', 'bridge', `axmap-statusline-${provider}${process.platform === 'win32' ? '.cmd' : '.sh'}`);
    if (process.platform === 'win32' && [process.execPath, script, wrapper].some(p => /["\r\n%&|<>^!]/.test(p)))
        throw new Error('상태줄 실행 경로에 지원하지 않는 셸 문자가 있습니다.');
    if (process.platform === 'win32' && /\s/.test(wrapper))
        throw new Error('이 Windows 상태줄 실행 경로에는 공백을 사용할 수 없습니다. 기존 설정을 유지합니다.');
    const backup = `${target}.axmap-${randomUUID()}.bak`;
    if (original !== null)
        fs.writeFileSync(backup, original, { mode: 0o600 });
    writeJSON(file, { previous, active: !remove });
    if (remove) {
        if (previous === undefined)
            delete config.statusLine;
        else
            config.statusLine = previous;
    }
    else {
        fs.mkdirSync(path.dirname(wrapper), { recursive: true });
        const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
        const command = process.platform === 'win32'
            ? `@echo off\r\n"${process.execPath}" "${script}" statusline --provider ${provider}\r\n`
            : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} statusline --provider ${provider}\n`;
        fs.writeFileSync(wrapper, command, { mode: 0o700 });
        config.statusLine = { ...previous, type: 'command',
            command: provider === 'claude' ? `"${wrapper.replaceAll('\\', '/')}"` : process.platform === 'win32' ? wrapper : quote(wrapper),
            ...(provider === 'claude' ? { refreshInterval: previous?.refreshInterval ?? 2 } : { enabled: true, stack_with_default: previous?.stack_with_default ?? true }) };
    }
    writeJSON(target, config);
    return { provider, changed: true, settings: target, backup: original === null ? null : backup,
        previousPreserved: !!previous, installed: !remove };
}
function previousOutput(provider, home, input, previous) {
    if (typeof previous?.command !== 'string' || !previous.command.trim())
        return '';
    let executable, args;
    if (process.platform === 'win32' && provider === 'claude') {
        const bash = [process.env.CLAUDE_CODE_GIT_BASH_PATH, path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')].find(p => p && fs.existsSync(p));
        if (!bash)
            return '기존 상태줄: Git Bash 경로 확인 필요\n';
        executable = bash;
        args = ['-c', previous.command];
    }
    else if (process.platform === 'win32') {
        executable = process.env.ComSpec || 'cmd.exe';
        args = ['/d', '/s', '/c', previous.command];
    }
    else {
        executable = '/bin/sh';
        args = ['-c', previous.command];
    }
    // Only the user's pre-existing command is executed; provider JSON stays on stdin.
    const options = { input, encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 65536 };
    const result = process.platform === 'win32' && provider === 'agy'
        ? spawnSync(previous.command, { ...options, shell: process.env.ComSpec || 'cmd.exe' })
        : spawnSync(executable, args, options);
    return result.stdout || '';
}
export async function pipelineStatusline(providerName, input, home = os.homedir()) {
    const provider = client(providerName), file = savedFile(home, provider);
    const saved = fs.existsSync(file) ? readJSON(file) : null;
    const prior = previousOutput(provider, home, input, saved?.previous);
    if (saved?.active === false)
        return prior;
    const payload = JSON.parse(input);
    const candidates = new Set([payload.workspace?.current_dir, payload.cwd].filter((p) => typeof p === 'string' && path.isAbsolute(p)));
    const conversationId = payload.conversation_id || payload.session_id;
    if (conversationId) {
        const directory = path.join(bridgeHome(), 'sessions');
        if (fs.existsSync(directory))
            for (const name of fs.readdirSync(directory).filter(n => /^[0-9a-f-]{36}\.json$/i.test(n))) {
                try {
                    const s = readJSON(path.join(directory, name));
                    if (s.conversationId === conversationId && s.workspaces?.length === 1)
                        candidates.add(s.workspaces[0]);
                }
                catch { /* a partial record cannot establish scope */ }
            }
    }
    let cwd;
    for (const candidate of candidates) {
        try {
            repoKey(candidate);
            cwd = candidate;
            break;
        }
        catch { /* try an explicitly attached workspace */ }
    }
    const width = Math.max(20, Math.min(240, Number(payload.terminal_width || process.env.COLUMNS) || 100));
    let line = 'axMap · 이 대화는 Git 저장소에 연결되지 않았습니다.';
    if (cwd) {
        const snapshot = await createMonitor(cwd, { probe: async () => [],
            resolve: id => readJSON(path.join(bridgeHome(), 'requests', `${id}.json`)) })();
        const active = snapshot.requests.find(r => ['sending', 'submitted', 'unknown'].includes(r.state));
        const request = active || snapshot.requests[0];
        const state = payload.tool_confirmation_pending ? '승인 필요' : { working: '작업 중', tool_use: '도구 실행', reviewing: '검토 중', idle: '대기', error: '오류', initializing: '시작 중', authenticating: '인증 중' }[payload.agent_state || ''];
        const spin = ['◐', '◓', '◑', '◒'][Math.floor(Date.now() / 300) % 4];
        const flow = !request ? '새 요청 대기' : request.state === 'completed' ? '접수 ✓ → 전달 ✓ → 응답 ✓ → 완료 ✓' : request.state === 'submitted'
            ? `접수 ✓ → 전달 ✓ → ${spin} 응답 대기 → 완료 미확정` : request.state === 'sending' ? `${spin} 전달 중 → 응답 대기` : request.state === 'unknown' ? '전달 확인 필요 → 완료 미확정' : `${request.state} → 완료 미확정`;
        line = `axMap${state ? ` · ${provider} ${state}` : ''} · ${!active && request ? '최근 요청 · ' : ''}${flow}`;
        if (snapshot.issues.length)
            line += ' · 기록 확인 필요';
    }
    return prior + (prior && !prior.endsWith('\n') ? '\n' : '') + fitTerminal(terminalText(line), width) + '\n';
}
