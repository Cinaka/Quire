const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, AT, schedule, entry, terminal, intent, backup, setup } = require("./schedules-data-harness.cjs")
const contract = loadTS("shared/backup.ts")

test("v1/v2 remain readable; v3 rejects missing arrays, bad counts and disguised legacy content", () => {
  for (const version of [1, 2]) {
    const old = backup({ formatVersion: version }); delete old.schedules; delete old.scheduleConversions
    assert.equal(contract.checkBackup(old).ok, true)
  }
  for (const file of [backup({ schedules: undefined }), backup({ scheduleConversions: undefined }),
    backup({ counts: { schedules: 99 } }), backup({ formatVersion: 2 }), backup({ formatVersion: 2.5 })]) {
    assert.equal(contract.checkBackup(file).ok, false)
  }
  assert.equal(contract.checkBackup(backup({ formatVersion: 4 })).ok, false)
})
test("malformed dates, identities, source links and queue snapshots fail before storage", () => {
  for (const bad of [schedule({ remindDate: "2026-02-29" }), terminal({ convertedEntryId: OTHER_ID }),
    schedule({ isDeleted: 1, deletedAt: null }), schedule({ status: "converted" })]) {
    assert.equal(contract.checkBackup(backup({ schedules: [bad] })).ok, false)
  }
  assert.equal(contract.checkBackup(backup({ schedules: [terminal()], entries: [entry({ id: OTHER_ID })] })).ok, false)
  assert.equal(contract.checkBackup(backup({ schedules: [schedule()], scheduleConversions: [intent()] })).ok, false)
  assert.equal(contract.checkBackup(backup({ schedules: [terminal()], scheduleConversions: [intent({ entry: entry({ fromScheduleId: null }) })] })).ok, false)
})
test("empty pending schedules round-trip and repeated imports do not add copies", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.schedules.put(schedule())
  const file = await api.exportAll()
  assert.equal(file.formatVersion, 3); assert.equal(file.schedules.length, 1)
  assert.equal(file.counts.schedules, 1)
  const first = await api.importAll(file)
  const second = await api.importAll(file)
  assert.equal(first.schedulesSkipped, 1); assert.equal(second.schedulesSkipped, 1)
  assert.equal(h.stores.schedules.rows.size, 1)
})
test("exported conversion intent omits owner, token, generation and cursors", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.schedules.put(terminal()); await h.db.entries.put(entry())
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "ownerGeneration", value: "private-generation" })
  await h.db.meta.put({ key: "scheduleConversions", value: [{ ...intent(), ownerUserId: "private-owner", accessToken: "secret" }] })
  const file = await api.exportAll(); const json = JSON.stringify(file)
  for (const secret of ["private-owner", "private-generation", "secret", "ownerUserId", "ownerGeneration"]) assert.ok(!json.includes(secret))
  assert.equal(file.scheduleConversions[0].entry.contentText, "写成")
})
test("empty-store terminal restore rebinds intent to the local owner without blind replay", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.meta.put({ key: "ownerUserId", value: "account-b" })
  const file = backup({ schedules: [terminal()], entries: [entry()], scheduleConversions: [intent()] })
  const report = await api.importAll(file)
  const queue = (await h.db.meta.get("scheduleConversions")).value
  assert.equal(report.schedulesAdded, 1); assert.equal(report.conversionsRestored, 1)
  assert.equal(queue[0].ownerUserId, "account-b")
  assert.equal((await h.db.entries.get(ID)).dirty, 1)
  assert.equal((await h.db.schedules.get(ID)).serverUpdatedAt, "")
})
test("asCopy remaps both resource IDs, media references, tag IDs and preserved snapshots", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  const mediaId = "019a0300-1234-7000-8000-000000000003"
  const tagId = "019a0300-1234-7000-8000-000000000004"
  const latest = entry({ tagIds: [tagId], content: { schemaVersion: 1, doc: { type: "doc", content: [
    { type: "image", attrs: { src: `local://media/${mediaId}` } },
  ] } } })
  const file = backup({ schedules: [terminal()], entries: [latest], scheduleConversions: [intent({ entry: latest })],
    tags: [{ id: tagId, name: "旅行", color: null, createdAt: AT, dirty: 1 }],
    media: [{ id: mediaId, entryId: ID, mime: "image/png", size: 1, width: 1, height: 1, sortOrder: 0,
      createdAt: AT, remoteUrl: "", dirty: 1, blobBase64: Buffer.from([1]).toString("base64"), thumbBase64: null }] })
  await api.importAll(file, "asCopy")
  const source = [...h.stores.schedules.rows.values()][0]
  const restored = [...h.stores.entries.rows.values()][0]
  const photo = [...h.stores.media.rows.values()][0]
  const tag = [...h.stores.tags.rows.values()][0]
  const queued = (await h.db.meta.get("scheduleConversions")).value[0]
  assert.notEqual(source.id, ID); assert.equal(source.convertedEntryId, source.id)
  assert.equal(restored.id, source.id); assert.equal(restored.fromScheduleId, source.id)
  assert.equal(photo.entryId, restored.id); assert.equal(restored.tagIds[0], tag.id)
  assert.equal(restored.content.doc.content[0].attrs.src, `local://media/${photo.id}`)
  assert.equal(queued.scheduleId, source.id); assert.equal(queued.source.id, source.id)
  assert.equal(queued.entry.id, source.id); assert.equal(queued.entry.content.doc.content[0].attrs.src, `local://media/${photo.id}`)
})
test("orphan source links are cleared for copies, but legacy v2 input remains compatible", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  const file = backup({ formatVersion: 2, entries: [entry()] }); delete file.schedules; delete file.scheduleConversions
  await api.importAll(file, "asCopy")
  const row = [...h.stores.entries.rows.values()][0]
  assert.equal(row.fromScheduleId, null); assert.notEqual(row.id, ID)
})
test("newer Entry imports through an unchanged confirmed terminal source", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.schedules.put(terminal({ dirty: 0, serverUpdatedAt: AT })); await h.db.entries.put(entry())
  const report = await api.importAll(backup({ schedules: [terminal()], entries: [entry({ title: "新日记", clientUpdatedAt: "2026-10-08T11:00:00.000Z" })] }))
  assert.equal(report.entriesUpdated, 1); assert.equal((await h.db.entries.get(ID)).title, "新日记")
  assert.equal((await h.db.meta.get("scheduleConversions")).value.length, 0)
})
test("a newer local pending source is not half-overwritten by a stale converted backup", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.schedules.put(schedule({ clientUpdatedAt: "2026-10-08T11:00:00.000Z" }))
  const report = await api.importAll(backup({ schedules: [terminal()], entries: [entry()] }))
  assert.equal(report.schedulesSkipped, 1); assert.equal(report.entriesSkipped, 1)
  assert.equal(await h.db.entries.get(ID), undefined)
  assert.equal((await h.db.schedules.get(ID)).status, "pending")
})
test("too-new content skips the associated source/Entry/intent, not a blind downgraded replay", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  const newer = { schemaVersion: 9, doc: { type: "doc", content: [] } }
  const file = backup({ schedules: [terminal({ content: newer })], entries: [entry()], scheduleConversions: [intent()] })
  assert.equal(contract.checkBackup(file).ok, true)
  const report = await api.importAll(file)
  assert.equal(report.schedulesTooNew, 1); assert.equal(report.entriesTooNew, 1)
  assert.equal(h.stores.schedules.rows.size, 0); assert.equal(h.stores.entries.rows.size, 0)
})
test("missing purged Entry preserves a terminal identity as a queued tombstone, not visible content", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await api.importAll(backup({ schedules: [terminal()] }))
  const queued = (await h.db.meta.get("scheduleConversions")).value[0]
  assert.equal(queued.entry.isDeleted, 1); assert.equal(queued.entry.content, null)
  assert.equal(h.stores.entries.rows.size, 0)
  assert.equal((await h.db.schedules.get(ID)).status, "converted")
})
test("transaction failure leaves original tables, queue and ownership intact", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null }))
  h.failNext("schedules")
  await assert.rejects(api.importAll(backup({ schedules: [terminal()], entries: [entry()] })), /injected/)
  assert.equal(h.stores.entries.rows.size, 1); assert.equal(h.stores.schedules.rows.size, 0)
  assert.equal(await h.db.meta.get("scheduleConversions"), undefined)
})

test("newer restores cannot replace an existing immutable first conversion snapshot", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.schedules.put(terminal()); await h.db.entries.put(entry())
  const first = { ...intent(), ownerUserId: "account-a" }
  await h.db.meta.put({ key: "scheduleConversions", value: [first] })
  const at = "2026-10-08T11:00:00.000Z"
  const report = await api.importAll(backup({ schedules: [terminal({ clientUpdatedAt: at })],
    entries: [entry({ title: "之后的正文", clientUpdatedAt: at })],
    scheduleConversions: [intent({ entry: entry({ title: "另一个快照" }) })] }))
  assert.equal(report.entriesUpdated, 1); assert.equal(report.conversionsRestored, 0)
  assert.deepEqual((await h.db.meta.get("scheduleConversions")).value[0], first)
})
test("keepLocal preserves existing linked resources and malformed imports write nothing", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.schedules.put(terminal()); await h.db.entries.put(entry())
  const report = await api.importAll(backup({ schedules: [terminal({ title: "备份预简" })],
    entries: [entry({ title: "备份日记" })] }), "keepLocal")
  assert.equal(report.schedulesSkipped, 1); assert.equal(report.entriesSkipped, 1)
  assert.equal((await h.db.entries.get(ID)).title, "日记")
  assert.equal((await h.db.schedules.get(ID)).title, "预简")
  const before = JSON.stringify([...h.stores.meta.rows.values()])
  await assert.rejects(api.importAll(backup({ schedules: [schedule(), schedule()] })), /重复/)
  assert.equal(JSON.stringify([...h.stores.meta.rows.values()]), before)
})
test("full media export and restore retain bytes with v3 schedules", async () => {
  const h = setup(); const api = h.load("db/backupRepo.ts").localBackupRepo
  await h.db.schedules.put(schedule())
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null }))
  const bytes = [137, 80, 78, 71, 13, 10, 26, 10]
  const media = { id: "019a0300-1234-7000-8000-000000000003", entryId: OTHER_ID,
    mime: "image/png", size: bytes.length, width: 1, height: 1, sortOrder: 0, createdAt: AT,
    remoteUrl: "", dirty: 1, blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }), thumbBlob: null }
  await h.db.media.put(media)
  const file = await api.exportAll()
  assert.equal(file.counts.media, 1); assert.equal(file.counts.schedules, 1)
  const target = setup(); await target.load("db/backupRepo.ts").localBackupRepo.importAll(file)
  assert.deepEqual([...new Uint8Array(await (await target.db.media.get(media.id)).blob.arrayBuffer())], bytes)
  assert.equal(target.stores.schedules.rows.size, 1)
})
