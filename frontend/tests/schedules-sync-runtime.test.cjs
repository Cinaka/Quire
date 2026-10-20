const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { loadTS } = require('./schedules-harness.cjs')
const { setup, ID, schedule } = require('./schedules-data-harness.cjs')
const pin = () => ({ ownerUserId: 'account-a', generation: '', authSubject: 'account-a', authGeneration: 0 })
const pending = extra => ({ dirty: 0, conversions: 0, conflicts: 0, pullContinuation: false, ...extra })
const cycle = extra => ({ unsupported: false, failed: false, blocked: false, pending: pending(), more: false, ...extra })
const settle = async () => { for (let i = 0; i < 70; i++) await Promise.resolve() }
function fixture(options = {}) {
  const timers = new Map(), calls = [], h = { online: true, foreground: true, result: cycle(), ...options }; let serial = 0, changed, expired
  const port = { async capture() { calls.push('capture'); return options.capture ? options.capture() : pin() }, async verify(ctx) { calls.push('verify'); if (h.invalid) throw Error('changed'); assert.equal(ctx.authSubject, 'account-a') },
    async run(ctx, active) { calls.push('run'); if (options.run) return options.run(ctx, active); return h.result },
    watch(ctx, change, expire) { calls.push('watch'); changed = change; expired = expire; if (options.expireInWatch) expire(); return () => calls.push('unwatch') },
    online: () => h.online, foreground: () => h.foreground,
    later(work, ms) { const id = ++serial; timers.set(id, { work, ms }); return id }, clear(id) { timers.delete(id) } }
  const runtime = loadTS('shared/scheduleSyncRuntime.ts').createScheduleSyncRuntime(port)
  return { h, runtime, calls, timers, changed: () => changed(), expired: () => expired(), async flush() { const [id, task] = [...timers][0] ?? []; if (!task) return false; timers.delete(id); task.work(); await settle(); return true } }
}
test('construction and subscription never capture, start timers or issue requests', () => {
  const h = fixture(); h.runtime.subscribe(() => {}); assert.deepEqual(h.calls, []); assert.equal(h.timers.size, 0); assert.equal(h.runtime.inspect().enabled, false)
})
test('explicit enable pins a single session and starts one bounded cycle', async () => {
  const h = fixture(); assert.equal(await h.runtime.enable(), true); assert.equal(h.calls.filter(x => x === 'run').length, 0)
  await h.flush(); assert.equal(h.calls.filter(x => x === 'run').length, 1); assert.equal(h.runtime.inspect().phase, 'ready'); assert.equal(h.timers.size, 0)
})
test('state inspector is copied and a broken subscriber cannot abort synchronization', async () => {
  const h = fixture(); let updates = 0; h.runtime.subscribe(() => { throw Error('view') }); h.runtime.subscribe(() => updates++)
  const s = h.runtime.inspect(); s.enabled = true; await h.runtime.enable(); await h.flush(); assert.ok(updates > 0); assert.equal(h.runtime.inspect().phase, 'ready')
})
test('offline enable preserves data, performs no run, then online signal schedules once', async () => {
  const h = fixture({ online: false }); await h.runtime.enable(); assert.equal(h.runtime.inspect().phase, 'offline'); assert.equal(h.timers.size, 0)
  h.h.online = true; h.runtime.request(0); h.runtime.request(0); assert.equal(h.timers.size, 1); await h.flush(); assert.equal(h.runtime.inspect().phase, 'ready')
})
test('hidden pages do not run; visible signal resumes after opt-in only', async () => {
  const h = fixture({ foreground: false }); await h.runtime.enable(); assert.equal(h.timers.size, 0); assert.equal(await h.runtime.runNow(), false)
  h.h.foreground = true; h.runtime.request(0); await h.flush(); assert.equal(h.calls.filter(x => x === 'run').length, 1)
})
test('change signals coalesce without replacing an existing retry/backoff timer', async () => {
  const h = fixture(); await h.runtime.enable(); await h.flush(); h.h.result = cycle({ failed: true }); await h.runtime.runNow()
  assert.equal([...h.timers.values()][0].ms, 15000); h.changed(); h.runtime.request(0); assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].ms, 15000)
})
test('network/storage unconfirmed gets at most three automatic retries then explicit retry is required', async () => {
  const h = fixture({ result: cycle({ failed: true }) }); await h.runtime.enable(); await h.flush()
  for (const delay of [15000, 30000, 60000]) { assert.equal([...h.timers.values()][0].ms, delay); await h.flush() }
  assert.equal(h.calls.filter(x => x === 'run').length, 4); assert.equal(h.runtime.inspect().phase, 'blocked'); h.runtime.request(0); assert.equal(h.timers.size, 0)
  h.h.result = cycle(); await h.runtime.runNow(); assert.equal(h.runtime.inspect().phase, 'ready')
})
for (const flag of ['unsupported', 'blocked']) test(`${flag} stops automatic changes/foreground retry but retains explicit recovery`, async () => {
  const h = fixture({ result: cycle({ [flag]: true }) }); await h.runtime.enable(); await h.flush(); assert.equal(h.runtime.inspect().phase, flag)
  h.changed(); h.runtime.request(0); assert.equal(h.timers.size, 0)
  h.h.result = cycle(); await h.runtime.runNow(); assert.equal(h.runtime.inspect().phase, 'ready')
})
test('large queues continue at most five times after the first cycle, not forever', async () => {
  const h = fixture({ result: cycle({ more: true, pending: pending({ dirty: 100 }) }) }); await h.runtime.enable()
  for (let i = 0; i < 6; i++) assert.equal(await h.flush(), true)
  assert.equal(h.calls.filter(x => x === 'run').length, 6); assert.equal(h.timers.size, 0); assert.equal(h.runtime.inspect().phase, 'blocked')
})
test('a change while busy is coalesced into a later bounded cycle without parallel requests', async () => {
  let release; const h = fixture({ run: () => new Promise(r => { release = r }) }); await h.runtime.enable(); await h.flush()
  assert.equal(h.runtime.inspect().busy, true); h.changed(); assert.equal(await h.runtime.runNow(), false); assert.equal(h.calls.filter(x => x === 'run').length, 1)
  release(cycle()); await settle(); assert.equal(h.timers.size, 1)
})
test('pause keeps in-flight busy, ignores late result, removes watcher and never auto rebinds', async () => {
  let release, alive; const h = fixture({ run: (_ctx, active) => { alive = active; return new Promise(r => { release = r }) } }); await h.runtime.enable(); await h.flush()
  h.runtime.pause(); assert.equal(alive(), false); assert.equal(h.runtime.inspect().busy, true); assert.equal(await h.runtime.enable(), false)
  release(cycle()); await settle(); assert.equal(h.runtime.inspect().phase, 'paused'); assert.equal(h.runtime.inspect().pending, null); assert.equal(h.timers.size, 0); assert.ok(h.calls.includes('unwatch'))
})
test('owner/auth/restore watcher expiry clears old counts and disables old session', async () => {
  const h = fixture(); await h.runtime.enable(); await h.flush(); h.expired(); h.runtime.request(0)
  assert.equal(h.runtime.inspect().phase, 'expired'); assert.equal(h.runtime.inspect().pending, null); assert.equal(h.runtime.inspect().enabled, false); assert.equal(h.timers.size, 0)
})
test('synchronous watch expiry releases its eventual unsubscribe and cannot schedule a run', async () => {
  const h = fixture({ expireInWatch: true }); assert.equal(await h.runtime.enable(), false); assert.equal(h.timers.size, 0); assert.ok(h.calls.includes('unwatch'))
})
test('pause while enable capture awaits never installs that old context', async () => {
  let release; const h = fixture({ capture: () => new Promise(r => { release = r }) }), work = h.runtime.enable()
  h.runtime.pause(); release(pin()); assert.equal(await work, false); assert.equal(h.calls.includes('watch'), false); assert.equal(h.runtime.inspect().enabled, false)
})
for (const ctx of [{ ...pin(), ownerUserId: '' }, { ...pin(), ownerUserId: 'other' }]) test(`guest/foreign capture cannot authorize automatic requests (${ctx.ownerUserId})`, async () => {
  const h = fixture({ capture: async () => ctx }); assert.equal(await h.runtime.enable(), false); assert.equal(h.calls.includes('watch'), false); assert.equal(h.timers.size, 0)
})
test('old coordinator cannot capture a new owner/epoch under an expected formal lease', async () => {
  const h = setup(); h.mocks['@/api/tokenStore'] = h.tokens; await h.db.meta.put({ key: 'ownerUserId', value: 'account-a' })
  let requests = 0; const transport = { async pushSource() { requests++ }, async convert() { requests++ }, async push() { requests++ }, async pull() { requests++ } }
  const run = h.load('db/scheduleSyncRepo.ts').createInternalScheduleSyncCoordinator({ conversion: transport, push: transport, pull: transport }, { ownerUserId: 'account-a', generation: 'old', tokenGeneration: 0 })
  const result = await run.runOnce(); assert.equal(result.stopped, true); assert.equal(requests, 0); assert.equal(h.db.schedules.rows.size, 0)
})
class ApiError extends Error { constructor(status) { super('private'); this.status = status; this.code = status } }
for (const type of ['Push', 'Pull', 'Conversion']) for (const status of [404, 405, 501]) test(`${type} unavailable endpoint ${status} notifies runtime without changing legacy error behavior`, async () => {
  let unavailable = 0
  const request = { ApiError, async postPinnedSchedule() { throw new ApiError(status) }, async getPinnedScheduleChanges() { throw new ApiError(status) } }
  const adapter = loadTS(`api/schedule${type}Transport.ts`, { './request': request })[`createSchedule${type}Transport`](() => unavailable++)
  const work = type === 'Push' ? adapter.push({}, {}) : type === 'Pull' ? adapter.pull({}, {}) : adapter.pushSource({ schedules: [{ id: ID }] }, {})
  await assert.rejects(work); assert.equal(unavailable, 1)
})
test('conversion 404 for a specific existing resource is not automatically diagnosed as old backend', async () => {
  let unavailable = 0; const request = { ApiError, async postPinnedSchedule() { throw new ApiError(404) } }
  const adapter = loadTS('api/scheduleConversionTransport.ts', { './request': request }).createScheduleConversionTransport(() => unavailable++)
  await assert.rejects(adapter.convert(ID, {}, {})); assert.equal(unavailable, 0)
})
const source = p => fs.readFileSync(path.join(__dirname, '../src', p), 'utf8')
test('formal panel scopes completion and startup is opt-in without modifying ordinary P2 scheduler', () => {
  assert.match(source('App.vue'), /onMounted\(\(\) => \{ stopScheduleRuntime = installScheduleSyncRuntime\(\)/)
  assert.match(source('components/schedules/ScheduleSyncPanel.vue'), /明确启用本次会话日程同步/)
  assert.match(source('views/SyncView.vue'), /本轮P2同步结束；日程请查看下方独立状态/)
  assert.doesNotMatch(source('api/scheduleSyncRuntime.ts'), /runSync\(|emitBackgroundSync|localStorage|\.clear\(|\.delete\(/)
})
function apiFixture(options = {}) {
  const listeners = new Map(), timers = new Map(), calls = [], doc = { visibilityState: 'visible', addEventListener(name, fn) { listeners.set('doc:' + name, fn) }, removeEventListener(name) { listeners.delete('doc:' + name) } }
  let serial = 0, observation, unavailable
  const win = { setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id }, clearTimeout(id) { timers.delete(id) }, setInterval(fn, delay) { const id = ++serial; timers.set(id, { fn, delay }); return id }, clearInterval(id) { timers.delete(id) }, addEventListener(name, fn) { listeners.set(name, fn) }, removeEventListener(name) { listeners.delete(name) } }
  const cycleResult = { stopped: false, conversions: [], push: { items: [], more: false }, pull: [], pending: pending() }
  const h = setup({ dexie: { liveQuery(query) { return { subscribe(observer) { observation = { query, observer }; return { unsubscribe() { calls.push('stop-query') } } } } } },
    '@/db/scheduleHostRepo': { localScheduleHostRepo: { async capture() { calls.push('capture'); return pin() }, async validate() { calls.push('validate') }, watch() { calls.push('watch-owner'); return () => calls.push('stop-owner') } } },
    '@/db/scheduleSyncRepo': { createInternalScheduleSyncCoordinator(transports, expected) { calls.push(['coordinator', expected]); return { async runOnce() { if (options.run) return options.run(transports, () => unavailable?.()); return cycleResult } } } },
    './scheduleConversionTransport': { createScheduleConversionTransport(callback) { unavailable = callback; return { async pushSource() { calls.push('http-source'); return {} }, async convert() { calls.push('http-convert'); return {} } } } },
    './schedulePushTransport': { createSchedulePushTransport() { return { async push() { calls.push('http-push'); return {} } } } },
    './schedulePullTransport': { createSchedulePullTransport() { return { async pull() { calls.push('http-pull'); return {} } } } },
  }, { window: win, document: doc, navigator: { onLine: true } })
  h.mocks['@/api/tokenStore'] = h.tokens
  return { ...h, api: h.load('api/scheduleSyncRuntime.ts'), calls, listeners, timers, doc, observation: () => observation, cycleResult }
}
test('actual App signal installer is inert, singleton and fully cleaned without starting P2 or P4 network', () => {
  const h = apiFixture(), stop = h.api.installScheduleSyncRuntime(), duplicate = h.api.installScheduleSyncRuntime()
  assert.equal(h.listeners.size, 4); assert.equal(h.timers.size, 1); assert.equal(h.calls.length, 0)
  h.listeners.get('online')(); h.listeners.get('focus')(); assert.equal(h.calls.length, 0)
  duplicate(); assert.equal(h.listeners.size, 4); stop(); assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0)
  const reinstall = h.api.installScheduleSyncRuntime()
  stop(); assert.equal(h.listeners.size, 4); assert.equal(h.timers.size, 1)
  reinstall(); assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0)
})
test('actual signal watcher ignores cursor/error writes and clean rows, but notices dirty revisions and queue changes', async () => {
  const h = apiFixture(); await h.db.meta.put({ key: 'ownerUserId', value: 'account-a' }); let changed = 0
  const stop = h.api.scheduleRuntimePort.watch(pin(), () => changed++, () => assert.fail('unexpected expiry'))
  const { query, observer } = h.observation(); observer.next(await query())
  await h.db.meta.put({ key: 'scheduleLastSyncAt', value: 'anything' }); await h.db.schedules.put(schedule({ dirty: 0 })); observer.next(await query()); assert.equal(changed, 0)
  await h.db.schedules.put(schedule()); observer.next(await query()); assert.equal(changed, 1)
  observer.next(await query()); assert.equal(changed, 1); stop(); assert.ok(h.calls.includes('stop-owner')); assert.ok(h.calls.includes('stop-query'))
})
test('formal runtime passes original expected lease to coordinator and does not invent all-data completion', async () => {
  const h = apiFixture(); const r = await h.api.scheduleRuntimePort.run(pin(), () => true), coordinator = h.calls.find(x => Array.isArray(x))
  assert.equal(JSON.stringify(coordinator[1]), JSON.stringify({ ownerUserId: 'account-a', generation: '', tokenGeneration: 0 }))
  assert.equal(r.failed, false); assert.equal(r.more, false); assert.equal('allSynced' in r, false)
})
test('formal transport fence rejects cancellation before even the first request', async () => {
  const h = apiFixture({ async run(transports) { await assert.rejects(transports.push.push({}, {})); return { stopped: true, conversions: [], push: null, pull: [], pending: null } } })
  await h.api.scheduleRuntimePort.run(pin(), () => false); assert.equal(h.calls.includes('http-push'), false)
})
test('unsupported endpoint flag prevents additional requests in the same bounded coordinator cycle', async () => {
  const h = apiFixture({ async run(transports, unavailable) { unavailable(); await assert.rejects(transports.pull.pull({}, {})); return { stopped: true, conversions: [], push: null, pull: [], pending: null } } })
  const r = await h.api.scheduleRuntimePort.run(pin(), () => true); assert.equal(r.unsupported, true); assert.equal(h.calls.includes('http-pull'), false)
})
test('transient stopped push is retryable, while held first intent remains explicitly blocked', async () => {
  const h = apiFixture(); h.cycleResult.stopped = true; h.cycleResult.push.items = [{ kind: 'held', reason: 'network' }]
  let r = await h.api.scheduleRuntimePort.run(pin(), () => true); assert.equal(r.failed, true); assert.equal(r.blocked, false)
  h.cycleResult.conversions = [{ kind: 'held', reason: 'unconfirmed', id: ID }]; r = await h.api.scheduleRuntimePort.run(pin(), () => true); assert.equal(r.blocked, true)
})
test('actual sync panel only subscribes to scoped runtime and unsubscribes without turning a view into a scheduler', () => {
  const code = require('node:module').stripTypeScriptTypes(source('components/schedules/ScheduleSyncPanel.vue').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]).replace(/^import .*$/gm, '')
  let unmount, updated, stopped = 0
  const globals = { ref: value => ({ value }), onBeforeUnmount: fn => { unmount = fn }, scheduleSyncRuntime: { inspect: () => ({ phase: 'paused' }), subscribe(fn) { updated = fn; return () => stopped++ } } }
  vm.runInNewContext(code, globals); updated(); unmount(); assert.equal(stopped, 1)
})
