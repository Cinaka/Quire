const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { loadTS } = require('./schedules-harness.cjs')
const read = p => fs.readFileSync(path.join(__dirname, '../src', p), 'utf8')
const ref = value => ({ value })
const script = p => require('node:module').stripTypeScriptTypes(read(p).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]).replace(/^import .*$/gm, '')
const settle = async () => { for (let i = 0; i < 18; i++) await Promise.resolve() }
function home(loggedIn = false) {
  const calls = { factories: 0, reminderReads: 0, currentCheckins: 0, submitCheckin: 0, oldMonth: 0, activeCheckin: 0, entries: 0 }
  const navigation = [], watches = [], mounted = []
  const port = { async read() { calls.reminderReads++; throw Error('not called by parent') } }
  const globals = { ref, computed: fn => ({ get value() { return fn() } }),
    watch(source, fn) { watches.push({ source, fn }) }, onMounted(fn) { mounted.push(fn) },
    useRouter: () => ({ push: target => { navigation.push(target); return Promise.resolve() } }),
    isLoggedIn: () => loggedIn, todayLocal: () => '2026-10-20', getAlmanac: () => ({}), entryExcerpt: text => text,
    createScheduleReminderPort() { calls.factories++; return port },
    entryRepo: { async list() { calls.entries++; return { items: [] } }, async countByDate() { return {} } },
    mediaRepo: { async countByEntries() { return {} } },
    useCheckins: () => ({ summary: ref(null), loading: ref(false), checkingIn: ref(false), offline: ref(false), stale: ref(false), error: ref(''), checkedInToday: ref(false), currentStreak: ref(0),
      async load() { calls.oldMonth++ }, async loadCurrent() { calls.currentCheckins++ }, revalidateActive() { calls.activeCheckin++ }, async submitToday() { calls.submitCheckin++ } }), }
  vm.runInNewContext(script('views/HomeView.vue') + '\nglobalThis.bindings = { selectedDate, openSchedules, write, open, showBlockedNotice, notice, loadCheckins, refreshActiveCheckins, scheduleReminderPort };', globals)
  return { ...globals.bindings, calls, port, navigation, watches, mounted }
}
test('home creates one inert reminder port independently of selected diary date and performs no reminder IO itself', () => {
  const h = home(); assert.equal(h.calls.factories, 1); assert.equal(h.calls.reminderReads, 0)
  h.selectedDate.value = '2026-08-01'; h.watches[0].fn()
  assert.equal(h.calls.factories, 1); assert.equal(h.scheduleReminderPort, h.port); assert.equal(h.calls.reminderReads, 0)
})
for (const login of [false, true]) {
  test(`home mount preserves P3 current-month follow and never submits checkin (loggedIn=${login})`, async () => {
    const h = home(login); for (const fn of h.mounted) fn(); await settle()
    assert.equal(h.calls.currentCheckins, login ? 1 : 0); assert.equal(h.calls.submitCheckin, 0)
    assert.equal(h.calls.reminderReads, 0); assert.equal(h.calls.entries, 2)
  })
}
test('home reminder action navigates only to schedules without source/date/action parameters or writes', () => {
  const h = home(); h.selectedDate.value = '2026-01-01'; h.openSchedules()
  assert.equal(h.navigation.length, 1); assert.equal(h.navigation[0], '/schedules')
  assert.equal(h.calls.entries, 0); assert.equal(h.calls.reminderReads, 0); assert.equal(h.calls.submitCheckin, 0)
})
test('ordinary home write and open entry paths remain unchanged and do not trigger reminder navigation', () => {
  const h = home(); h.selectedDate.value = '2026-08-01'; h.write(); h.open('existing-id')
  assert.equal(JSON.stringify(h.navigation[0]), JSON.stringify({ path: '/entry/new', query: { date: '2026-08-01' } }))
  assert.equal(h.navigation[1], '/entry/existing-id'); assert.equal(h.calls.reminderReads, 0)
})
test('blocked future diary notice points to the existing local schedules page without changing diary selection', () => {
  const h = home(); h.showBlockedNotice()
  assert.equal(h.selectedDate.value, '2026-10-20'); assert.equal(h.navigation.length, 0)
  assert.match(h.notice.value, /此处仍只补记已至之日/); assert.match(h.notice.value, /未来文字预简/)
  assert.doesNotMatch(h.notice.value, /预简（待刻）尚未开放/)
})
test('home manual retry still revalidates active P3 month; current-month load stays separate', async () => {
  const h = home(true); h.refreshActiveCheckins(); await h.loadCheckins()
  assert.equal(h.calls.activeCheckin, 1); assert.equal(h.calls.currentCheckins, 1); assert.equal(h.calls.submitCheckin, 0)
})
function panel(port) {
  const hooks = {}, watches = [], timers = new Map(), docEvents = new Map(), winEvents = new Map()
  let counter = 0
  const props = { port, contextKey: 'home-local-reminder' }
  const globals = { defineProps: () => props, defineEmits: () => () => {}, shallowRef: ref,
    onMounted(fn) { hooks.mount = fn }, onBeforeUnmount(fn) { hooks.unmount = fn }, watch(source, notify) { watches.push({ source, notify }) },
    createScheduleReminder: loadTS('shared/scheduleReminder.ts').createScheduleReminder,
    window: { setInterval(fn) { timers.set(++counter, fn); return counter }, clearInterval(id) { timers.delete(id) },
      addEventListener(name, fn) { winEvents.set(name, fn) }, removeEventListener(name) { winEvents.delete(name) } },
    document: { visibilityState: 'visible', addEventListener(name, fn) { docEvents.set(name, fn) }, removeEventListener(name) { docEvents.delete(name) } }, }
  vm.runInNewContext(script('components/schedules/ScheduleReminderPanel.vue') + '\nglobalThis.bindings = { refresh, controller, state };', globals)
  return { ...globals.bindings, hooks, props, watches, timers, docEvents, winEvents, document: globals.document }
}
const summary = day => ({ asOf: day, dueToday: 1, overdue: 2, dueTotal: 3 })
test('actual reused panel mounts read-only refresh/watch and removes every foreground listener on unmount', async () => {
  let reads = 0, stops = 0, changed
  const p = panel({ async read(day) { reads++; return summary(day) }, watch(change) { changed = change; return () => { stops++ } } })
  assert.equal(reads, 0); p.hooks.mount(); await settle()
  assert.equal(p.state.value.status, 'ready'); assert.equal(p.state.value.summary.dueTotal, 3)
  assert.equal(p.timers.size, 1); assert.equal(p.docEvents.size, 1); assert.equal(p.winEvents.size, 1)
  changed(); await settle(); assert.equal(reads, 2)
  p.hooks.unmount(); assert.equal(stops, 1); assert.equal(p.timers.size, 0); assert.equal(p.docEvents.size, 0); assert.equal(p.winEvents.size, 0)
  changed(); await settle(); assert.equal(reads, 2); assert.equal(p.controller.inspect().status, 'disposed')
})
test('watch expiry hides old account counts and later timer/focus events cannot recapture or read a new account', async () => {
  let reads = 0, expired, stops = 0
  const p = panel({ async read(day) { reads++; return summary(day) }, watch(_change, revoke) { expired = revoke; return () => { stops++ } } })
  p.hooks.mount(); await settle(); expired()
  assert.equal(p.state.value.status, 'expired'); assert.equal(p.state.value.summary, null); assert.equal(stops, 1)
  p.winEvents.get('focus')(); for (const fn of p.timers.values()) fn(); await p.refresh(); await settle()
  assert.equal(reads, 1); p.hooks.unmount()
})
test('home reminder read error does not become zero or block independent home navigation/checkin actions', async () => {
  const p = panel({ async read() { throw Error('local storage unavailable') } }); p.hooks.mount(); await settle()
  assert.equal(p.state.value.status, 'error'); assert.equal(p.state.value.summary, null)
  const h = home(true); h.openSchedules(); await h.loadCheckins()
  assert.equal(h.navigation[0], '/schedules'); assert.equal(h.calls.currentCheckins, 1); p.hooks.unmount()
})
test('foreground/focus refresh is reused; hidden poll and hidden visibility do not perform new reads', async () => {
  let reads = 0
  const p = panel({ async read(day) { reads++; return summary(day) } }); p.hooks.mount(); await settle()
  p.document.visibilityState = 'hidden'; for (const fn of p.timers.values()) fn(); p.docEvents.get('visibilitychange')(); await settle(); assert.equal(reads, 1)
  p.document.visibilityState = 'visible'; p.docEvents.get('visibilitychange')(); await settle(); assert.equal(reads, 2)
  p.winEvents.get('focus')(); await settle(); assert.equal(reads, 3); p.hooks.unmount()
})
test('in-place port or context mutation expires panel rather than silently replacing the pinned reader', async () => {
  let reads = 0, otherReads = 0, stops = 0
  const p = panel({ async read(day) { reads++; return summary(day) }, watch() { return () => { stops++ } } }); p.hooks.mount(); await settle()
  p.props.port = { async read(day) { otherReads++; return summary(day) } }; p.watches[0].notify()
  await p.refresh(); assert.equal(p.state.value.status, 'expired'); assert.equal(p.state.value.summary, null)
  assert.equal(reads, 1); assert.equal(otherReads, 0); assert.equal(stops, 1); p.hooks.unmount()
})
test('home wiring has a non-date key, independent fallback entry and no DB/network/reset or automatic conversion', () => {
  const home = read('views/HomeView.vue'), repo = read('repo/index.ts')
  assert.match(home, /context-key="home-local-reminder"/)
  assert.match(home, /<ScheduleReminderPanel :port="scheduleReminderPort".*@open="openSchedules"/)
  assert.match(home, /<button type="button" class="plain accent" @click="openSchedules">预简 \/ 待刻/)
  assert.doesNotMatch(home, /@\/db\/|createLocalScheduleReminderPort|:key=".*[Rr]eminder|syncNow|autoSync|firstSave|\.convert\(|indexedDB|localStorage/)
  assert.match(repo, /export const createScheduleReminderPort = createLocalScheduleReminderPort/)
  assert.doesNotMatch(repo, /scheduleSyncRepo|schedulePushRepo|scheduleConversionRepo/)
})
test('home keeps P3 current-month event wiring and historical diary date maximum unchanged', () => {
  const home = read('views/HomeView.vue')
  assert.match(home, /@current-month="loadCheckins"/); assert.match(home, /:max="today" @blocked="showBlockedNotice"/)
  assert.match(home, /if \(loggedIn.value\) void loadCheckins\(\)/)
  assert.match(home, /loadCurrent: loadCurrentCheckins/); assert.match(home, /revalidateActiveCheckins\(true\)/)
})
