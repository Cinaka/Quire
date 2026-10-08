const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function harness() {
  let submits = 0
  const navigator = { onLine: true }
  const fresh = { year: 2026, month: 10, checkinDates: ['2026-10-08'], today: '2026-10-08', timezone: 'Asia/Shanghai', checkedInToday: true, currentStreak: 2, longestStreak: 2, totalCheckins: 2, updatedAt: 1 }
  const modules = {
    vue: { ref: value => ({ value }), computed: fn => ({ get value() { return fn() } }), onScopeDispose() {} },
    '@/api/checkinCache': { cacheCheckinMonth() {}, readCachedCheckinMonth: () => null },
    '@/api/tokenStore': { ACCESS_TOKEN_KEY: 'quire_access_token', accessTokenSubject: () => 'account-a' },
    '@/api/checkins': {
      async getMonthCheckins() { return fresh },
      async checkInToday() { submits++; return { checkinDate: fresh.today, checkedIn: true, created: false, currentStreak: 2, longestStreak: 2, totalCheckins: 2 } },
    },
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/composables/useCheckins.ts'), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports, require: name => modules[name], navigator, Date,
    window: { addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  })
  return { state: exports.useCheckins(), fresh, navigator, get submits() { return submits } }
}

test('old checked-in cache does not prevent server check-in for a new day', async () => {
  const h = harness()
  h.state.summary.value = { ...h.fresh, today: '2026-10-07', checkinDates: ['2026-10-07'] }
  h.state.stale.value = true
  assert.equal(h.state.checkedInToday.value, false)
  await h.state.submitToday()
  assert.equal(h.submits, 1)
  assert.equal(h.state.summary.value.today, '2026-10-08')
  assert.equal(h.state.checkedInToday.value, true)
  await h.state.submitToday()
  assert.equal(h.submits, 1)
})

test('fresh server-confirmed status still blocks repeated submissions', async () => {
  const h = harness()
  await h.state.loadCurrent()
  assert.equal(h.state.checkedInToday.value, true)
  await h.state.submitToday()
  assert.equal(h.submits, 0)
})

test('stale cache never authorizes offline writes', async () => {
  const h = harness()
  h.state.summary.value = h.fresh
  h.state.stale.value = true
  h.navigator.onLine = false
  await h.state.submitToday()
  assert.equal(h.submits, 0)
  assert.equal(h.state.offline.value, true)
})
