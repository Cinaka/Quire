const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
if (typeof require('node:module').registerHooks !== 'function') {
  console.error('P5专项需要Node的registerHooks及原生TypeScript擦除（22.15+）；请报告版本，不要自动升级。')
  process.exit(1)
}
const files = fs.readdirSync(path.join(root, 'tests')).filter(name => /^notebook-.*\.test\.cjs$/.test(name)).sort().map(name => path.join(root, 'tests', name))
if (!files.length) { console.error('未找到P5测试，不能登记通过。'); process.exit(1) }
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--require', path.join(root, 'tests/notebook-test-loader.cjs'), '--test', ...files], { cwd: root, stdio: 'inherit' })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
