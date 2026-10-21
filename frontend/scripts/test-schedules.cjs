const fs = require("node:fs")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const root = path.resolve(__dirname, "..")
const groups = {
  sync: ["schedules-evidence-file.test.cjs", "schedules-conflict.test.cjs","schedules-route.test.cjs", "schedules-conflict-center.test.cjs", "schedules-sync-runtime.test.cjs", "schedules-test-runner.test.cjs", "schedules-sync.test.cjs", "schedules-conversion-sync.test.cjs", "schedules-push.test.cjs", "schedules-pull.test.cjs", "schedules-network.test.cjs", "schedules-request-identity.test.cjs", "schedules-sync-protection.test.cjs", "schedules-owner.test.cjs", "schedules-media-protection.test.cjs", "schedules-tag-protection.test.cjs"],
}
const args = process.argv.slice(2)
const group = args.length === 0 ? null : args.length === 2 && args[0] === "--group" ? args[1] : "INVALID"
if (group !== null && !Object.hasOwn(groups, group)) { console.error("未知P4测试分组；可用：--group sync。未执行测试，不视为通过。"); process.exit(1) }
let files
try {
  files = group ? groups[group].map(name => { const file = path.join(root, "tests", name); if (!fs.existsSync(file)) throw new Error(`专项测试缺失：${name}`); return file }) : fs.readdirSync(path.join(root, "tests"))
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
if (group) console.log(`P4 ${group} 专项：仅覆盖列出的受影响范围，不代表P4完整回归通过。`)
console.log(`运行 P4 测试：${files.length} 个文件（含模拟存储，不代替真实 IndexedDB）`)
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" })
if (result.error) console.error("P4 测试启动失败：", result.error.message)
if (result.signal) console.error(`P4 测试被信号 ${result.signal} 中断。`)
process.exit(result.status ?? 1)
