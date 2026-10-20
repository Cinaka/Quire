const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const code = fs.readFileSync(path.join(__dirname, '../scripts/test-schedules.cjs'), 'utf8')
function run(args, missing = '') {
  let invocation, status; const log = []
  const sentinel = Symbol('exit')
  try { vm.runInNewContext(code, { __dirname: path.join(__dirname, '../scripts'), require(name) {
    if (name === 'node:child_process') return { spawnSync(...args) { invocation = args; return { status: 0 } } }
    if (name === 'node:fs') return { ...fs, existsSync: file => !file.endsWith(missing || 'NO_MISSING') && fs.existsSync(file) }
    return require(name)
  }, process: { argv: ['node', 'runner', ...args], execPath: process.execPath, exit(value) { status = value; throw sentinel } }, console: { log: line => log.push(line), error: line => log.push(line) } }) } catch (error) { if (error !== sentinel) throw error }
  return { invocation, status, log }
}
test('default command keeps the entire P4 file set; build is not substituted for tests', () => {
  const r = run([]), files = fs.readdirSync(__dirname).filter(f => /^schedules-.*\.test\.cjs$/.test(f))
  assert.equal(r.status, 0); assert.equal(r.invocation[1].length - 1, files.length)
})
test('sync group is explicit, smaller and includes runtime, protocol, owner and P2 resource protections', () => {
  const r = run(['--group', 'sync']), files = r.invocation[1].map(f => path.basename(f))
  assert.equal(r.status, 0); assert.equal(files.length - 1, 12)
  for (const file of ['schedules-sync-runtime.test.cjs', 'schedules-request-identity.test.cjs', 'schedules-sync-protection.test.cjs', 'schedules-owner.test.cjs', 'schedules-tag-protection.test.cjs']) assert.ok(files.includes(file))
  assert.match(r.log[0], /不代表P4完整回归通过/)
})
for (const args of [['--group', 'unknown'], ['sync'], ['--group'], ['--group', 'sync', 'extra']]) test(`bad group ${args.join(' ')} fails without spawning`, () => { const r = run(args); assert.equal(r.status, 1); assert.equal(r.invocation, undefined) })
test('missing scoped test fails closed, never silently reduces coverage', () => {
  const r = run(['--group', 'sync'], 'schedules-owner.test.cjs'); assert.equal(r.status, 1); assert.equal(r.invocation, undefined)
})
