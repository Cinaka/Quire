const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { loadTS } = require('./schedules-harness.cjs')
const source = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')
const factory = () => loadTS('shared/scheduleRouteLeave.ts').createScheduleRouteLeave
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
for (const result of [true, false, undefined, null, 1, 'true']) {
  test(`route leave accepts only explicit boolean true (${String(result)})`, async () => {
    let calls = 0; const host = { async prepareLeave() { calls++; return result } }
    const guard = factory()(() => host)
    assert.equal(await guard.attempt(), result === true); assert.equal(calls, 1)
    assert.equal(guard.inspect().busy, false)
    if (result !== true) assert.match(guard.inspect().error, /编辑区/)
  })
}
test('null mounting ref fails closed and can recover after a host mounts', async () => {
  let host = null; const guard = factory()(() => host)
  assert.equal(await guard.attempt(), false); assert.match(guard.inspect().error, /尚未就绪/)
  host = { async prepareLeave() { return true } }
  assert.equal(await guard.attempt(), true)
})
test('concurrent navigation is rejected rather than sharing approval across destinations', async () => {
  const waiting = gate(); let calls = 0
  const guard = factory()(() => host)
  const host = { async prepareLeave() { calls++; await waiting.promise; return true } }
  const first = guard.attempt(); assert.equal(await guard.attempt(), false); assert.equal(calls, 1)
  waiting.release(); assert.equal(await first, true)
  assert.equal(await guard.attempt(), true); assert.equal(calls, 2)
})
for (const change of ['unmount', 'replace', 'null']) {
  test(`${change} during check cannot approve a stale host result`, async () => {
    const waiting = gate(); let host = { async prepareLeave() { await waiting.promise; return true } }
    const guard = factory()(() => host); const work = guard.attempt()
    if (change === 'unmount') guard.dispose()
    else host = change === 'replace' ? { async prepareLeave() { return true } } : null
    waiting.release(); assert.equal(await work, false)
  })
}
for (const throwsAt of ['capture', 'leave', 'recheck']) {
  test(`${throwsAt} exception is contained without discarding any input`, async () => {
    let calls = 0; const host = { async prepareLeave() { if (throwsAt === 'leave') throw Error('private storage detail'); return true } }
    const guard = factory()(() => { calls++; if (throwsAt === 'capture' || (throwsAt === 'recheck' && calls > 1)) throw Error('private'); return host })
    assert.equal(await guard.attempt(), false); assert.match(guard.inspect().error, /已保留当前页面/)
    assert.doesNotMatch(guard.inspect().error, /private/)
  })
}
test('cancelled navigation stores no destination and does not auto-resume when the user later handles edits', async () => {
  let allow = false; let calls = 0
  const guard = factory()(() => ({ async prepareLeave() { calls++; return allow } }))
  // root identity intentionally changes every read, so approval must also fail closed.
  assert.equal(await guard.attempt(), false); allow = true
  await Promise.resolve(); assert.equal(calls, 1)
  assert.equal(await guard.attempt(), false)
})
test('guard inspector is copied and disposal prevents new work', async () => {
  let calls = 0; const host = { async prepareLeave() { calls++; return true } }
  const guard = factory()(() => host); const state = guard.inspect(); state.disposed = true
  assert.equal(await guard.attempt(), true); guard.dispose(); guard.dispose()
  assert.equal(await guard.attempt(), false); assert.equal(calls, 1)
})
// Runtime evaluation of the actual route script with Vue/router hooks mocked; not a browser mount.
function routeScript(runtime) {
  const hooks = {}; const refs = []
  const text = source('views/ScheduleView.vue').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const code = require('node:module').stripTypeScriptTypes(text).replace(/^import .*$/gm, '')
  const globals = {
    ref(value) { const ref = { value }; refs.push(ref); return ref },
    onBeforeRouteLeave(fn) { hooks.leave = fn }, onBeforeRouteUpdate(fn) { hooks.update = fn },
    onBeforeUnmount(fn) { hooks.unmount = fn }, createScheduleRouteLeave: factory(),
    scheduleSyncRuntime: runtime ?? { inspect: () => ({ enabled: false, busy: false }), subscribe: () => () => {}, acquireManualReview: () => () => {}, pause() {} },
  }
  vm.runInNewContext(code + "\nglobalThis.actions = { openConflicts, closeConflicts, pauseForReview }", globals)
  return { hooks, host: refs[0], notice: refs[1], actions: globals.actions, refs }
}
test('actual route script delegates leave, shows blocked notice and permits retry only after user action', async () => {
  const r = routeScript(); let allow = false; let calls = 0
  r.host.value = { async prepareLeave() { calls++; return allow } }
  assert.equal(await r.hooks.leave(), false); assert.match(r.notice.value, /编辑区/)
  allow = true; assert.equal(calls, 1)
  assert.equal(await r.hooks.leave(), true); assert.equal(r.notice.value, '')
})
test('actual route query/hash changes keep the same host and do not execute embedded action/source parameters', () => {
  const r = routeScript(); let calls = 0
  const host = { async prepareLeave() { calls++; return true } }; r.host.value = host
  assert.equal(r.hooks.update({ query: { convert: 'yes', source: 'foreign' }, hash: '#entry' }), true)
  assert.equal(r.host.value, host); assert.equal(calls, 0)
})
test('actual route unmount rejects late approval and null ref cannot bypass checks', async () => {
  const r = routeScript(); assert.equal(await r.hooks.leave(), false)
  const waiting = gate(); r.host.value = { async prepareLeave() { await waiting.promise; return true } }
  const work = r.hooks.leave(); r.hooks.unmount(); waiting.release()
  assert.equal(await work, false)
})
function hostPort() {
  const calls = { read: 0, write: 0, capture: 0, watch: 0, stop: 0 }
  const context = { ownerUserId: 'A', generation: 'epoch', authSubject: 'A', authGeneration: 1 }
  const port = { async capture() { calls.capture++; return context }, async validate() {}, workspace() { return {} },
    watch() { calls.watch++; return () => { calls.stop++ } }, async firstSaveFrame() { calls.read++; return null },
    async firstSave() { calls.write++; throw Error('must not write') }, }
  return { port, calls }
}
test('formal host option disables both initial ordinary-draft reading and all first-save bridge commands', async () => {
  const h = hostPort(); const options = { firstSaveEnabled: false }
  const host = loadTS('shared/scheduleHost.ts').createScheduleHost(h.port, () => '2026-10-08', options)
  options.firstSaveEnabled = true
  assert.equal(await host.initialize(), true); assert.equal(host.inspect().ready, true)
  assert.equal(h.calls.read, 0); assert.equal(await host.refreshDraft(), false)
  assert.equal(host.preview('2026-10-09'), false); assert.equal(await host.confirmFirstSave(), false)
  assert.equal(h.calls.write, 0); host.dispose(); assert.equal(h.calls.stop, 1)
})
test('default injected acceptance host retains its existing ordinary-draft reading behavior', async () => {
  const h = hostPort(); const host = loadTS('shared/scheduleHost.ts').createScheduleHost(h.port)
  assert.equal(await host.initialize(), true); assert.equal(h.calls.read, 1)
  await host.refreshDraft(); assert.equal(h.calls.read, 2); host.dispose()
})
test('formal route exposes local-only workflow through repo facade, with no raw writes, first-save bridge or automatic sync', () => {
  const view = source('views/ScheduleView.vue'); const repo = source('repo/index.ts')
  assert.match(view, /from "@\/repo"/); assert.match(view, /<ScheduleHost v-show="!conflictOpen" ref="hostRef"/)
  assert.match(view, /:first-save-enabled="false"/); assert.match(view, /onBeforeRouteLeave/)
  assert.match(view, /日程同步需在云笺明确启用本次会话/)
  assert.doesNotMatch(view, /@\/db\/|useRoute\(|:key=|router\.push|syncNow|autoSync|setInterval|fetch\(|localStorage/)
  assert.match(repo, /export const scheduleHostRepo = localScheduleHostRepo/)
  assert.doesNotMatch(repo, /scheduleSyncRepo|schedulePushRepo|scheduleConversionRepo|scheduleFirstSaveRepo/)
  assert.match(source('App.vue'), /RouterLink to="\/schedules"/)
})
test('formal view never mounts isolated fixtures or raw internal resource/terminal resolvers', () => {
  const view = source('views/ScheduleView.vue')
  assert.doesNotMatch(view, /acceptance|seed|fixture|5179|5181|5182|clearDatabase|ResourceWorkspacePanel|TerminalBlockedObserver/)
  assert.match(source('router/index.ts'), /path: "\/schedules", name: "schedules"/)
})
test('schedule IME blocks save/discard/leave and unload until composition-end nextTick, preserving visible text on expiry', () => {
  const panel = source('components/schedules/ScheduleEditorPanel.vue')
  assert.match(panel, /@compositionstart.capture="compositionStarted"/)
  assert.match(panel, /@compositionend.capture="compositionEnded"/)
  assert.match(panel, /await nextTick\(\)/)
  assert.match(panel, /return !composing.value.*panel.prepareLeave/)
  assert.match(panel, /if \(!composing.value && await panel.submit\(\)\)/)
  assert.match(panel, /if \(composing.value\) return/)
  assert.match(panel, /return composing.value \|\| Boolean\(editorError.value\)/)
  assert.match(panel, /compositionUnconfirmed.value = true/)
  assert.match(panel, /副本可能没有最后输入/)
})

function schedulePanelScript() {
  const waiting = gate(); const watchers = []; const hooks = {}; const calls = { submit: 0, flush: 0, discard: 0, confirms: 0 }
  const props = { session: {}, expired: false }
  const panelState = { body: { remindDate: '2026-10-09', title: '编辑中', content: null }, busy: false, closed: false, expired: false }
  let subscriber = () => {}
  const panel = { inspect: () => structuredClone(panelState), subscribe(fn) { subscriber = fn; return () => {} },
    async submit() { calls.submit++; return true }, async prepareLeave() { calls.flush++; return true },
    async discardConfirmed() { calls.discard++; return true }, freeze() { panelState.expired = true; subscriber() },
    needsLeaveConfirmation: () => panelState.expired, dispose() {}, }
  const code = require('node:module').stripTypeScriptTypes(source('components/schedules/ScheduleEditorPanel.vue').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]).replace(/^import .*$/gm, '')
  const globals = { structuredClone, defineProps: () => props, defineEmits: () => () => {}, defineExpose() {},
    ref: value => ({ value }), computed: fn => ({ get value() { return fn() } }),
    watch(read, notify, options) { watchers.push({ read, notify }); if (options.immediate) notify(read()) },
    onBeforeUnmount(fn) { hooks.unmount = fn }, nextTick: () => waiting.promise,
    createScheduleEditorPanel: () => panel, assertScheduleEditorContent() {},
    window: { confirm() { calls.confirms++; return true } }, }
  vm.runInNewContext(code + '\nglobalThis.actions = { compositionStarted, compositionEnded, save, discard, prepareLeave, needsLeaveConfirmation, composing, compositionUnconfirmed };', globals)
  return { ...globals.actions, props, calls, waiting, hooks, expire() { props.expired = true; for (const w of watchers) w.notify(w.read()) } }
}
test('actual schedule panel blocks route flush/save/discard throughout IME completion nextTick', async () => {
  const p = schedulePanelScript(); p.compositionStarted()
  assert.equal(await p.prepareLeave(), false); await p.save(); await p.discard()
  assert.equal(p.needsLeaveConfirmation(), true); assert.deepEqual(p.calls, { submit: 0, flush: 0, discard: 0, confirms: 0 })
  const ending = p.compositionEnded(); assert.equal(await p.prepareLeave(), false)
  p.waiting.release(); await ending
  assert.equal(await p.prepareLeave(), true); await p.save(); assert.equal(p.calls.flush, 1); assert.equal(p.calls.submit, 1)
})
test('new composition cannot be unlocked by an older composition-end tick', async () => {
  const p = schedulePanelScript(); p.compositionStarted(); const ending = p.compositionEnded()
  p.compositionStarted(); p.waiting.release(); await ending
  assert.equal(p.composing.value, true); assert.equal(await p.prepareLeave(), false)
})
test('context expiry during IME warns that copy may omit final input and still requires explicit handling', () => {
  const p = schedulePanelScript(); p.compositionStarted(); p.expire()
  assert.equal(p.compositionUnconfirmed.value, true); assert.equal(p.composing.value, false)
  assert.equal(p.needsLeaveConfirmation(), true); assert.equal(p.calls.discard, 0)
})

// Actual formal route script, mocked Vue hooks; no browser/IndexedDB proof.
function reviewRuntime() {
  const state = { enabled: false, busy: false, reviewing: false }; let releases = 0, pauses = 0
  return { state, get releases() { return releases }, get pauses() { return pauses }, inspect: () => ({ ...state }), subscribe: () => () => {},
    pause() { pauses++; state.enabled = false }, acquireManualReview() { if (state.enabled || state.busy || state.reviewing) return null; state.reviewing = true; let held = true; return () => { if (held) { held = false; state.reviewing = false; releases++ } } } }
}
test('formal review requires explicit pause and still waits for an in-flight cycle; pause never auto opens', async () => {
  const runtime = reviewRuntime(), r = routeScript(runtime); let leaves = 0
  r.host.value = { async prepareLeave() { leaves++; return true }, capturedContext: () => ({ ownerUserId: 'A' }), async refresh() {} }
  runtime.state.enabled = true; await r.actions.openConflicts(); assert.equal(leaves, 0); assert.match(r.notice.value, /暂停/)
  runtime.state.busy = true; r.actions.pauseForReview(); assert.equal(runtime.pauses, 1); assert.equal(runtime.state.reviewing, false)
  await r.actions.openConflicts(); assert.equal(leaves, 0); assert.equal(runtime.state.reviewing, false)
  runtime.state.busy = false; assert.equal(runtime.state.reviewing, false)
  await r.actions.openConflicts(); assert.equal(leaves, 1); assert.equal(runtime.state.reviewing, true)
  await r.actions.closeConflicts(); assert.equal(runtime.releases, 1); assert.equal(runtime.state.enabled, false)
})
test('sync enabling while original edit leave check awaits cannot enter the review center', async () => {
  const runtime = reviewRuntime(), r = routeScript(runtime), wait = gate()
  r.host.value = { async prepareLeave() { await wait.promise; return true }, capturedContext: () => ({ ownerUserId: 'A' }), async refresh() {} }
  const work = r.actions.openConflicts(); runtime.state.enabled = true; wait.release(); await work
  assert.equal(runtime.state.reviewing, false); assert.match(r.notice.value, /状态.*变化/)
})
test('review ownership is released on route unmount and never resumes sync or releases twice', async () => {
  const runtime = reviewRuntime(), r = routeScript(runtime)
  r.host.value = { async prepareLeave() { return true }, capturedContext: () => ({ ownerUserId: 'A' }), async refresh() {} }
  await r.actions.openConflicts(); assert.equal(runtime.state.reviewing, true)
  r.hooks.unmount(); r.hooks.unmount(); assert.equal(runtime.releases, 1); assert.equal(runtime.state.enabled, false)
})
