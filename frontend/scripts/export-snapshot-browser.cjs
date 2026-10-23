const path = require('node:path'), { pathToFileURL } = require('node:url')
const root = path.resolve(__dirname, '..')
async function main() {
  let entry
  try { entry = require.resolve('vite', { paths: [root] }) }
  catch { throw Error('未找到既有Vite依赖；未自动安装。请先核对当前工作副本及既有依赖。') }
  const { createServer } = await import(pathToFileURL(entry).href)
  const server = await createServer({ configFile: path.join(root, 'vite.export-browser.config.mjs') })
  await server.listen()
  console.log('P6-1 随机库快照核验：http://127.0.0.1:5185/；点击才运行，Ctrl+C停止。')
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)) })
}
main().catch(error => { console.error(`未启动（不换端口、不安装）：${error.message}`); process.exitCode = 1 })
