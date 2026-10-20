const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { loadTS } = require('./schedules-harness.cjs')
const { setup, AT, content } = require('./schedules-data-harness.cjs')
const read = p => fs.readFileSync(path.join(__dirname, '../src', p), 'utf8')
const script = p => require('node:module').stripTypeScriptTypes(read(p).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]).replace(/^import .*$/gm, '')
const TODAY = '2026-10-08', FUTURE = '2026-10-09'
const draft = extra => ({ entryId: null, entryDate: TODAY, title: '保留原稿', mood: null, weather: null, tagIds: [], doc: content('原文').doc, updatedAt: AT, ...extra })
function fixture() {
  const h = setup({ '@/shared/time': { ...loadTS('shared/time.ts'), todayLocal: () => TODAY } })
  h.mocks['@/api/tokenStore'] = h.tokens
  return { ...h, destination: h.load('db/entryNewDestinationRepo.ts').readEntryNewDestination }
}
const snapshot = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([key, store]) => [key, [...store.rows.values()]])))
for (const date of [undefined, TODAY, '2026-01-01']) test(`ordinary new ${date} retains legacy destination without writes`, async () => {
  const h = fixture(), before = snapshot(h)
  assert.equal((await h.destination(date)).mode, 'diary'); assert.equal(snapshot(h), before)
})
for (const original of [undefined, draft(), draft({ entryDate: FUTURE }), draft({ entryId: 'existing-id' })]) test(`future request preserves ${JSON.stringify(original?.entryId)} original draft and only pins a destination`, async () => {
  const h = fixture(); if (original) await h.db.meta.put({ key: 'draft', value: original })
  const before = snapshot(h), result = await h.destination(FUTURE)
  assert.equal(result.mode, 'schedule'); assert.equal(result.date, FUTURE)
  assert.equal(result.firstSave, original?.entryId === null); assert.equal(result.context.authSubject, 'account-a')
  assert.equal(snapshot(h), before)
})
for (const date of [undefined, TODAY, '2026-01-01']) test(`future unlinked original cannot enter automatic Entry saver via ${date}`, async () => {
  const h = fixture(); await h.db.meta.put({ key: 'draft', value: draft({ entryDate: FUTURE, mood: '保留', tagIds: ['private-tag'] }) })
  const before = snapshot(h), result = await h.destination(date)
  assert.equal(result.mode, 'schedule'); assert.equal(result.firstSave, true); assert.equal(result.date, FUTURE)
  assert.equal(snapshot(h), before)
})
for (const date of [null, [], [FUTURE], '', '2026-02-30', 'tomorrow', 99]) test(`invalid query ${JSON.stringify(date)} never falls back to today`, async () => {
  const h = fixture(), before = snapshot(h); await assert.rejects(h.destination(date)); assert.equal(snapshot(h), before)
})
for (const original of [null, [], {}, draft({ unknown: true }), draft({ entryDate: 'bad' })]) test(`unsupported original ${JSON.stringify(original)} is preserved and fails closed`, async () => {
  const h = fixture(); await h.db.meta.put({ key: 'draft', value: original }); const before = snapshot(h)
  await assert.rejects(h.destination(FUTURE)); assert.equal(snapshot(h), before)
})
test('login switch during read rejects instead of pinning another account', async () => {
  const h = fixture(), get = h.db.meta.get
  h.db.meta.get = async key => { const value = await get(key); if (key === 'draft') h.user('account-b'); return value }
  await assert.rejects(h.destination(FUTURE), /上下文/)
  assert.equal(h.db.entries.rows.size, 0); assert.equal(h.db.schedules.rows.size, 0)
})
test('mismatched local owner is not silently claimed by landing', async () => {
  const h = fixture(); await h.db.meta.put({ key: 'ownerUserId', value: 'account-b' }); const before = snapshot(h)
  await assert.rejects(h.destination(FUTURE), /归属/); assert.equal(snapshot(h), before)
})
const ref = value => ({ value })
function landing(requestedDate, reader) {
  const hooks = {}, globals = { ref, useRoute: () => ({ query: { date: requestedDate } }),
    onMounted: fn => { hooks.mount = fn }, onBeforeUnmount: fn => { hooks.unmount = fn },
    onBeforeRouteLeave: fn => { hooks.leave = fn }, onBeforeRouteUpdate: fn => { hooks.update = fn },
    entryNewDestination: { read: reader }, createScheduleRouteLeave: loadTS('shared/scheduleRouteLeave.ts').createScheduleRouteLeave }
  vm.runInNewContext(script('views/EntryNewView.vue') + '\nglobalThis.bindings={destination,error,notice,hostRef};', globals)
  return { ...globals.bindings, hooks }
}
test('wrapper stays inert until readonly decision and never installs late mount results', async () => {
  let release; const h = landing(FUTURE, () => new Promise(resolve => { release = resolve }))
  const work = h.hooks.mount(); assert.equal(h.destination.value, null)
  h.hooks.unmount(); release({ mode: 'diary' }); await work; assert.equal(h.destination.value, null)
})
test('landing error does not mount ordinary autosaver or expose original exception', async () => {
  const h = landing(FUTURE, async () => { throw Error('private original content') }); await h.hooks.mount()
  assert.equal(h.destination.value, null); assert.match(h.error.value, /未挂载自动保存器/); assert.doesNotMatch(h.error.value, /private/)
})
test('future route delegates leave to mounted host, cancels concurrent and unready navigation', async () => {
  const h = landing(FUTURE, async () => ({ mode: 'schedule', date: FUTURE, firstSave: false, context: {} })); await h.hooks.mount()
  assert.equal(await h.hooks.leave(), false)
  let release; h.hostRef.value = { prepareLeave: () => new Promise(resolve => { release = resolve }) }
  const first = h.hooks.leave(); assert.equal(await h.hooks.leave(), false); release(true); assert.equal(await first, true)
})
test('same route cannot silently change date; ordinary child keeps its own leave guard', async () => {
  const h = landing(TODAY, async () => ({ mode: 'diary' })); await h.hooks.mount()
  assert.equal(h.hooks.update({ query: { date: FUTURE } }), false)
  assert.equal(h.hooks.update({ query: { date: TODAY } }), true); assert.equal(await h.hooks.leave(), true)
})
function navigator(max) {
  const events = [], props = { modelValue: TODAY, max }, globals = { ref, defineProps: () => props, defineEmits: () => (...args) => events.push(args), ...loadTS('shared/time.ts') }
  vm.runInNewContext(script('components/HomeDateNavigator.vue') + '\nglobalThis.bindings={choose,step};', globals)
  return { ...globals.bindings, events }
}
test('uncapped home navigator accepts future dates and steps across today', () => {
  const h = navigator(); h.choose(FUTURE); h.step(1)
  assert.equal(JSON.stringify(h.events), JSON.stringify([['update:modelValue', FUTURE], ['update:modelValue', FUTURE]]))
  h.choose('2026-02-30'); assert.equal(h.events.length, 2)
})
test('other capped navigator callers still reject future selection and step', () => {
  const h = navigator(TODAY); h.choose(FUTURE); h.step(1); assert.equal(JSON.stringify(h.events), JSON.stringify([['blocked'], ['blocked']]))
})
test('host uses immutable supplied landing context and never recaptures on validation failure', async () => {
  const context = { ownerUserId: '', generation: '', authSubject: 'old', authGeneration: 1 }
  let captures = 0, workspace = 0, seen
  const port = { capture: async () => { captures++; return {} }, validate: async value => { seen = value; throw Error('changed') }, workspace() { workspace++ } }
  const host = loadTS('shared/scheduleHost.ts').createScheduleHost(port, () => TODAY, { firstSaveEnabled: false, context })
  context.authSubject = 'new'; assert.equal(await host.initialize(), false)
  assert.equal(seen.authSubject, 'old'); assert.equal(captures, 0); assert.equal(workspace, 0)
})
test('formal routing isolates legacy autosaver; existing entry route stays unchanged', () => {
  const router = read('router/index.ts'), wrapper = read('views/EntryNewView.vue'), workspace = read('components/schedules/ScheduleWorkspace.vue')
  assert.match(router, /name: "entry-new", component: \(\) => import\("@\/views\/EntryNewView.vue"\)/)
  assert.match(router, /name: "entry-edit", component: \(\) => import\("@\/views\/EntryEditView.vue"\)/)
  assert.match(wrapper, /<EntryEditView v-if="destination\?\.mode === 'diary'"/)
  assert.match(workspace, /recovery\?\.status === "empty"\) await workspace.openNew\(initialComposeDate\)/)
  assert.doesNotMatch(wrapper, /entryRepo\.|draftRepo\.|syncNow|localStorage|setTimeout|\.convert\(/)
})
for (const status of ['empty', 'recoverable', 'conflict', 'alreadySaved', 'sourceUnavailable']) test(`actual workspace initial compose respects ${status} draft slot`, async () => {
  let mount, unmount, opens = [], initializeResolve
  const props = { initialComposeDate: FUTURE, contextKey: 'fixed', port: {} }
  const state = { today: TODAY, recovery: { status }, query: { pageSize: 20 }, busy: false, loading: false }
  const workspace = { inspect: () => state, subscribe: () => () => {}, editorSession: () => null,
    initialize: () => new Promise(resolve => { initializeResolve = resolve }), async openNew(date) { opens.push(date) },
    dispose() {}, invalidate() {} }
  const globals = { defineProps: () => props, defineEmits: () => () => {}, ref, shallowRef: ref, reactive: value => value, computed: fn => ({ get value() { return fn() } }),
    createScheduleWorkspace: () => workspace, addLocalDays: () => FUTURE, watch() {}, defineExpose() {},
    onMounted: fn => { mount = fn }, onBeforeUnmount: fn => { unmount = fn },
    window: { setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {} } }
  vm.runInNewContext(script('components/schedules/ScheduleWorkspace.vue'), globals)
  mount(); props.initialComposeDate = '2099-01-01'; initializeResolve(true)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.deepEqual(opens, status === 'empty' ? [FUTURE] : []); unmount()
})
