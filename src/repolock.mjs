import fs from 'node:fs'
import crypto from 'node:crypto'

/** Serialize bootstrap across processes and linked worktrees. Never steal a lock:
 * a slow remote must not let a second initializer change the same refs/index. */
export function withRepoLock(file, action, timeoutMs = 30000) {
  const owner = JSON.stringify({ pid: process.pid, token: crypto.randomUUID() })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.writeFileSync(file, owner, { flag: 'wx' })
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (Date.now() >= deadline) {
        throw new Error(`장부 준비 잠금을 기다리다 중단했습니다: ${file}\n` +
          '다른 초기화가 끝난 뒤 다시 시도하세요. 비정상 종료로 남은 잠금은 소유 프로세스가 종료됐는지 확인한 뒤 제거하세요.')
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  const release = () => {
    try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file) } catch { /* already released */ }
  }
  // CLI errors use process.exit; finally alone would leave a permanent lock.
  process.once('exit', release)
  try { return action() } finally {
    release()
    process.removeListener('exit', release)
  }
}
