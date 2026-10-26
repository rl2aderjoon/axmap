/** Read-only loopback view for clients that cannot embed MCP Apps. */
import http from 'node:http'
import fs from 'node:fs'
import { createMonitor } from './monitor.mjs'
import { pipelineView } from './pipeline-mcp.mjs'
export async function startPipelineWeb(cwd: string, port = 0) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be 0..65535')
  const collect = createMonitor(cwd)
  const html = fs.readFileSync(new URL('../mcp/pipeline.html', import.meta.url), 'utf8')
    .replace('<html lang="ko">', '<html lang="ko" data-axmap-local="true">')
    .replace('<script>', '<script>window.axmapLocalRead=()=>fetch("/api/snapshot",{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error("Local observation failed");return r.json()});</script><script>')
  let collecting: ReturnType<typeof collect> | null = null, url = ''
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.headers.host !== new URL(url).host || req.headers.origin && req.headers.origin !== url || req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403); res.end('Local origin required'); return }
    if (req.method !== 'GET') { res.writeHead(405); res.end('Read-only'); return }
    if (req.url === '/' || req.url === '/pipeline') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return }
    if (req.url !== '/api/snapshot') { res.writeHead(404); res.end(); return }
    try {
      // Concurrent browser refreshes share observation; none submit a model turn.
      collecting ??= collect().finally(() => { collecting = null })
      const snapshot = await collecting
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ structuredContent: pipelineView(snapshot), isError: false }))
    } catch { res.writeHead(503); res.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'Local observation failed' }] })) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local listener unavailable')
  url = `http://127.0.0.1:${address.port}`
  return { url: `${url}/pipeline`, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() }) }
}
