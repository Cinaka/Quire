const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { registerHooks } = require('node:module')
const manifest = require('./print-test-manifest.json')
const selectors = {
  p3: /^checkins-.*\.test\.cjs$/,
  p4: /^schedules-.*\.test\.cjs$/,
  p5: /^notebook-.*\.test\.cjs$/,
  p6: /^(?:export-|print-).*\.test\.cjs$|^notebook-session\.test\.cjs$/,
}
function requiredFile(root, relative) {
  if (!fs.statSync(path.join(root, relative)).isFile()) throw new Error(`验收文件不可用：${relative}`)
}
function collectTests(root, group, required = manifest.groups[group]) {
  if (!Object.hasOwn(selectors, group) || !Array.isArray(required) || !required.length) throw new Error('测试清单无效；不能视为通过。')
  const names = fs.readdirSync(path.join(root, 'tests')).filter(name => selectors[group].test(name)).sort()
  for (const name of required) {
    if (typeof name !== 'string' || !selectors[group].test(name) || name.includes('/') || name.includes('\\')) throw new Error('测试清单含非法名称。')
    if (!names.includes(name)) throw new Error(`缺少 ${group} 必需测试：${name}；未执行，不视为通过。`)
  }
  for (const name of names) requiredFile(root, `tests/${name}`)
  if (!names.length) throw new Error('没有测试；不能视为通过。')
  return names.map(name => path.join(root, 'tests', name))
}
function makePlan(root, integration, npmCli = process.env.npm_execpath) {
  const groups = integration ? ['p3', 'p4', 'p5', 'p6'] : ['p6']
  const files = Object.fromEntries(groups.map(group => [group, collectTests(root, group)]))
  requiredFile(root, 'tests/notebook-test-loader.cjs')
  const p6 = { name: 'P6 专项', command: process.execPath, args: ['--experimental-strip-types', '--require', path.join(root, 'tests/notebook-test-loader.cjs'), '--test', ...files.p6] }
  if (!integration) return [p6]
  // Preflight the entire chain before any subprocess. No dependency installation,
  // fixture creation, server startup, migration, cleanup or implicit build skip.
  for (const file of ['scripts/test-checkins.cjs', 'scripts/test-schedules.cjs', 'scripts/test-notebook.cjs', 'tsconfig.notebook-browser.json', 'node_modules/vue-tsc/bin/vue-tsc.js']) requiredFile(root, file)
  if (!npmCli || !fs.statSync(npmCli).isFile()) throw new Error('请通过 npm run check:p6:integration 启动；不自动安装或升级 npm。')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (pkg.scripts?.build !== 'vue-tsc -b && vite build') throw new Error('构建契约已变化，请先核对；不跳过 build。')
  return [
    ...[['P3 全量', 'test-checkins.cjs'], ['P4 全量', 'test-schedules.cjs'], ['P5 全量', 'test-notebook.cjs']].map(([name, file]) => ({ name, command: process.execPath, args: [path.join(root, 'scripts', file)] })),
    p6,
    { name: 'P5 隔离工具类型检查', command: process.execPath, args: [path.join(root, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', 'tsconfig.notebook-browser.json'] },
    { name: '正式项目构建（仅一次）', command: process.execPath, args: [npmCli, 'run', 'build'] },
  ]
}
function runPlan(root, steps, execute = spawnSync, log = console.log) {
  if (!steps.length) throw new Error('验收链为空；不能视为通过。')
  for (const step of steps) {
    log(`\n[P6] ${step.name}`)
    let result
    try { result = execute(step.command, step.args, { cwd: root, stdio: 'inherit', shell: false }) }
    catch { log(`[P6] ${step.name} 启动异常；后续停止，不视为通过。`); return 1 }
    if (!result || result.error || result.signal || result.status !== 0) {
      log(`[P6] ${step.name} 失败或中断；后续停止，不视为通过。`)
      return Number.isInteger(result?.status) && result.status > 0 && result.status < 256 ? result.status : 1
    }
  }
  log('[P6] 所列自动检查完成；不等于真实存储/浏览器、手机、PDF、内存或实物验收。')
  return 0
}
function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log('test:p6：P6专项；check:p6:integration：P3/P4/P5/P6 + P5工具类型 + 一次正式build。失败即停，无安装/迁移。'); return 0 }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--integration')) { console.error('未知参数；未运行测试，不视为通过。'); return 1 }
  if (typeof registerHooks !== 'function') { console.error('需要已有 Node 22.15+ 的 registerHooks/TS擦除能力；请报告版本，不自动升级。'); return 1 }
  const root = path.resolve(__dirname, '..')
  try { return runPlan(root, makePlan(root, args[0] === '--integration')) }
  catch (error) { console.error(`[P6] 预检失败：${error.message}`); return 1 }
}
module.exports = { collectTests, makePlan, runPlan, main }
if (require.main === module) process.exitCode = main(process.argv.slice(2))
