// Generated from src/windows-console.mts. Edit the .mts source and run npm run build.
/** Cache a framework-only native helper; machines without csc keep the PS path. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../tools/windows-console.cs', import.meta.url));
export function nativeConsoleHelper() {
    if (process.platform !== 'win32' || process.env.AXMAP_CONSOLE_HELPER === 'powershell')
        return null;
    const framework = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET');
    const compiler = ['Framework64', 'Framework'].map(p => path.join(framework, p, 'v4.0.30319', 'csc.exe')).find(p => fs.existsSync(p));
    if (!compiler || !fs.existsSync(source))
        return null;
    const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 24);
    const dir = path.join(process.env.AXMAP_STATE_DIR || path.join(os.homedir(), '.axmap'), 'bridge', 'native');
    const executable = path.join(dir, `console-${hash}.exe`);
    if (fs.existsSync(executable))
        return executable;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `${hash}-${randomUUID()}.exe`);
    try {
        const r = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll',
            '/reference:System.Management.dll', `/out:${temporary}`, source], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        if (r.error || r.status !== 0)
            return null;
        try {
            fs.renameSync(temporary, executable);
        }
        catch (e) {
            if (!fs.existsSync(executable))
                throw e;
        }
        return executable;
    }
    finally {
        if (fs.existsSync(temporary))
            fs.unlinkSync(temporary);
    }
}
