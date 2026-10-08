const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const prefix = 'quire_checkin_months_v1'
function harness(storage) {
  const rows = new Map()
  let user = 'account-a'
  const memory = {
    get length() { return rows.size },
    key: index => [...rows.keys()][index] ?? null,
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: key => rows.delete(key),
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/api/checkinCache.ts'), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(code, {
    exports, require: name => { assert.equal(name, './tokenStore'); return { accessTokenSubject: () => user } },
    sessionStorage: storage ?? memory, Date,
  })
  return { api: exports, rows, switchUser: next => { user = next } }
}
function summary(month = 10) {
  return { year: 2026, month, checkinDates: [], today: '2026-10-08', timezone: 'Asia/Shanghai', checkedInToday: false, currentStreak: 0, longestStreak: 0, totalCheckins: 0, updatedAt: 1 }
}

test('blocked storage reads and removals behave as cache misses', () => {
  const blocked = () => { throw new Error('SecurityError') }
  const h = harness({ getItem: blocked, setItem: blocked, removeItem: blocked, key: blocked, get length() { return blocked() } })
  assert.equal(h.api.readCachedCheckinMonth(), null)
  assert.equal(h.api.readCachedCheckinMonth(2026, 10), null)
  assert.doesNotThrow(() => h.api.cacheCheckinMonth(summary()))
  assert.doesNotThrow(() => h.api.clearCheckinCache())
})

test('malformed cached JSON is removed without throwing', () => {
  const h = harness()
  const key = `${prefix}:account-a:2026-10`
  h.rows.set(key, '{broken')
  assert.equal(h.api.readCachedCheckinMonth(2026, 10), null)
  assert.equal(h.rows.has(key), false)
})

test('current-month pointer cannot read a different account cache', () => {
  const h = harness()
  h.rows.set(`${prefix}:account-b:2026-10`, JSON.stringify(summary()))
  h.rows.set(`${prefix}:account-a:current`, `${prefix}:account-b:2026-10`)
  assert.equal(h.api.readCachedCheckinMonth(), null)
  assert.equal(h.rows.has(`${prefix}:account-a:current`), false)
  assert.equal(h.rows.has(`${prefix}:account-b:2026-10`), true)
})

test('valid cache remains isolated and keeps at most six indexed months', () => {
  const h = harness()
  for (let month = 1; month <= 7; month++) h.api.cacheCheckinMonth(summary(month))
  assert.equal(h.api.readCachedCheckinMonth(2026, 1), null)
  assert.equal(h.api.readCachedCheckinMonth(2026, 7).month, 7)
  assert.equal(JSON.parse(h.rows.get(`${prefix}:account-a:index`)).length, 6)
  h.switchUser('account-b')
  assert.equal(h.api.readCachedCheckinMonth(2026, 7), null)
})

test('broken retention index is rebuilt after a successful cache write', () => {
  const h = harness()
  h.rows.set(`${prefix}:account-a:index`, '{broken')
  h.api.cacheCheckinMonth(summary())
  assert.equal(h.api.readCachedCheckinMonth().month, 10)
  assert.equal(JSON.parse(h.rows.get(`${prefix}:account-a:index`)).length, 1)
})
