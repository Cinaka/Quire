const { test } = require("node:test")
const assert = require("node:assert/strict")
const { ID, OTHER_ID, AT, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const mappers = {
  fromWireEntry: row => row, fromWireTag: row => row, mediaPatchFromWire: row => row,
  toWireEntry: row => row, toWireMediaMetaPush: row => row, toWireTag: row => row,
}
const pull = extra => ({ serverTime: AT, syncUntil: AT, cursorId: "", hasMore: false,
  entries: [], tags: [], mediaMeta: [], ...extra })
async function owned(h) {
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "ownerGeneration", value: "epoch-a" })
}
test("P2 processes ordinary records but cannot send/overwrite/purge an unconfirmed conversion", async () => {
  const sent = []; const uploads = []
  const h = setup({ "@/api/mappers": mappers, "@/api/endpoints": {
    pushBatch: async (body, owner) => { sent.push({ body, owner }); return {
      serverTime: AT, entries: body.entries.map(row => ({ id: row.id, status: "applied" })),
      tags: [], mediaMeta: body.mediaMeta.map(row => ({ id: row.id, status: "applied" })),
    } },
    uploadMedia: async (...args) => { uploads.push(args) },
    pullChanges: async () => pull({ entries: [entry({ title: "云端旧副本", clientUpdatedAt: "2026-10-08T12:00:00.000Z" })] }),
  } })
  await owned(h)
  await h.db.schedules.put(terminal()); await h.db.entries.put(entry())
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, title: "普通日记" }))
  await h.db.meta.put({ key: "scheduleConversions", value: [{ ...intent(), ownerUserId: "account-a" }] })
  await h.db.meta.put({ key: "pendingPurges", value: [ID] })
  await h.db.media.put({ id: "photo", entryId: ID, blob: new Blob(["x"]), thumbBlob: null, dirty: 1 })
  const api = h.load("api/sync.ts")
  await api.runSync(); await api.runSync()
  assert.equal(sent.length, 1); assert.equal(sent[0].owner, "account-a")
  assert.equal(sent[0].body.entries.length, 1); assert.equal(sent[0].body.entries[0].id, OTHER_ID)
  assert.equal(uploads.length, 0)
  assert.equal((await h.db.entries.get(OTHER_ID)).dirty, 0)
  assert.equal((await h.db.entries.get(ID)).dirty, 1)
  assert.equal((await h.db.entries.get(ID)).title, "日记")
  assert.equal((await h.db.meta.get("pendingPurges")).value[0], ID)
  assert.equal((await h.db.meta.get("scheduleConflicts")).value[0].serverEntry.title, "云端旧副本")
})
test("a late upload response cannot clear dirty or write cursors after account switching", async () => {
  let release; let started
  const startedPromise = new Promise(resolve => { started = resolve })
  const response = new Promise(resolve => { release = resolve })
  const h = setup({ "@/api/mappers": mappers, "@/api/endpoints": {
    pushBatch: async () => { started(); return response }, uploadMedia: async () => {}, pullChanges: async () => pull(),
  } })
  await owned(h); await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null }))
  const pending = h.load("api/sync.ts").runSync()
  await startedPromise
  h.user("account-b")
  await h.db.meta.put({ key: "ownerUserId", value: "account-b" })
  await h.db.meta.put({ key: "ownerGeneration", value: "epoch-b" })
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, title: "B本地" }))
  release({ serverTime: AT, entries: [{ id: OTHER_ID, status: "applied" }], tags: [], mediaMeta: [] })
  await assert.rejects(pending, /会话已变化/)
  assert.equal((await h.db.entries.get(OTHER_ID)).dirty, 1)
  assert.equal((await h.db.entries.get(OTHER_ID)).title, "B本地")
  assert.equal(await h.db.meta.get("lastSyncAt"), undefined)
})
test("same-owner restore also invalidates late acknowledgments through the DB epoch", async () => {
  let release; let start
  const startPromise = new Promise(resolve => { start = resolve })
  const response = new Promise(resolve => { release = resolve })
  const h = setup({ "@/api/mappers": mappers, "@/api/endpoints": {
    pushBatch: async () => { start(); return response }, uploadMedia: async () => {}, pullChanges: async () => pull(),
  } })
  await owned(h); await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null }))
  const pending = h.load("api/sync.ts").runSync(); await startPromise
  await h.db.meta.put({ key: "ownerGeneration", value: "restored-batch" })
  release({ serverTime: AT, entries: [{ id: OTHER_ID, status: "applied" }], tags: [], mediaMeta: [] })
  await assert.rejects(pending, /恢复批次/)
  assert.equal((await h.db.entries.get(OTHER_ID)).dirty, 1)
})
test("cloud status counts restored schedules so ordinary P2 completion is not reported as all data complete", async () => {
  const h = setup(); await owned(h); await h.db.schedules.put(terminal())
  const api = h.load("db/syncRepo.ts").localSyncRepo
  const status = await api.status(); const items = await api.pending()
  assert.equal(status.dirtySchedules, 1); assert.equal(status.dirtyTotal, 1)
  assert.equal(items[0].kind, "schedule"); assert.match(items[0].detail, /尚未启用/)
})
