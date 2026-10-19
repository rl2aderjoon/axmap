/** AI CLI executable discovery shared by setup and MCP registration. */
import { spawnSync } from 'node:child_process'

export const AGENTS = [
  { id: 'claude', name: 'Claude Code', bin: 'claude' },
  { id: 'agy', name: 'Antigravity', bin: 'agy' },
  { id: 'codex', name: 'Codex CLI', bin: 'codex' },
]

/** Resolve the executable without a shell so paths and arguments stay intact. */
export function resolveBin(bin) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [bin], {
      encoding: 'utf8', windowsHide: true,
    })
    if (r.status !== 0) return null
    return r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || null
  } catch { return null }
}
