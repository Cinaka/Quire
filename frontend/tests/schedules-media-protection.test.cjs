const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, AT, content, entry, schedule, backup, setup } = require("./schedules-data-harness.cjs")
const PHOTO = "019a0300-1234-7000-8000-000000000009"
const OLD = "2026-10-01T10:00:00.000Z"
class Clock extends Date { static now() { return Date.parse("2026-10-11T10:00:00.000Z") } }
const image = id => ({ schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: `local://media/${id}` } }] } })
const photo = extra => ({ id: PHOTO, entryId: ID, blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
  thumbBlob: null, mime: "image/png", size: 4, width: 1, height: 1, sortOrder: 0,
  remoteUrl: "", thumbRemoteUrl: "", createdAt: OLD, orphanedAt: null, dirty: 1, ...extra })
function harness(extra = {}) {
  const time = { ...loadTS("shared/time.ts"), todayLocal: () => "2026-10-08", utcNow: () => AT }
  const h = setup({ "./time": time, "@/shared/time": time,
    "@/capabilities/image": { resizeToBlob: async () => null }, ...extra }, { Date: Clock })
  const media = h.load("db/mediaRepo.ts").localMediaRepo
  h.mocks["./mediaRepo"] = { localMediaRepo: media }
  return { ...h, media, repo: h.load("db/scheduleRepo.ts").localScheduleRepo,
    entries: h.load("db/entryRepo.ts").localEntryRepo,
    guards: h.load("db/scheduleStateRepo.ts"), backups: h.load("db/backupRepo.ts").localBackupRepo }
}
async function convert(h, owned = false) {
  if (owned) await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.schedules.put(schedule({ remindDate: "2026-10-08" }))
  await h.repo.convert(ID, { expectedClientUpdatedAt: AT })
}
const queue = async h => (await h.db.meta.get("scheduleConversions"))?.value ?? []
const snapshot = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([name, table]) => [name, [...table.rows.values()]])))
async function addedPhoto(h) {
  await h.db.media.put(photo({ entryId: "", orphanedAt: OLD }))
  await h.entries.update(ID, { content: image(PHOTO) })
  await h.media.attach(ID, [PHOTO])
}
async function confirmed(h) {
  await h.db.transaction("rw", h.db.meta, h.db.schedules, async () => {
    await h.db.meta.put({ key: "scheduleConversions", value: [] })
    await h.db.schedules.update(ID, { dirty: 0, serverUpdatedAt: AT })
  })
}

test("new photo survives Entry purge with held IDs while the first text snapshot stays immutable", async () => {
  const h = harness(); await convert(h); const first = JSON.stringify((await queue(h))[0].entry)
  await addedPhoto(h); await h.entries.purge(ID)
  const held = (await queue(h))[0]
  assert.ok(held.protectedMediaIds.includes(PHOTO)); assert.equal(JSON.stringify(held.entry), first)
  assert.equal(held.entry.contentText, "计划"); assert.equal((await h.db.entries.get(ID)).content, null)
  assert.equal((await h.db.media.get(PHOTO)).entryId, "")
  assert.equal((await h.guards.protectedConversions()).mediaIds.has(PHOTO), true)
  await h.media.reconcileAll(); await h.media.purgeOrphans()
  assert.equal((await h.db.media.get(PHOTO)).blob.size, 4)
})
test("removing an image from Entry JSON retains its guard before the reference disappears", async () => {
  const h = harness(); await convert(h); await addedPhoto(h)
  await h.entries.update(ID, { content: content("删掉图片后的日记") })
  await h.media.attach(ID, [])
  assert.equal((await h.db.media.get(PHOTO)).entryId, "")
  assert.equal((await h.guards.protectedConversions()).mediaIds.has(PHOTO), true)
  assert.equal((await queue(h))[0].entry.contentText, "计划")
})
test("attach captures existing associations before detaching even without a current body reference", async () => {
  const h = harness(); await convert(h); await h.db.media.put(photo())
  await h.media.attach(ID, [])
  assert.ok((await queue(h))[0].protectedMediaIds.includes(PHOTO))
  assert.equal((await h.db.media.get(PHOTO)).entryId, "")
})
test("reconciliation retains a legacy association before marking it orphaned", async () => {
  const h = harness(); await convert(h); await h.db.media.put(photo())
  const changed = await h.media.reconcileAll()
  assert.equal(changed, 1); assert.equal((await h.db.media.get(PHOTO)).entryId, "")
  assert.equal((await h.guards.protectedConversions()).mediaIds.has(PHOTO), true)
})
test("clean stale held orphans cannot be removed, while unrelated confirmed orphans keep P2 behavior", async () => {
  const h = harness(); await convert(h); await addedPhoto(h); await h.entries.purge(ID)
  await h.db.media.update(PHOTO, { dirty: 0, orphanedAt: OLD })
  await h.db.media.put(photo({ id: "ordinary-clean", entryId: "", dirty: 0, orphanedAt: OLD }))
  await h.db.media.put(photo({ id: "ordinary-dirty", entryId: "", dirty: 1, orphanedAt: OLD }))
  assert.equal(await h.media.purgeOrphans(), 1)
  assert.ok(await h.db.media.get(PHOTO)); assert.ok(await h.db.media.get("ordinary-dirty"))
  assert.equal(await h.db.media.get("ordinary-clean"), undefined)
})
test("guards have no TTL and a simulated atomic conversion receipt allows normal orphan cleanup", async () => {
  const h = harness(); await convert(h); await addedPhoto(h); await h.entries.purge(ID)
  await h.db.media.update(PHOTO, { dirty: 0, orphanedAt: OLD })
  assert.equal(await h.media.purgeOrphans(1), 0)
  await confirmed(h)
  assert.equal((await h.guards.protectedConversions()).mediaIds.has(PHOTO), false)
  assert.equal(await h.media.purgeOrphans(1), 1)
})
test("held IDs survive missing Entry and media-entry association without regenerating content", async () => {
  const h = harness(); await convert(h); await addedPhoto(h); await h.entries.purge(ID)
  await h.db.entries.delete(ID)
  assert.equal((await h.guards.protectedConversions()).mediaIds.has(PHOTO), true)
  const result = await h.repo.convert(ID, { expectedClientUpdatedAt: AT })
  assert.equal(result.entryState, "purged"); assert.equal(h.stores.entries.rows.size, 0)
})
test("capture failure during Entry update leaves body, media and queue unchanged", async () => {
  const h = harness(); await convert(h); await h.db.media.put(photo({ entryId: "" }))
  const before = snapshot(h); h.failNext("meta")
  await assert.rejects(h.entries.update(ID, { content: image(PHOTO) }), /injected/)
  assert.equal(snapshot(h), before)
})
test("attach media write failure rolls back the newly retained guard IDs too", async () => {
  const h = harness(); await convert(h); await h.db.media.put(photo())
  const before = snapshot(h); h.failNext("media")
  await assert.rejects(h.media.attach(ID, []), /injected/); assert.equal(snapshot(h), before)
})
test("purge failure rolls back candidate tombstone, media detachment and guard capture", async () => {
  const h = harness(); await convert(h); await h.db.media.put(photo())
  const before = snapshot(h); h.failNext("media", "modify")
  await assert.rejects(h.entries.purge(ID), /injected/); assert.equal(snapshot(h), before)
})
test("reconciliation failure rolls back guard capture and old media associations", async () => {
  const h = harness(); await convert(h); await h.db.media.put(photo())
  const before = snapshot(h); h.failNext("media")
  await assert.rejects(h.media.reconcileAll(), /injected/); assert.equal(snapshot(h), before)
})
test("missing unconfirmed intent or a foreign-owned queue fails closed before detaching media", async () => {
  for (const kind of ["missing", "foreign"]) {
    const h = harness(); await convert(h); await h.db.media.put(photo())
    const raw = await queue(h)
    await h.db.meta.put({ key: "scheduleConversions", value: kind === "missing" ? [] : raw.map(item => ({ ...item, ownerUserId: "foreign" })) })
    const before = snapshot(h); await assert.rejects(h.entries.purge(ID), /意图|归属/)
    assert.equal(snapshot(h), before)
  }
})
test("ordinary and confirmed converted Entry purges do not manufacture protection intentions", async () => {
  for (const converted of [false, true]) {
    const h = harness()
    if (converted) { await convert(h); await confirmed(h) }
    else await h.db.entries.put(entry({ entryDate: "2026-10-08", fromScheduleId: null }))
    await h.db.media.put(photo())
    await h.entries.purge(ID)
    assert.equal((await queue(h)).length, 0); assert.equal((await h.db.media.get(PHOTO)).entryId, "")
    assert.equal((await h.db.entries.get(ID)).isDeleted, 1)
  }
})
test("old v3 without optional media guards remains valid; invalid guard arrays fail before import", async () => {
  const h = harness(); await convert(h)
  const file = await h.backups.exportAll()
  assert.equal(file.formatVersion, 3); assert.equal(file.scheduleConversions[0].protectedMediaIds, undefined)
  for (const held of [null, "bad", [1], [""], [PHOTO, PHOTO]]) {
    const bad = structuredClone(file); bad.scheduleConversions[0].protectedMediaIds = held
    const before = snapshot(h); await assert.rejects(h.backups.importAll(bad), /意图/)
    assert.equal(snapshot(h), before)
  }
})
test("backup exports protected media IDs without owner/secrets and asCopy maps held IDs and bytes", async () => {
  const h = harness(); await convert(h, true); await addedPhoto(h); await h.entries.purge(ID)
  const file = await h.backups.exportAll()
  assert.ok(file.scheduleConversions[0].protectedMediaIds.includes(PHOTO))
  assert.equal(file.scheduleConversions[0].ownerUserId, undefined)
  const restored = harness(); await restored.backups.importAll(file, "asCopy")
  const held = (await queue(restored))[0]; const media = [...restored.stores.media.rows.values()][0]
  assert.notEqual(media.id, PHOTO); assert.ok(held.protectedMediaIds.includes(media.id))
  assert.equal((await restored.guards.protectedConversions()).mediaIds.has(media.id), true)
  assert.equal(media.blob.size, 4)
  const result = await restored.repo.convert(held.scheduleId, { expectedClientUpdatedAt: held.source.clientUpdatedAt })
  assert.equal(result.entryState, "deleted"); assert.equal(result.entry.content, null)
})
test("reimport merges guard associations but never replaces a first conversion snapshot", async () => {
  const h = harness(); await convert(h); await addedPhoto(h); await h.entries.purge(ID)
  const file = await h.backups.exportAll(); const held = (await queue(h))[0]
  const first = JSON.stringify(held.entry); delete held.protectedMediaIds
  await h.db.meta.put({ key: "scheduleConversions", value: [held] })
  file.scheduleConversions[0].entry.title = "备份的另一个快照"
  await h.backups.importAll(file, "keepLocal")
  assert.equal(JSON.stringify((await queue(h))[0].entry), first)
  assert.ok((await queue(h))[0].protectedMediaIds.includes(PHOTO))
})
test("asCopy remaps lingering media associations even when the physical Entry is absent", async () => {
  const h = harness(); await convert(h); await addedPhoto(h); await h.entries.purge(ID)
  await h.db.entries.delete(ID); await h.db.media.update(PHOTO, { entryId: ID })
  const file = await h.backups.exportAll(); const restored = harness()
  await restored.backups.importAll(file, "asCopy")
  const held = (await queue(restored))[0]; assert.notEqual(held.scheduleId, ID)
  assert.equal(restored.stores.entries.rows.size, 0)
  const media = [...restored.stores.media.rows.values()][0]
  assert.equal(media.entryId, ""); assert.ok(held.protectedMediaIds.includes(media.id))
  assert.equal((await restored.guards.protectedConversions()).mediaIds.has(media.id), true)
})
test("real backup reconciliation needs a compatible nested table scope", async () => {
  const h = harness()
  await assert.rejects(h.db.transaction("rw", h.db.entries, h.db.media, h.db.meta, () => h.media.reconcileAll()), /outside its parent/)
  const file = backup()
  await h.backups.importAll(file) // production outer transaction includes schedules now
})
test("malformed held index stops cleanup rather than treating protected bytes as an ordinary orphan", async () => {
  const h = harness(); await convert(h); await addedPhoto(h); await h.entries.purge(ID)
  const rows = await queue(h); rows[0].protectedMediaIds = "broken"
  await h.db.meta.put({ key: "scheduleConversions", value: rows })
  const before = snapshot(h); await assert.rejects(h.media.purgeOrphans(), /索引损坏/)
  assert.equal(snapshot(h), before)
})
test("actual P2 sync cannot upload or acknowledge the new photo after purge, then resumes after receipt", async () => {
  const sent = []; const uploads = []
  const mappers = { fromWireEntry: row => row, fromWireTag: row => row, mediaPatchFromWire: row => row,
    toWireEntry: row => row, toWireMediaMetaPush: row => row, toWireTag: row => row }
  const h = harness({ "@/api/mappers": mappers, "@/api/endpoints": {
    pushBatch: async body => { sent.push(body); return { serverTime: AT,
      entries: body.entries.map(row => ({ id: row.id, status: "applied" })),
      tags: [], mediaMeta: body.mediaMeta.map(row => ({ id: row.id, status: "applied" })) } },
    uploadMedia: async (...args) => { uploads.push(args) },
    pullChanges: async () => ({ serverTime: AT, syncUntil: AT, cursorId: "", hasMore: false, entries: [], tags: [], mediaMeta: [] }),
  } })
  await convert(h, true); await addedPhoto(h); await h.entries.purge(ID)
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null }))
  const sync = h.load("api/sync.ts")
  await sync.runSync()
  assert.equal(sent.length, 1); assert.equal(sent[0].entries[0].id, OTHER_ID)
  assert.equal(sent[0].mediaMeta.length, 0); assert.equal(uploads.length, 0)
  assert.equal((await h.db.media.get(PHOTO)).dirty, 1); assert.ok(await h.db.entries.get(ID))
  await confirmed(h); await sync.runSync()
  assert.equal(sent[1].entries[0].id, ID); assert.equal(sent[1].entries[0].isDeleted, 1)
  assert.equal(sent[1].mediaMeta[0].id, PHOTO); assert.equal(uploads.length, 0)
  assert.equal((await h.db.media.get(PHOTO)).dirty, 0); assert.equal(await h.db.entries.get(ID), undefined)
})

test("acknowledging the source alone does not release media while an intention remains", async () => {
  const h = harness(); await convert(h); await addedPhoto(h); await h.entries.purge(ID)
  await h.db.schedules.update(ID, { dirty: 0, serverUpdatedAt: AT })
  await h.db.media.update(PHOTO, { dirty: 0, orphanedAt: OLD })
  assert.equal((await h.guards.protectedConversions()).mediaIds.has(PHOTO), true)
  assert.equal(await h.media.purgeOrphans(1), 0)
})
test("P2 pulls cannot refill remote metadata for a detached protected image", async () => {
  const h = harness({ "@/api/mappers": {
    fromWireEntry: row => row, fromWireTag: row => row, mediaPatchFromWire: row => row,
    toWireEntry: row => row, toWireMediaMetaPush: row => row, toWireTag: row => row,
  }, "@/api/endpoints": {
    pushBatch: async () => { throw new Error("no ordinary work expected") }, uploadMedia: async () => { throw new Error("held upload forbidden") },
    pullChanges: async () => ({ serverTime: AT, syncUntil: AT, cursorId: "", hasMore: false,
      entries: [], tags: [], mediaMeta: [{ id: PHOTO, entry_id: "", remoteUrl: "should-not-overwrite" }] }),
  } })
  await convert(h, true); await addedPhoto(h); await h.entries.purge(ID)
  await h.load("api/sync.ts").runSync()
  assert.equal((await h.db.media.get(PHOTO)).remoteUrl, "")
  assert.equal((await h.db.media.get(PHOTO)).dirty, 1)
})
