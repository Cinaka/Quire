const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function card(overrides = {}) {
  const props = {
    summary: { year: 2026, month: 9, today: '2026-10-08', checkinDates: [], timezone: 'Asia/Shanghai', updatedAt: 1 },
    loading: false, checkingIn: false, offline: false, stale: false,
    error: '', checkedInToday: false, currentStreak: 0, ...overrides,
  }
  const events = []
  const source = fs.readFileSync(path.join(__dirname, '../src/components/CheckinCard.vue'), 'utf8')
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const code = ts.transpileModule(script + '\nexport { goToCurrentMonth, shiftMonth }', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  const vue = {
    computed: fn => ({ get value() { return fn() } }), ref: value => ({ value }),
    watch() {}, onScopeDispose() {},
  }
  vm.runInNewContext(code, {
    exports, require: name => { assert.equal(name, 'vue'); return vue },
    defineProps: () => props, defineEmits: () => (...args) => events.push(args),
    Date, setTimeout, clearTimeout,
  })
  return { ...exports, events }
}

test('return to current month requests server-selected month without cached year/month', () => {
  const h = card()
  h.goToCurrentMonth()
  assert.deepEqual(h.events, [['currentMonth']])
})

test('next arrow entering the current month also resumes current-month following', () => {
  const h = card()
  h.shiftMonth(1)
  assert.deepEqual(h.events, [['currentMonth']])
})

test('historical month navigation retains an explicit year/month', () => {
  const h = card()
  h.shiftMonth(-1)
  assert.deepEqual(h.events, [['monthChange', 2026, 8]])
})

test('offline and loading states block return-to-current actions', () => {
  for (const overrides of [{ offline: true }, { loading: true }]) {
    const h = card(overrides)
    h.goToCurrentMonth()
    h.shiftMonth(1)
    assert.deepEqual(h.events, [])
  }
})

test('home connects the dedicated current-month event to loadCurrent', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/views/HomeView.vue'), 'utf8')
  assert.match(source, /@current-month="loadCheckins"/)
  assert.match(source, /function loadCheckins\(\): Promise<void> \{ return loadCurrentCheckins\(\) \}/)
})
