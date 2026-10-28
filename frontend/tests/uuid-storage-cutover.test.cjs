const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { loadTS } = require('./schedules-harness.cjs')
const core = loadTS('shared/uuidStorageCutover.ts')
const { checkUuid32Backup } = loadTS('shared/backupUuid32.ts')
const { remapBackupMediaRefs } = loadTS('shared/backupMediaRefs.ts')
const { backup, entry, terminal, intent, ID: OLD, OTHER_ID: OLD_TAG, AT } = require('./schedules-data-harness.cjs')
const ID = OLD.replaceAll('-', ''), TAG = OLD_TAG.replaceAll('-', '')
const MEDIA = ID.slice(0, -1) + '3', OLD_MEDIA = '019a0300-1234-7000-8000-000000000003'
const plain = value => JSON.parse(JSON.stringify(value))
function gate(state, extra = {}) {
  const calls = []
  const port = { probe: async () => { calls.push('probe'); return state },
    invalidateSession: () => calls.push('logout'), open: async () => calls.push('open'),
    reset: async consent => { calls.push(['reset', consent]); return true },
    verifyReady: async () => { calls.push('verify') }, ...extra }
  return { run: core.createUuid32Cutover(port), calls }
}
test('cancel does not upgrade, clear credentials, reset or start work', async () => {
  const h = gate({ exists: true, version: 30, marker: undefined })
  assert.equal(await h.run(() => false), false); assert.deepEqual(h.calls, ['probe'])
})
test('confirmed old store logs out before opening and resetting', async () => {
  const h = gate({ exists: true, version: 30, marker: undefined })
  assert.equal(await h.run(() => true), true)
  assert.deepEqual(h.calls, ['probe', 'logout', 'open', ['reset', true], 'verify'])
})
test('fresh empty store initializes without destructive consent', async () => {
  const h = gate({ exists: false, version: 0, marker: undefined })
  assert.equal(await h.run(() => { throw Error('fresh store must not prompt') }), true)
  assert.deepEqual(h.calls, ['probe', 'logout', 'open', ['reset', false], 'verify'])
})
test('already switched store does not reset, log out or ask again', async () => {
  const h = gate({ exists: true, version: 40, marker: core.UUID32_STORAGE_VALUE })
  assert.equal(await h.run(() => { throw Error('must not prompt') }), true)
  assert.deepEqual(h.calls, ['probe', 'open', 'verify'])
})
for (const state of [{ exists: true, version: 50, marker: core.UUID32_STORAGE_VALUE },
  { exists: true, version: 40, marker: 'future' }, { exists: true, version: 30, marker: null }]) {
  test(`unknown/future format fails closed: ${JSON.stringify(state)}`, async () => {
    const h = gate(state); await assert.rejects(h.run(() => true)); assert.deepEqual(h.calls, ['probe'])
  })
}
test('initialization rejection never reports readiness', async () => {
  const h = gate({ exists: true, version: 30, marker: undefined }, { reset: async () => { throw Error('quota') } })
  await assert.rejects(h.run(() => true), /quota/); assert.ok(!h.calls.includes('verify'))
})
function tables() {
  const data = {}, ports = {}, names = ['entries', 'tags', 'media', 'schedules', 'meta', 'localFormat']
  for (const name of names) {
    data[name] = new Map(name === 'localFormat' ? [] : [['old', { value: 'old-data', id: OLD }]])
    ports[name] = { count: async () => data[name].size, clear: async () => data[name].clear(),
      get: async key => data[name].get(key), put: async row => data[name].set(row.key, row) }
  }
  return { data, ports, async tx(fn) {
    const before = structuredClone(data)
    try { return await fn() } catch (error) {
      for (const name of names) { data[name].clear(); for (const [key, row] of before[name]) data[name].set(key, row) }
      throw error
    }
  } }
}
test('one confirmed transaction clears all test entities/queues/meta and marks format', async () => {
  const h = tables()
  for (const key of ['ownerUserId', 'lastSyncAt', 'pendingPurges', 'conflicts', 'syncErrors',
    'scheduleConversions', 'scheduleConflicts', 'scheduleConflictArchive', 'scheduleDraft']) h.data.meta.set(key, { key, value: [OLD] })
  assert.equal(await h.tx(() => core.commitUuid32Reset(h.ports, true, ID)), true)
  for (const table of ['entries', 'tags', 'media', 'schedules']) assert.equal(h.data[table].size, 0)
  assert.deepEqual([...h.data.meta.keys()], ['ownerGeneration'])
  assert.equal(h.data.meta.get('ownerGeneration').value, ID)
  assert.equal(h.data.localFormat.get(core.UUID32_STORAGE_KEY).value, core.UUID32_STORAGE_VALUE)
})
for (const failure of ['tags', 'media', 'schedules', 'meta', 'localFormat']) {
  test(`rollback restores all old data when ${failure} write fails`, async () => {
    const h = tables(), before = structuredClone(h.data)
    if (failure === 'localFormat') h.ports.localFormat.put = async () => { throw Error('injected') }
    else h.ports[failure].clear = async () => { throw Error('injected') }
    await assert.rejects(h.tx(() => core.commitUuid32Reset(h.ports, true, ID)), /injected/)
    assert.deepEqual(h.data, before)
  })
}
test('concurrent confirmed tab cannot clear new rows after another tab finished', async () => {
  const h = tables(); await h.tx(() => core.commitUuid32Reset(h.ports, true, ID))
  h.data.entries.set(ID, { id: ID, title: 'new data' })
  assert.equal(await h.tx(() => core.commitUuid32Reset(h.ports, true, TAG)), false)
  assert.equal(h.data.entries.get(ID).title, 'new data')
})
test('fresh-store race with new unconfirmed data refuses destructive reset', async () => {
  const h = tables(), before = structuredClone(h.data)
  await assert.rejects(h.tx(() => core.commitUuid32Reset(h.ports, false, ID)), /确认/)
  assert.deepEqual(h.data, before)
})
test('unknown reset marker and invalid generation cannot clear existing rows', async () => {
  for (const unknown of [true, false]) {
    const h = tables()
    if (unknown) h.data.localFormat.set(core.UUID32_STORAGE_KEY, { value: 'future' })
    const before = structuredClone(h.data)
    await assert.rejects(h.tx(() => core.commitUuid32Reset(h.ports, true, unknown ? ID : OLD)))
    assert.deepEqual(h.data, before)
  }
})
const tag = (id = TAG) => ({ id, name: '青简', color: null, dirty: 1, createdAt: AT })
const media = (id = MEDIA, entryId = ID) => ({ id, entryId, blobBase64: '', thumbBase64: null,
  remoteUrl: `/media/${OLD_MEDIA}.png`, thumbRemoteUrl: '', mime: 'image/png' })
const current = () => backup({ entries: [entry({ id: ID, fromScheduleId: null, tagIds: [TAG] })], tags: [tag()], media: [] })
test('current UUID32 backup preserves identity with ordinary restore', () => {
  const file = current(); assert.equal(checkUuid32Backup(file, 'preferNewer'), file)
})
for (const formatVersion of [1, 2, 3]) test(`legacy backup v${formatVersion} requires explicit new-copy strategy`, () => {
  const file = backup({ entries: [entry({ fromScheduleId: null })] })
  if (formatVersion < 3) { delete file.schedules; delete file.scheduleConversions; delete file.counts.schedules }
  file.formatVersion = formatVersion
  assert.throws(() => checkUuid32Backup(file, 'preferNewer'), /副本/)
  assert.throws(() => checkUuid32Backup(file, 'keepLocal'), /副本/)
  const before = JSON.stringify(file)
  assert.equal(checkUuid32Backup(file, 'asCopy'), file); assert.equal(JSON.stringify(file), before)
})
test('alias collisions/invalid UUID never become duplicate imported records', () => {
  for (const rows of [[tag(TAG), tag(OLD_TAG)], [tag('bad')], [tag(TAG), tag(TAG)]]) {
    const file = current(); file.tags = rows; file.counts.tags = rows.length
    assert.throws(() => checkUuid32Backup(file, 'asCopy'))
  }
})
test('mixed representation of an existing foreign key is rejected rather than guessed', () => {
  const file = current(); file.entries[0].tagIds = [OLD_TAG]
  assert.throws(() => checkUuid32Backup(file, 'asCopy'), /不同表示/)
})
test('copy refuses missing resource definitions instead of preserving old tag/media IDs', () => {
  const file = current(); file.tags = []; file.counts.tags = 0
  assert.throws(() => checkUuid32Backup(file, 'asCopy'), /缺少/)
  const image = current(); image.entries[0].content = { schemaVersion: 1, doc: { type: 'image', attrs: { src: `local://media/${MEDIA}` } } }
  assert.throws(() => checkUuid32Backup(image, 'asCopy'), /缺少/)
})
test('legacy queue is rejected for same-identity restore, not modified in place', () => {
  const file = backup({ schedules: [terminal()], entries: [entry()], scheduleConversions: [intent()] })
  const before = JSON.stringify(file)
  assert.throws(() => checkUuid32Backup(file, 'preferNewer'), /副本/)
  assert.equal(checkUuid32Backup(file, 'asCopy'), file); assert.equal(JSON.stringify(file), before)
})
test('exact media-node remapping leaves prose, URLs, alt and prefix attacks unchanged', () => {
  const src = `local://media/${OLD_MEDIA}`, content = { schemaVersion: 1, doc: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: src }] },
    { type: 'image', attrs: { src, alt: src, title: src } },
    { type: 'image', attrs: { src: `${src}?x` } },
    { type: 'image', attrs: { src: `${src}suffix` } },
    { type: 'text', text: `https://example.com/${OLD_MEDIA}` },
  ] } }
  const before = JSON.stringify(content), mapped = remapBackupMediaRefs(content, new Map([[OLD_MEDIA, MEDIA]]))
  assert.equal(mapped.doc.content[1].attrs.src, `local://media/${MEDIA}`)
  const expected = structuredClone(content); expected.doc.content[1].attrs.src = `local://media/${MEDIA}`
  assert.deepEqual(plain(mapped), expected); assert.equal(JSON.stringify(content), before)
})
test('public backup wrapper rejects legacy before raw writer; new copies discard old remote file locations', async () => {
  const calls = []
  const api = loadTS('db/uuid32BackupRepo.ts', { './backupRepo': { localBackupRepo: {
    importAll: async (...args) => { calls.push(args); return { ok: true } }, exportAll: async () => current(),
  } } }).uuid32BackupRepo
  const file = backup({ entries: [entry({ fromScheduleId: null })], media: [media(OLD_MEDIA, OLD)] })
  await assert.rejects(api.importAll(file)); assert.equal(calls.length, 0)
  const before = JSON.stringify(file); await api.importAll(file, 'asCopy')
  assert.equal(calls[0][0].media[0].remoteUrl, ''); assert.equal(JSON.stringify(file), before)
  assert.equal(calls[0][1], 'asCopy'); await api.exportAll()
})
test('bootstrap is lazy, v4 schema does not auto-clear, account reset cannot remove format table', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')
  const main = read('main.ts'), schema = read('db/schema.ts'), gate = read('db/uuid32Storage.ts')
  assert.ok(main.indexOf('await prepareUuid32Storage') < main.indexOf('await import("./bootstrap")'))
  assert.equal(main.includes('runSync'), false)
  assert.ok(schema.includes('this.version(4).stores({\n      localFormat: "key"'))
  assert.ok(!schema.slice(schema.indexOf('this.version(4)')).includes('.clear('))
  assert.ok(gate.includes('db.localFormat') && gate.includes('commitUuid32Reset'))
  assert.ok(read('repo/index.ts').includes('backupRepo = uuid32BackupRepo'))
})
