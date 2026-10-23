// Loopback-only static lab: explicitly whitelists sample code + existing P5 font assets.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path')
const root = path.resolve(__dirname, '../..')
const allowed = url => /^\/frontend\/tools\/print-lab\/(?:index\.html|lab\.(?:css|mjs)|(?:toc-budget|resource-lab)\.(?:html|css|mjs)|(?:fixtures|image|imposition|print-guards|resource-fixtures|resource-budget)\.mjs)$/.test(url)
  || url === '/frontend/src/styles/notebook-fonts.css'
  || /^\/frontend\/src\/assets\/fonts\/notebook\/wenkai-[0-9a-f]{4}\.woff2$/.test(url)
function start() {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.headers.host !== '127.0.0.1:5184' || req.method !== 'GET') { res.writeHead(403); return res.end('loopback GET only') }
    let url
    try { url = new URL(req.url, 'http://127.0.0.1:5184').pathname } catch { res.writeHead(400); return res.end() }
    if (url === '/') { res.writeHead(302, { Location: '/frontend/tools/print-lab/index.html' }); return res.end() }
    if (!allowed(url)) { res.writeHead(404); return res.end('not a lab asset') }
    const file = path.join(root, url.slice('/frontend/'.length))
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2' }
    fs.readFile(file, (error, data) => { if (error) { res.writeHead(404); return res.end('asset missing') }; res.setHeader('Content-Type', types[path.extname(file)]); res.end(data) })
  })
  server.on('error', error => { console.error(`隔离页未启动（不换端口）：${error.message}`); process.exitCode = 1 })
  server.listen(5184, '127.0.0.1', () => console.log('P6-0固定样张 http://127.0.0.1:5184/ ; Ctrl+C停止；不读账号/日记/DB'))
  return server
}
module.exports = { allowed, start }
if (require.main === module) start()
