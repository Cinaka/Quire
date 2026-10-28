// Real backup planner/writer + existing in-memory tables, not native IndexedDB.
const { test } = require('node:test'), assert = require('node:assert/strict')
const { setup, backup, entry, schedule, terminal, intent, ID, OTHER_ID, AT } = require('./schedules-data-harness.cjs')
const MEDIA = '019a0300-1234-7000-8000-000000000003'
const image = () => ({ schemaVersion: 1, doc: { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: `local://media/${MEDIA}` }] },
  { type: 'image', attrs: { src: `local://media/${MEDIA}` } },
] } })
function harness() {
  let next = 100
  return setup({
    '@/shared/ids': { newId: () => `019a0300123470008000${String(++next).padStart(12, '0')}` },
    '@/shared/scheduleConflict': { SCHEDULE_CONFLICT_ARCHIVE: 'scheduleConflictArchive' },
    '@/shared/scheduleTagPublication': { readTagSafetyArchive: rows => {
      assert.equal(rows.length, 0); return { plans: [], publications: [], handoffs: [] }
    } },
  })
}
const picture = () => ({ id: MEDIA, entryId: ID, sortOrder: 0, mime: 'image/png', width: 1,
  height: 1, size: 3, createdAt: AT, orphanedAt: null, dirty: 1,
  remoteUrl: `/media/${MEDIA}.png`, thumbRemoteUrl: '', blobBase64: 'cG5n', thumbBase64: null })
const tag = () => ({ id: OTHER_ID, name: '青简', color: 'green', createdAt: AT, dirty: 1 })
test('legacy copy restore generates canonical IDs and keeps all entry/tag/media links aligned', async () => {
  const h = harness(), api = h.load('db/uuid32BackupRepo.ts').uuid32BackupRepo
  const file = backup({ entries: [entry({ fromScheduleId: null, content: image(), tagIds: [OTHER_ID] })], tags: [tag()], media: [picture()] })
  const before = JSON.stringify(file)
  const report = await api.importAll(file, 'asCopy')
  assert.equal(report.entriesAdded, 1); assert.equal(report.mediaAdded, 1)
  const e = (await h.db.entries.toArray())[0], m = (await h.db.media.toArray())[0], t = (await h.db.tags.toArray())[0]
  for (const row of [e, m, t]) assert.match(row.id, /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/)
  assert.equal(m.entryId, e.id); assert.equal(e.tagIds[0], t.id)
  assert.equal(e.content.doc.content[1].attrs.src, `local://media/${m.id}`)
  assert.equal(e.content.doc.content[0].content[0].text, `local://media/${MEDIA}`)
  assert.equal(m.remoteUrl, ''); assert.equal(m.thumbRemoteUrl, ''); assert.equal(m.dirty, 1)
  assert.equal(JSON.stringify(file), before)
  const exported = await api.exportAll()
  assert.equal(exported.entries[0].id, e.id); assert.equal(exported.media[0].entryId, e.id)
})
test('legacy conversion copy gets a new stable source/entry/queue identity, not an old receipt replay', async () => {
  const h = harness(), api = h.load('db/uuid32BackupRepo.ts').uuid32BackupRepo
  await h.db.meta.put({ key: 'ownerUserId', value: 'account-a' })
  const later = '2026-10-08T10:00:00.001Z', source = schedule()
  const first = entry({ title: source.title, content: source.content, contentText: source.contentText,
    clientUpdatedAt: later, updatedAt: later, createdAt: later })
  const firstIntent = intent({ source, entry: first, queuedAt: later, protectedMediaIds: [MEDIA] })
  const file = backup({ schedules: [terminal({ convertedAt: later, clientUpdatedAt: later, updatedAt: later })],
    entries: [entry({ content: image(), tagIds: [OTHER_ID], clientUpdatedAt: later })],
    scheduleConversions: [firstIntent], tags: [tag()], media: [picture()] })
  const before = JSON.stringify(file)
  await api.importAll(file, 'asCopy')
  const s = (await h.db.schedules.toArray())[0], e = (await h.db.entries.toArray())[0]
  const m = (await h.db.media.toArray())[0], q = (await h.db.meta.get('scheduleConversions')).value[0]
  assert.notEqual(s.id, ID); assert.match(s.id, /^[0-9a-f]{32}$/)
  assert.equal(s.convertedEntryId, s.id); assert.equal(e.id, s.id); assert.equal(e.fromScheduleId, s.id)
  assert.equal(q.scheduleId, s.id); assert.equal(q.source.id, s.id)
  assert.equal(q.entry.id, s.id); assert.equal(q.entry.fromScheduleId, s.id)
  assert.equal(q.protectedMediaIds[0], m.id)
  assert.equal(q.ownerUserId, 'account-a'); assert.equal(JSON.stringify(file), before)
  const request = h.load('shared/scheduleConversionSync.ts').prepareConversionRequest({
    lease: { ownerUserId: 'account-a', generation: 'test', tokenGeneration: 0 }, intent: q,
  })
  assert.equal(request.convert.entry.id, s.id)
  assert.equal(JSON.stringify(request.convert.entry.content), JSON.stringify(first.content))
})
test('public rejection and transactional write failure leave no partial restore', async () => {
  for (const fail of [false, true]) {
    const h = harness(), api = h.load('db/uuid32BackupRepo.ts').uuid32BackupRepo
    const file = backup({ entries: [entry({ fromScheduleId: null })] })
    if (fail) h.failNext('entries')
    await assert.rejects(api.importAll(file, fail ? 'asCopy' : 'preferNewer'))
    assert.equal(h.stores.entries.rows.size, 0); assert.equal(h.stores.tags.rows.size, 0)
    assert.equal(h.stores.media.rows.size, 0); assert.equal(h.stores.meta.rows.size, 0)
  }
})
