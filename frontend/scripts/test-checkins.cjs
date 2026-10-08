const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const frontendRoot = path.resolve(__dirname, '..')
const testsDirectory = path.join(frontendRoot, 'tests')
let testFiles
try {
  testFiles = fs.readdirSync(testsDirectory)
    .filter(name => /^checkins-.*\.test\.cjs$/.test(name))
    .sort()
    .map(name => path.join(testsDirectory, name))
} catch (error) {
  console.error('无法读取 P3 签到测试目录：', error.message)
  process.exit(1)
}

if (testFiles.length === 0) {
  console.error('未找到 P3 签到测试，验收不能视为通过。')
  process.exit(1)
}

console.log(`运行 P3 签到测试：${testFiles.length} 个文件`)
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: frontendRoot,
  stdio: 'inherit',
})
if (result.error) console.error('测试进程启动失败：', result.error.message)
if (result.signal) console.error(`测试进程被信号 ${result.signal} 中断。`)
process.exit(result.status ?? 1)
