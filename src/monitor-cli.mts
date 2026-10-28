import path from 'node:path'
import { createMonitor, renderMonitor } from './monitor.mjs'
import type { MonitorSnapshot } from './monitor.mjs'
import { errorMessage } from './session-types.mjs'
import { renderPipelineGraph } from './pipeline-graph.mjs'
import { createView, renderView } from './view.mjs'

export async function runMonitor(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('axmap monitor [--cwd <repo>] [--interval 1000] [--once | --json] [--no-color]\n세션·요청 파이프라인·자동 대화·선점·최근 이벤트를 실시간으로 표시합니다.\nTTY에서는 계속 갱신하며, 파이프/리디렉션에서는 한 번만 출력합니다. q / Esc / Ctrl+C 종료.')
    return
  }
  const allowed = new Set(['--cwd', '--interval', '--once', '--json', '--no-color', '--graph', '--view'])
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i]!)) throw new Error(`알 수 없는 옵션: ${args[i]}`)
    if (args[i] === '--cwd' || args[i] === '--interval') {
      if (!args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`${args[i]} 값이 필요합니다.`)
      i++
    }
  }
  const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  const interval = Number(option('--interval') || 1000)
  if (!Number.isInteger(interval) || interval < 250 || interval > 60000) throw new Error('interval은 250~60000ms 정수여야 합니다.')
  const cwd = path.resolve(option('--cwd') || process.cwd())
  const collect = args.includes('--view') ? createView(cwd) : createMonitor(cwd)
  const render = args.includes('--view') ? renderView : args.includes('--graph') ? renderPipelineGraph : renderMonitor
  const live = !!process.stdout.isTTY && !!process.stdin.isTTY && process.env.TERM !== 'dumb' && !args.includes('--once') && !args.includes('--json')
  const color = !!process.stdout.isTTY && !args.includes('--no-color') && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
  if (!live) {
    const snapshot = await collect()
    console.log(args.includes('--json') ? JSON.stringify(snapshot, null, 2) : render(snapshot, { columns: process.stdout.columns || 100, rows: process.stdout.rows || 56, color }))
    return
  }
  let stopped = false, frame = 0, timer: NodeJS.Timeout | undefined, animation: NodeJS.Timeout | undefined
  let latest: MonitorSnapshot | null = null
  const wasRaw = !!process.stdin.isRaw
  await new Promise<void>(resolve => {
    const restore = () => {
      if (stopped) return
      stopped = true; clearTimeout(timer); clearInterval(animation)
      process.stdin.off('data', input); process.off('SIGINT', restore); process.off('SIGTERM', restore); process.off('exit', restore)
      process.stdin.setRawMode(wasRaw); process.stdin.pause()
      process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l')
      resolve()
    }
    const input = (text: string) => { if (text === '\x1b' || text.includes('\x03') || /^[qQ]+$/.test(text)) restore() }
    const draw = () => {
      if (stopped || !latest) return
      const view = render(latest, { columns: process.stdout.columns || 100, rows: Math.max(1, (process.stdout.rows || 36) - 1), color, frame: frame++ })
      process.stdout.write('\x1b[H' + view.replaceAll('\n', '\x1b[K\r\n') + '\x1b[K\x1b[J')
    }
    const update = async () => {
      try {
        const snapshot = await collect()
        if (stopped) return
        latest = snapshot; draw()
      } catch (e) {
        restore(); console.error(`axMap monitor: ${errorMessage(e)}`); process.exitCode = 1; return
      }
      if (!stopped) timer = setTimeout(update, interval)
    }
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H')
    process.stdin.setEncoding('utf8'); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', input)
    process.once('SIGINT', restore); process.once('SIGTERM', restore); process.once('exit', restore)
    animation = setInterval(draw, 180)
    void update()
  })
}
