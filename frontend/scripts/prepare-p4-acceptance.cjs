const { URL } = require("node:url")
function origin(value) {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("只接受不带路径、凭据或查询参数的origin")
  return url
}
function prepareAcceptance(daily, isolated) {
  const real = origin(daily); const test = origin(isolated)
  if (!["127.0.0.1", "localhost", "[::1]"].includes(test.hostname)) throw new Error("隔离测试origin必须为本机回环地址")
  if (real.origin === test.origin) throw new Error("隔离origin不能与日常origin相同；不得清除或升级日常数据")
  return { dailyOrigin: real.origin, isolatedOrigin: test.origin,
    scope: "只读准备清单，不创建/升级/删除IndexedDB，不启动服务器，不授权正式入口",
    checks: ["先完成check:p4/check:p3并保留精确HEAD", "确认隔离origin此前无日常数据并自行备份", "显式隔离宿主/页面挂载接线尚未完成，不能直接import绕过闸门", "首次保存日期分流、媒体/备份/身份和目标守卫必须真实浏览器验证"] }
}
module.exports = { prepareAcceptance }
if (require.main === module) {
  try {
    const args = process.argv.slice(2); const dailyAt = args.indexOf("--daily-origin"); const testAt = args.indexOf("--isolated-origin")
    if (dailyAt < 0 || testAt < 0 || args.length !== 4) throw new Error("用法：node scripts/prepare-p4-acceptance.cjs --daily-origin <日常origin> --isolated-origin <独立回环origin>")
    console.log(JSON.stringify(prepareAcceptance(args[dailyAt + 1], args[testAt + 1]), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
