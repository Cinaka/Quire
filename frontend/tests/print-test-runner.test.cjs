const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { collectTests, makePlan, runPlan } = require('../scripts/test-print.cjs')
const manifest = require('../scripts/print-test-manifest.json')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-print-runner-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true })) // Only our newly created temp fixture.
  const put = (name, text = '') => { const p = path.join(root, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
  for (const name of new Set(Object.values(manifest.groups).flat())) put(`tests/${name}`)
  for (const p of ['tests/notebook-test-loader.cjs', 'scripts/test-checkins.cjs', 'scripts/test-schedules.cjs', 'scripts/test-notebook.cjs', 'tsconfig.notebook-browser.json', 'node_modules/vue-tsc/bin/vue-tsc.js', 'npm-cli.js']) put(p)
  put('package.json', JSON.stringify({ scripts: { build: 'vue-tsc -b && vite build' } }))
  return { root, put, npm: path.join(root, 'npm-cli.js') }
}
test('P6 collector includes all export/print files and shared session, excludes unrelated groups', t => {
  const { root, put } = fixture(t); put('tests/export-future.test.cjs'); put('tests/random.test.cjs')
  const names = collectTests(root, 'p6').map(p => path.basename(p))
  assert.ok(names.includes('export-future.test.cjs')); assert.ok(names.includes('print-test-runner.test.cjs')); assert.ok(names.includes('notebook-session.test.cjs'))
  assert.ok(!names.includes('checkins-cache.test.cjs')); assert.ok(!names.includes('random.test.cjs'))
  assert.deepEqual(names, [...names].sort())
})
test('missing one mandatory test cannot silently shrink a passing suite', t => {
  const { root } = fixture(t); fs.unlinkSync(path.join(root, 'tests/export-formal-view.test.cjs'))
  assert.throws(() => collectTests(root, 'p6'), /缺少 p6/)
})
test('unknown, empty, path-containing manifests and directory-shaped tests fail closed', t => {
  const { root, put } = fixture(t)
  for (const [group, names] of [['other', ['x']], ['p6', []], ['p6', ['../print-x.test.cjs']], ['p6', ['print-foo\\x.test.cjs']]]) assert.throws(() => collectTests(root, group, names))
  put('tests/print-directory.test.cjs/x'); assert.throws(() => collectTests(root, 'p6'), /验收文件不可用/)
})
test('integration preflights all four groups, preserves full P4, checks P5 tool types, builds once last', t => {
  const { root, npm } = fixture(t); const steps = makePlan(root, true, npm)
  assert.equal(steps.length, 6)
  assert.match(steps[1].args[0], /test-schedules.cjs$/); assert.equal(steps[1].args.length, 1)
  assert.ok(steps[3].args.includes('--experimental-strip-types'))
  assert.deepEqual(steps[4].args.slice(1), ['--noEmit', '-p', 'tsconfig.notebook-browser.json'])
  assert.deepEqual(steps[5].args, [npm, 'run', 'build'])
  fs.unlinkSync(path.join(root, 'tests/checkins-cache.test.cjs')); assert.throws(() => makePlan(root, true, npm), /缺少 p3/)
})
test('P6-only plan needs no build dependencies; integration refuses missing tools or changed build', t => {
  const { root, npm, put } = fixture(t)
  fs.unlinkSync(path.join(root, 'node_modules/vue-tsc/bin/vue-tsc.js'))
  assert.equal(makePlan(root, false).length, 1); assert.throws(() => makePlan(root, true, npm))
  put('node_modules/vue-tsc/bin/vue-tsc.js'); assert.throws(() => makePlan(root, true, ''), /npm run/)
  put('package.json', JSON.stringify({ scripts: { build: 'echo skip' } })); assert.throws(() => makePlan(root, true, npm), /构建契约/)
})
test('all-success execution runs each step once with no shell and labels limitations', t => {
  const { root, npm } = fixture(t); const calls = []; const logs = []
  assert.equal(runPlan(root, makePlan(root, true, npm), (...a) => { calls.push(a); return { status: 0 } }, x => logs.push(x)), 0)
  assert.equal(calls.length, 6); assert.ok(calls.every(c => c[2].shell === false && c[2].cwd === root))
  assert.match(logs.at(-1), /不等于真实存储/)
})
test('nonzero, signal, launch error, absent status and throw all stop before later steps', () => {
  for (const result of [{ status: 7 }, { status: 0, signal: 'SIGTERM' }, { status: 0, error: new Error('spawn') }, { status: null }, undefined, 'throw']) {
    let count = 0; const logs = []; const steps = [{name:'one',command:'node',args:[]},{name:'two',command:'node',args:[]}]
    const code = runPlan('.', steps, () => { count++; if (result === 'throw') throw Error('spawn'); return result }, x => logs.push(x))
    assert.notEqual(code, 0); assert.equal(count, 1); assert.ok(!logs.some(x => x.includes('自动检查完成')))
  }
  assert.throws(() => runPlan('.', []), /为空/)
})
test('real child process failure stops execution, not just injected result objects', () => {
  const steps = [{name:'intentional failure',command:process.execPath,args:['-e','process.exit(9)']},{name:'must not run',command:process.execPath,args:['-e','process.exit(0)']}]
  let count = 0
  assert.equal(runPlan(process.cwd(), steps, (...a) => { count++; return spawnSync(...a) }, () => {}), 9); assert.equal(count, 1)
})
test('CLI rejects unknown flags, help does not start tests or claim acceptance', () => {
  const script = path.join(__dirname, '../scripts/test-print.cjs')
  const bad = spawnSync(process.execPath, [script, '--group', 'sync'], { encoding: 'utf8' })
  assert.equal(bad.status, 1); assert.match(bad.stderr, /未运行测试/)
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0); assert.match(help.stdout, /无安装\/迁移/)
})
