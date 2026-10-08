const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function harness() {
  const events = new Map()
  const disposers = []
  const navigator = { onLine: true }
  let calls = 0
  let fail = true
  const result = { year: 2026, month: 10, checkinDates: [], today: '2026-10-08', timezone: 'Asia/Shanghai', checkedInToday: false, currentStreak: 0, longestStreak: 0, totalCheckins: 0, updatedAt: 1 }
  const modules = {
    vue: { ref: value => ({ value }), computed: fn => ({ get value() { return fn() } }), onScopeDispose: fn => disposers.push(fn) },
    '@/api/checkinCache': { cacheCheckinMonth() {}, readCachedCheckinMonth: () => null },
    '@/api/checkins': { async getMonthCheckins() { calls++; if (fail) throw new Error('network'); return result }, async checkInToday() { throw new Error('unexpected submit') } },
    '@/api/tokenStore': { ACCESS_TOKEN_KEY: 'quire_access_token', accessTokenSubject: () => 'account-a' },
  }
  const window = { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name), setInterval: () => 1, clearInterval() {} }
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const source = fs.readFileSync(path.join(__dirname, '../src/composables/useCheckins.ts'), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, require: name => modules[name], navigator, window, document, Date, console })
  return { state: exports.useCheckins(), navigator, events, disposers, get calls() { return calls }, succeed() { fail = false } }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('manual retry recovers a failed first current-month request without cache', async () => {
  const h = harness()
  await h.state.loadCurrent()
  assert.equal(h.calls, 1)
  assert.equal(h.state.summary.value, null)
  h.succeed()
  h.state.revalidateActive(true)
  await settle()
  assert.equal(h.calls, 2)
  assert.equal(h.state.summary.value.month, 10)
  assert.equal(h.state.error.value, '')
})

test('online event recovers an offline first load without cache', async () => {
  const h = harness()
  h.navigator.onLine = false
  await h.state.loadCurrent()
  assert.equal(h.calls, 0)
  h.succeed()
  h.navigator.onLine = true
  h.events.get('online')()
  await settle()
  assert.equal(h.calls, 1)
  assert.equal(h.state.offline.value, false)
  assert.equal(h.state.summary.value.month, 10)
})

test('unused or reset state does not start requests from refresh events', async () => {
  const h = harness()
  h.state.revalidateActive(true)
  assert.equal(h.calls, 0)
  await h.state.loadCurrent()
  h.state.reset()
  h.state.revalidateActive(true)
  await settle()
  assert.equal(h.calls, 1)
})
