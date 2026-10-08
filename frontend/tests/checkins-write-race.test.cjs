const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const before = { year: 2026, month: 10, checkinDates: [], today: '2026-10-08', timezone: 'Asia/Shanghai', checkedInToday: false, currentStreak: 0, longestStreak: 0, totalCheckins: 0, updatedAt: 1 }
const success = { checkinDate: '2026-10-08', checkedIn: true, created: true, currentStreak: 1, longestStreak: 1, totalCheckins: 1 }
function harness(getMonthCheckins, checkInToday = async () => success) {
  const cachedWrites = []
  const modules = {
    vue: { ref: value => ({ value }), computed: fn => ({ get value() { return fn() } }), onScopeDispose() {} },
    '@/api/checkinCache': { cacheCheckinMonth: value => cachedWrites.push(value), readCachedCheckinMonth: () => before },
    '@/api/checkins': { getMonthCheckins, checkInToday },
    '@/api/tokenStore': { ACCESS_TOKEN_KEY: 'quire_access_token', accessTokenSubject: () => 'account-a' },
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/composables/useCheckins.ts'), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports, require: name => modules[name], Date, navigator: { onLine: true },
    window: { addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  })
  const state = exports.useCheckins()
  state.summary.value = before
  return { state, cachedWrites }
}

test('successful POST survives failed month refresh and older fallback cache', async () => {
  const h = harness(async () => { throw new Error('read failed') })
  await h.state.submitToday()
  assert.equal(h.state.summary.value.checkedInToday, true)
  assert.equal(h.state.summary.value.totalCheckins, 1)
  assert.equal(h.state.summary.value.checkinDates[0], success.checkinDate)
  assert.equal(h.state.stale.value, true)
  assert.notEqual(h.state.error.value, '')
  assert.equal(h.cachedWrites[0].checkedInToday, true)
  assert.equal(h.state.checkingIn.value, false)
})

test('read started before submit cannot overwrite state during the write', async () => {
  const read = deferred()
  const write = deferred()
  let reads = 0
  const h = harness(async () => {
    if (++reads === 1) return read.promise
    return { ...before, checkinDates: [success.checkinDate], checkedInToday: true, totalCheckins: 1 }
  }, () => write.promise)
  const oldLoad = h.state.loadCurrent()
  const submit = h.state.submitToday()
  assert.equal(h.state.loading.value, false)
  read.resolve({ ...before, totalCheckins: 99 })
  await oldLoad
  assert.equal(h.state.summary.value.totalCheckins, 0)
  write.resolve(success)
  await submit
  assert.equal(h.state.summary.value.totalCheckins, 1)
  assert.equal(h.state.checkedInToday.value, true)
})
