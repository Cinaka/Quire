const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const root = path.resolve(__dirname, "..")
let files
try {
  files = fs.readdirSync(path.join(root, "tests"))
    .filter(name => /^schedules-.*\.test\.cjs$/.test(name)).sort()
    .map(name => path.join(root, "tests", name))
} catch (error) {
  console.error("无法读取 P4 测试目录：", error.message)
  process.exit(1)
}
if (!files.length) {
  console.error("未找到 P4 测试，不能视为通过。")
  process.exit(1)
}
console.log(`运行 P4 测试：${files.length} 个文件（含模拟存储，不代替真实 IndexedDB）`)
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" })
if (result.error) console.error("P4 测试启动失败：", result.error.message)
if (result.signal) console.error(`P4 测试被信号 ${result.signal} 中断。`)
process.exit(result.status ?? 1)
