const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { loadTS } = require('./schedules-harness.cjs')
const { setup, ID, OTHER_ID, terminal, schedule } = require('./schedules-data-harness.cjs')
const context = () => ({ ownerUserId: 'account-a', generation: '', authSubject: 'account-a', authGeneration: 0 })
const lease = () => ({ ownerUserId: 'account-a', generation: '', tokenGeneration: 0 })
const read = p => fs.readFileSync(path.join(__dirname, '../src', p), 'utf8')
const script = p => require('node:module').stripTypeScriptTypes(read(p).match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]).replace(/^import .*$/gm, '')
function fixture(extra = {}) {
  const calls = [], handles = [], transports = [], gates = {}; let childLease = lease(), childId = ID
  const result = { ready: true, reviewId: 1, blocks: ['read_only_observation'], completeLocalResources: true, sourceDeletionEnabled: true, choices: ['finish-cloud-purged'] }
  const make = (name, transport) => { transports.push(transport); return {
    async review(id) { calls.push(name + '.review'); await transport.review(id, childLease); return { ...result } },
    async resolve(...args) { calls.push(name + '.resolve'); handles.push(args.at(-1)); await transport.review(childId, childLease); return { applied: true } },
    async save(...args) { calls.push(name + '.save'); handles.push(args.at(-1)); await transport.review(childId, childLease); return { saved: true } },
    cancel() { calls.push(name + '.cancel') },
  } }
  const raw = { async review(id, candidate) { calls.push('http.review'); if (gates.review) await gates.review; return { id, candidate } },
    async image() { calls.push('http.image'); return {} }, async publish() { calls.push('http.publish'); return {} }, async checkTags() { calls.push('http.tags'); return {} } }
  const h = setup({
    '@/api/scheduleConflictTransport': { createScheduleConflictTransport: () => ({ async detail() { throw Error('unused pending transport') } }) },
    '@/api/scheduleResourceWorkspaceTransport': { createScheduleResourceWorkspaceTransport: () => raw },
    '@/api/scheduleTerminalReviewTransport': { createScheduleTerminalReviewTransport: () => raw },
    './scheduleResourceWorkspaceRepo': { createInternalResourceWorkspace: (id, transport) => { transports.push(transport); return {
      async prepareEvidence() { calls.push('resource.prepare'); await transport.review(childId, childLease); return { ready: true, reviewId: 1 } },
      async inspect() { await transport.review(id, childLease); return {} },
      async saveEvidence() { return { saved: true } }, cancel() { calls.push('resource.cancel') },
    } } },
    './scheduleTerminalBlockedRepo': { createInternalTerminalBlockedObserver: transport => make('observer', transport) },
    './scheduleTerminalConflictRepo': { createInternalScheduleSourceTombstoneResolver: transport => make('source', transport), createInternalScheduleTerminalDiscardResolver: transport => make('discard', transport) }, ...extra,
  })
  h.mocks['@/api/tokenStore'] = h.tokens
  const repo = h.load('db/scheduleConflictCenterRepo.ts')
  return { ...h, repo, calls, handles, transports, gates, result, child(value) { childLease = value }, childSource(value) { childId = value } }
}
async function owned(h) { await h.db.meta.put({ key: 'ownerUserId', value: 'account-a' }) }
test('session construction is inert and copies the original formal context', async () => {
  const h = fixture(); await owned(h); const pin = context(), s = h.repo.createScheduleConflictSession(pin, ID)
  pin.authSubject = 'different'; assert.equal(h.calls.length, 0)
  await s.review(); assert.equal(h.calls.filter(x => x === 'http.review').length, 3)
})
for (const pin of [{ ...context(), ownerUserId: '', authSubject: '' }, { ...context(), authSubject: 'foreign' }]) test('guest/mismatched host cannot create cloud session or request', () => {
  const h = fixture(); assert.throws(() => h.repo.createScheduleConflictSession(pin, ID)); assert.equal(h.calls.length, 0)
})
test('local source listing includes deleted terminal sources, excludes pending and does no network/write', async () => {
  const h = fixture(); await owned(h); await h.db.schedules.put(terminal({ deletedAt: '2026-10-08T10:00:00.000Z', isDeleted: 1 })); await h.db.schedules.put(schedule({ id: OTHER_ID }))
  const before = JSON.stringify([...h.db.schedules.rows.values()]); const rows = await h.repo.listScheduleConflictSources(context())
  assert.equal(rows.length, 1); assert.equal(rows[0].id, ID); assert.equal(rows[0].deleted, true)
  assert.equal(JSON.stringify([...h.db.schedules.rows.values()]), before); assert.equal(h.calls.length, 0)
})
test('malformed local source blocks listing instead of silently skipping it', async () => {
  const h = fixture(); await owned(h); await h.db.schedules.put({ id: ID, status: 'converted' }); await assert.rejects(h.repo.listScheduleConflictSources(context()))
})
for (const mutation of ['logout', 'owner', 'epoch']) test(`${mutation} before review blocks every network operation`, async () => {
  const h = fixture(); await owned(h); const s = h.repo.createScheduleConflictSession(context(), ID)
  if (mutation === 'logout') h.user('')
  else await h.db.meta.put({ key: mutation === 'owner' ? 'ownerUserId' : 'ownerGeneration', value: 'changed' })
  await assert.rejects(s.review()); assert.equal(h.calls.filter(x => x.startsWith('http.')).length, 0)
})
for (const candidate of [{ ...lease(), tokenGeneration: 1 }, { ...lease(), ownerUserId: 'other' }, { ...lease(), generation: 'restored' }]) test(`child cannot recapture another lease ${JSON.stringify(candidate)}`, async () => {
  const h = fixture(); await owned(h); const s = h.repo.createScheduleConflictSession(context(), ID); h.child(candidate)
  await assert.rejects(s.review()); assert.equal(h.calls.filter(x => x.startsWith('http.')).length, 0)
})
test('resource child cannot silently choose another source', async () => {
  const h = fixture(); await owned(h); const s = h.repo.createScheduleConflictSession(context(), ID); h.childSource(OTHER_ID)
  await assert.rejects(s.resources.prepareEvidence(true)); assert.equal(h.calls.filter(x => x.startsWith('http.')).length, 0)
})
test('cancel during HTTP ignores late result and cannot restart under current account', async () => {
  const h = fixture(); await owned(h); let release; h.gates.review = new Promise(r => { release = r })
  const s = h.repo.createScheduleConflictSession(context(), ID), work = s.review(); for (let i = 0; i < 30; i++) await Promise.resolve()
  s.cancel(); release(); await assert.rejects(work); await assert.rejects(s.review())
})
test('terminal review projects no raw diary or lease and performs no application', async () => {
  const h = fixture(); await owned(h); const s = h.repo.createScheduleConflictSession(context(), ID), value = await s.review()
  assert.deepEqual(Object.keys(value).sort(), ['blocks', 'choices', 'completeLocalResources', 'sourceDeletionEnabled'].sort())
  assert.equal(h.calls.some(x => x.endsWith('.resolve') || x.endsWith('.save')), false)
})
for (const action of ['observation', 'source', 'finish-cloud-purged']) test(`${action} requires a fresh review and literal confirmation, then consumes it`, async () => {
  const h = fixture(); await owned(h); const s = h.repo.createScheduleConflictSession(context(), ID), handle = {}
  assert.equal(await s.apply(action, true, handle), false); await s.review(); assert.equal(await s.apply(action, false, handle), false)
  await s.review(); assert.equal(await s.apply(action, true, handle), true); assert.equal(h.handles.at(-1), handle)
  const count = h.handles.length; assert.equal(await s.apply(action, true, handle), false); assert.equal(h.handles.length, count)
})
test('unsupported discard choice is not widened by UI or adapter', async () => {
  const h = fixture(); await owned(h); const s = h.repo.createScheduleConflictSession(context(), ID); await s.review()
  assert.equal(await s.apply('handoff-cleared-tombstone', true, {}), false); assert.equal(h.handles.length, 0)
})
const ref = value => ({ value })
function center() {
  const hooks = {}, events = [], calls = [], props = { context: context() }
  let expiredCallback, pickerResolve
  const session = { resources: {}, async reviewPending() { calls.push('pending.review'); return { local: schedule(), server: schedule(), choices: ['keep-local', 'use-cloud'] } }, async resolvePending() { calls.push('pending.resolve'); return true }, cancel() { calls.push('cancel') }, async review() { calls.push('review'); return { blocks: [], choices: ['finish-cloud-purged'], sourceDeletionEnabled: true, completeLocalResources: true } }, async apply() { calls.push('apply'); return true } }
  const globals = { ref, shallowRef: ref, defineProps: () => props, defineEmits: () => name => events.push(name), defineExpose() {},
    resourceEvidenceSaveAvailable: () => true, pickResourceWorkspaceEvidence: () => new Promise(r => { pickerResolve = r }),
    async listScheduleConflictSources() { calls.push('list'); return [{ id: ID, title: 'test', deleted: false }] }, createScheduleConflictSession: () => session,
    scheduleHostRepo: { watch(_context, callback) { expiredCallback = callback; return () => calls.push('unwatch') } },
    onMounted: fn => { hooks.mount = fn }, onBeforeUnmount: fn => { hooks.unmount = fn },
    window: { addEventListener() {}, removeEventListener() {} } }
  vm.runInNewContext(script('components/schedules/ScheduleConflictCenter.vue') + '\nglobalThis.bindings={select,review,openResources,closeResources,prepareLeave,close,apply,resourceOpen,resourceRef,preview,confirmedAction,expired,busy,session,selected,reviewPending,resolvePending,pendingPreview,pendingChoice};', globals)
  return { ...globals.bindings, hooks, calls, events, expire: () => expiredCallback(), pick: value => pickerResolve(value) }
}
test('actual center mount only lists local sources; selected source requires explicit cloud review', async () => {
  const h = center(); h.hooks.mount(); for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.deepEqual(h.calls, ['list']); h.select({ id: ID }); assert.deepEqual(h.calls, ['list']); await h.review(); assert.ok(h.calls.includes('review'))
  h.hooks.unmount(); assert.ok(h.calls.includes('unwatch'))
})
test('open resource panel blocks route exit/source replacement until explicit panel close', async () => {
  const h = center(); h.select({ id: ID }); h.openResources(); assert.equal(await h.prepareLeave(), false)
  h.select({ id: OTHER_ID }); assert.equal(h.selected.value.id, ID)
  await h.close(); assert.equal(h.events.length, 0); h.closeResources(); assert.equal(await h.prepareLeave(), true)
  await h.close(); assert.equal(h.events[0], 'close')
})
test('expiry preserves resource panel mount, expires it and never auto rebinds', async () => {
  const h = center(); h.hooks.mount(); for (let i = 0; i < 10; i++) await Promise.resolve(); h.select({ id: ID }); h.openResources(); let expired = 0
  h.resourceRef.value = { expire() { expired++ } }; h.expire()
  assert.equal(h.resourceOpen.value, true); assert.equal(h.expired.value, true); assert.equal(expired, 1); assert.ok(h.calls.includes('cancel'))
})
test('file picker waiting blocks navigation; expiry cancels before any application and keeps file', async () => {
  const h = center(); h.hooks.mount(); for (let i = 0; i < 10; i++) await Promise.resolve()
  h.select({ id: ID }); await h.review(); h.confirmedAction.value = 'source'
  const work = h.apply('source'); assert.equal(await h.prepareLeave(), false); h.expire(); let cancelled = 0
  h.pick({ handle: {}, cancel() { cancelled++ } }); await work
  assert.equal(h.calls.includes('apply'), false); assert.equal(cancelled, 1); assert.equal(h.preview.value, null)
})
test('formal page switches guarded hosts but never derives operations from route/query/hash', () => {
  const view = read('views/ScheduleView.vue'), panel = read('components/schedules/ScheduleResourceWorkspacePanel.vue')
  assert.match(view, /v-show="!conflictOpen" ref="hostRef"/); assert.match(view, /conflictOpen.value \? conflictRef.value : hostRef.value/)
  assert.match(view, /!await leaveGuard.attempt\(\)/); assert.match(panel, /defineExpose\(\{ expire: panel.expire \}\)/)
  assert.doesNotMatch(view, /route\.query|route\.params|syncNow|autoSync/)
})
function formal() {
  const hooks = {}, globals = { ref, scheduleSyncRuntime: { inspect: () => ({ enabled: false, busy: false }), subscribe: () => () => {}, acquireManualReview: () => () => {}, pause() {} }, createScheduleRouteLeave: loadTS('shared/scheduleRouteLeave.ts').createScheduleRouteLeave,
    onBeforeRouteLeave: fn => { hooks.leave = fn }, onBeforeRouteUpdate: fn => { hooks.update = fn }, onBeforeUnmount: fn => { hooks.unmount = fn } }
  vm.runInNewContext(script('views/ScheduleView.vue') + '\nglobalThis.bindings={hostRef,conflictRef,conflictOpen,conflictContext,openConflicts,closeConflicts,leaveNotice};', globals)
  return { ...globals.bindings, hooks }
}
test('actual formal route refuses opening over unsaved diary or unready host', async () => {
  const h = formal(); await h.openConflicts(); assert.equal(h.conflictOpen.value, false)
  h.hostRef.value = { async prepareLeave() { return false }, capturedContext: context }; await h.openConflicts(); assert.equal(h.conflictOpen.value, false)
  h.hostRef.value = { async prepareLeave() { return true }, capturedContext: () => null }; await h.openConflicts(); assert.equal(h.conflictOpen.value, false)
})
test('actual formal route switches to center guard without unmounting the original host, then refreshes on close', async () => {
  const h = formal(); let refreshes = 0
  const host = { async prepareLeave() { return true }, capturedContext: context, async refresh() { refreshes++ } }; h.hostRef.value = host
  await h.openConflicts(); assert.equal(h.conflictOpen.value, true); assert.equal(h.hostRef.value, host)
  assert.equal(await h.hooks.leave(), false)
  h.conflictRef.value = { async prepareLeave() { return false } }; assert.equal(await h.hooks.leave(), false)
  h.conflictRef.value = { async prepareLeave() { return true } }; assert.equal(await h.hooks.leave(), true)
  await h.closeConflicts(); assert.equal(h.conflictOpen.value, false); assert.equal(refreshes, 1); assert.equal(h.hostRef.value, host)
})
test('host captured context getter returns independent snapshots and refuses disposed host', async () => {
  const pin = context(), port = { async capture() { return pin }, async validate() {}, workspace() { return {} }, watch() { return () => {} } }
  const host = loadTS('shared/scheduleHost.ts').createScheduleHost(port, undefined, { firstSaveEnabled: false })
  assert.equal(host.capturedContext(), null); await host.initialize(); const exposed = host.capturedContext(); exposed.authSubject = 'foreign'
  assert.equal(host.capturedContext().authSubject, 'account-a'); host.dispose(); assert.equal(host.capturedContext(), null)
})

function pendingWire(row) { return { id: row.id, remind_date: row.remindDate, title: row.title, content: row.content, content_text: row.contentText, status: row.status, converted_entry_id: row.convertedEntryId, converted_at: row.convertedAt, client_updated_at: row.clientUpdatedAt, deleted_at: row.deletedAt, created_at: row.createdAt, updated_at: row.serverUpdatedAt } }
async function pendingFixture() {
  let remote, duringRead; const requests = []
  const h = fixture({ '@/api/scheduleConflictTransport': { createScheduleConflictTransport: () => ({ async detail(id, candidate) { requests.push({ id, candidate }); if (duringRead) await duringRead(requests.length); return pendingWire(remote) } }) } })
  await owned(h)
  const local = schedule({ title: '本机待刻' }); remote = schedule({ title: '云端待刻', clientUpdatedAt: '2026-10-08T10:00:01.000Z', serverUpdatedAt: '2026-10-08T10:00:02.000Z', updatedAt: '2026-10-08T10:00:02.000Z', dirty: 0 })
  await h.db.schedules.put(local); await h.db.schedules.put(schedule({ id: OTHER_ID }))
  await h.db.meta.put({ key: 'scheduleConflicts', value: [{ scheduleId: ID, kind: 'schedule-push', reason: 'stale', submitted: local, expectedServerRevision: null, serverSchedule: remote }] })
  const session = h.repo.createScheduleConflictSession(context(), ID)
  return { ...h, session, requests, local, get remote() { return remote }, changeRemote() { remote = { ...remote, title: '更新后的云端' } }, duringRead(fn) { duringRead = fn } }
}
function blankEvidence(onClose) {
  let saved = ''; return { get saved() { return saved }, handle: { async getFile() { return { size: new Blob([saved]).size, async text() { return saved } } }, async createWritable() { let pending; return { async write(value) { pending = value }, async close() { saved = pending; await onClose?.() }, async abort() {} } } } }
}
test('local listing now includes only pending sources with retained conflicts, plus original terminal sources', async () => {
  const h = await pendingFixture(), rows = await h.repo.listScheduleConflictSources(context())
  assert.equal(rows.length, 1); assert.equal(rows[0].id, ID); assert.equal(rows[0].kind, 'pending'); assert.equal(h.requests.length, 0)
  assert.equal(await h.session.resolvePending('use-cloud', true, blankEvidence().handle), false)
})
for (const choice of ['keep-local', 'use-cloud']) test(`formal pending ${choice} saves and verifies actual evidence before applying only its source`, async () => {
  const h = await pendingFixture(), beforeOther = JSON.stringify(await h.db.schedules.get(OTHER_ID)), preview = await h.session.reviewPending()
  assert.equal(preview.local.title, '本机待刻'); assert.equal(preview.server.title, '云端待刻'); assert.equal(preview.choices.length, 2)
  const file = blankEvidence(async () => { assert.equal((await h.db.schedules.get(ID)).title, '本机待刻'); assert.equal((await h.db.meta.get('scheduleConflicts')).value.length, 1) })
  assert.equal(await h.session.resolvePending(choice, true, file.handle), true)
  assert.equal((await h.db.schedules.get(ID)).title, choice === 'keep-local' ? '本机待刻' : '云端待刻')
  assert.equal((await h.db.schedules.get(ID)).dirty, choice === 'keep-local' ? 1 : 0)
  assert.equal(JSON.stringify(await h.db.schedules.get(OTHER_ID)), beforeOther); assert.equal((await h.db.meta.get('scheduleConflicts')).value.length, 0)
  const evidence = JSON.parse(file.saved); assert.equal(evidence.choice, choice); assert.equal(evidence.local.title, '本机待刻'); assert.equal(evidence.server.title, '云端待刻')
  assert.equal(h.requests.length, 3); assert.equal(await h.session.resolvePending(choice, true, blankEvidence().handle), false)
})
for (const mode of ['cancel', 'remote-change', 'epoch', 'bad-file']) test(`formal pending ${mode} at file preservation keeps original source/candidates`, async () => {
  const h = await pendingFixture(); await h.session.reviewPending()
  const file = blankEvidence(async () => { if (mode === 'cancel') h.session.cancel(); if (mode === 'remote-change') h.changeRemote(); if (mode === 'epoch') await h.db.meta.put({ key: 'ownerGeneration', value: 'restored' }) })
  if (mode === 'bad-file') file.handle.getFile = async () => ({ size: 0, async text() { return '' } })
  let result = false; try { result = await h.session.resolvePending('use-cloud', true, file.handle) } catch { /* expired formal session rejects instead of returning success */ }
  assert.equal(result, false); assert.equal((await h.db.schedules.get(ID)).title, '本机待刻'); assert.equal((await h.db.meta.get('scheduleConflicts')).value.length, 1); assert.equal(await h.db.meta.get('scheduleConflictArchive'), undefined)
})
test('session cancelled after an inner transaction writes still rolls back before outer commit', async () => {
  const h = await pendingFixture(); await h.session.reviewPending(); const put = h.db.meta.put
  h.db.meta.put = async row => { const value = await put(row); if (row.key === 'scheduleConflictArchive') h.session.cancel(); return value }
  try { await h.session.resolvePending('use-cloud', true, blankEvidence().handle) } catch {}
  assert.equal((await h.db.schedules.get(ID)).title, '本机待刻'); assert.equal((await h.db.meta.get('scheduleConflicts')).value.length, 1); assert.equal(await h.db.meta.get('scheduleConflictArchive'), undefined)
})
test('formal pending session cannot recapture an alternate lease before outbound read', async () => {
  const h = await pendingFixture(); h.user('account-b'); await assert.rejects(h.session.reviewPending()); assert.equal(h.requests.length, 0)
})
test('pending center UI has no default choice and refuses resolution until explicit review and choice', async () => {
  const h = center(); h.select({ id: ID, title: '待刻', deleted: false, kind: 'pending' })
  await h.resolvePending(); assert.equal(h.calls.includes('pending.resolve'), false)
  await h.reviewPending(); assert.equal(h.pendingChoice.value, null); assert.equal(h.pendingPreview.value.choices.length, 2)
  await h.resolvePending(); assert.equal(h.calls.includes('pending.resolve'), false)
  h.pendingChoice.value = 'use-cloud'; const work = h.resolvePending(); assert.equal(await h.prepareLeave(), false)
  h.pick({ handle: {}, cancel() {} }); await work; assert.equal(h.calls.includes('pending.resolve'), true); assert.equal(h.pendingPreview.value, null)
})
test('expired pending UI does not call resolver after a delayed file picker', async () => {
  const h = center(); h.hooks.mount(); for (let i = 0; i < 12; i++) await Promise.resolve(); h.select({ id: ID, title: '待刻', deleted: false, kind: 'pending' }); await h.reviewPending(); h.pendingChoice.value = 'keep-local'
  const work = h.resolvePending(); h.expire(); h.pick({ handle: {}, cancel() {} }); await work
  assert.equal(h.calls.includes('pending.resolve'), false); assert.equal(h.pendingPreview.value, null)
})

for (const kind of ['text', 'resources']) test(`actual exclusive evidence picker uses the ${kind} label without writing on selection`, async () => {
  let options, writes = 0
  const raw = { name: 'test.json', async getFile() { return { size: 0, async text() { return '' } } }, async createWritable() { writes++; throw Error('must not write at selection') } }
  const picker = loadTS('io/scheduleResourceWorkspacePicker.ts', { './scheduleResourceSavePicker': { resourceEvidenceSaveAvailable: () => true } })
  const target = await picker.pickResourceWorkspaceEvidence({ async showSaveFilePicker(value) { options = value; return raw } }, kind)
  assert.equal(options.suggestedName, kind === 'text' ? 'quire-schedule-conflict-evidence.json' : 'quire-dual-resource-evidence.json')
  assert.equal(writes, 0); target.cancel(); await assert.rejects(target.handle.getFile())
})
