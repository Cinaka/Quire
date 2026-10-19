const { test } = require("node:test")
const assert = require("node:assert/strict")
const { ID, OTHER_ID, AT, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const mappers = { fromWireEntry: r => r, fromWireTag: r => r, mediaPatchFromWire: r => r,
  toWireEntry: r => r, toWireTag: r => r, toWireMediaMetaPush: r => r }
const tag = (id, extra = {}) => ({ id, name: id, color: "green", createdAt: AT, dirty: 1, ...extra })
const emptyPull = { serverTime: AT, syncUntil: AT, cursorId: "", hasMore: false,
  entries: [], tags: [], mediaMeta: [] }
async function fixture(options = {}) {
  const sent = []; const uploads = []
  const h = setup({ "@/api/mappers": mappers, "@/api/endpoints": {
    pushBatch: async body => {
      sent.push(structuredClone(body))
      if (options.onPush) return options.onPush(body, h)
      return { serverTime: AT, entries: body.entries.map(r => ({ id: r.id, status: "applied" })),
        tags: body.tags.map(r => ({ id: r.id, status: "applied" })),
        mediaMeta: body.mediaMeta.map(r => ({ id: r.id, status: "applied" })) }
    },
    uploadMedia: async (...args) => { uploads.push(args); await options.onUpload?.(h) },
    pullChanges: async () => ({ ...emptyPull, ...options.pull }),
  } })
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "ownerGeneration", value: "epoch-a" })
  await h.db.meta.put({ key: "lastSyncAt", value: AT })
  return Object.assign(h, { sent, uploads, sync: h.load("api/sync.ts"),
    guard: h.load("db/scheduleStateRepo.ts").protectedConversions })
}
async function protect(h, tags = ["held"]) {
  await h.db.schedules.put(terminal())
  await h.db.entries.put(entry({ tagIds: tags }))
  await h.db.meta.put({ key: "scheduleConversions", value: [intent({ ownerUserId: "account-a",
    entry: entry({ tagIds: tags }) })] })
}
test("held shared tags and dependent ordinary entries wait; unrelated records continue", async () => {
  const h = await fixture(); await protect(h)
  await h.db.tags.put(tag("held")); await h.db.tags.put(tag("free"))
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, tagIds: ["held"] }))
  await h.db.entries.put(entry({ id: "ordinary", fromScheduleId: null, tagIds: ["free"] }))
  await h.sync.runSync()
  assert.deepEqual(h.sent[0].tags.map(r => r.id), ["free"])
  assert.deepEqual(h.sent[0].entries.map(r => r.id), ["ordinary"])
  assert.equal((await h.db.tags.get("held")).dirty, 1)
  assert.equal((await h.db.entries.get(OTHER_ID)).dirty, 1)
})
for (const dirty of [0, 1, "missing"]) test(`pull cannot replace or insert held tag (${dirty})`, async () => {
  const h = await fixture({ pull: { tags: [tag("held", { name: "cloud" }), tag("free")] } })
  await protect(h)
  if (dirty !== "missing") await h.db.tags.put(tag("held", { dirty }))
  await h.sync.runSync()
  assert.equal((await h.db.tags.get("held"))?.name, dirty === "missing" ? undefined : "held")
  assert.equal((await h.db.tags.get("free")).name, "free")
})
test("new server candidate tag references are protected before same-page tag merge", async () => {
  const h = await fixture({ pull: { entries: [entry({ tagIds: ["server-only"] })],
    tags: [tag("server-only")] } })
  await protect(h); await h.sync.runSync()
  assert.equal(await h.db.tags.get("server-only"), undefined)
  assert.ok((await h.guard()).tagIds.has("server-only"))
})
test("first snapshot and historical candidates retain removed tag references without writes", async () => {
  const h = await fixture(); await protect(h, ["first"])
  await h.db.entries.update(ID, { tagIds: ["current"] })
  await h.db.meta.put({ key: "scheduleConflicts", value: [
    { scheduleId: ID, kind: "conversion-entry", localEntry: entry({ tagIds: ["older"] }),
      serverEntry: entry({ tagIds: ["remote"] }) },
    { scheduleId: ID, kind: "conversion-ack", firstIntent: intent({ entry: entry({ tagIds: ["intent-old"] }) }) },
    { scheduleId: OTHER_ID, serverEntry: entry({ tagIds: ["unrelated"] }) },
  ] })
  const before = JSON.stringify(await h.db.meta.toArray())
  assert.deepEqual([...(await h.guard()).tagIds].sort(), ["current", "first", "intent-old", "older", "remote"])
  assert.equal(JSON.stringify(await h.db.meta.toArray()), before)
})
for (const malformed of [null, "held", [""], [null], [3]]) test(`malformed protected tag list fails closed: ${JSON.stringify(malformed)}`, async () => {
  const h = await fixture(); await protect(h)
  await h.db.entries.update(ID, { tagIds: malformed })
  await assert.rejects(h.sync.runSync(), /标签/)
  assert.equal(h.sent.length, 0)
})
for (const status of ["applied", "error"]) test(`in-flight ${status} acknowledgment cannot clear or rename newly held tag`, async () => {
  const h = await fixture({ onPush: async (body, state) => {
    await protect(state, ["alias"])
    return { serverTime: AT, entries: [], tags: [{ id: "alias", status,
      message: "duplicate_tag:canonical" }], mediaMeta: [] }
  } })
  await h.db.tags.put(tag("alias")); await h.sync.runSync()
  assert.equal((await h.db.tags.get("alias")).dirty, 1)
  assert.deepEqual((await h.db.entries.get(ID)).tagIds, ["alias"])
})
test("duplicate canonical target protected: no alias deletion or dependent entry rewriting", async () => {
  const h = await fixture({ onPush: async () => ({ serverTime: AT, entries: [],
    tags: [{ id: "alias", status: "error", message: "duplicate_tag:held" }], mediaMeta: [] }) })
  await protect(h); await h.db.tags.put(tag("alias"))
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, tagIds: ["alias"], dirty: 0 }))
  for (let attempt = 0; attempt < 4; attempt++) await h.sync.runSync()
  assert.ok(await h.db.tags.get("alias"))
  assert.equal(await h.db.meta.get("syncErrors"), undefined)
  assert.deepEqual((await h.db.entries.get(OTHER_ID)).tagIds, ["alias"])
})
test("ordinary duplicate tag reconciliation still works when no protected reference exists", async () => {
  let first = true
  const h = await fixture({ onPush: async body => {
    const result = { serverTime: AT, entries: body.entries.map(r => ({ id: r.id, status: "applied" })),
      tags: first ? [{ id: "alias", status: "error", message: "duplicate_tag:canonical" }] : [], mediaMeta: [] }
    first = false; return result
  } })
  await h.db.tags.put(tag("alias"))
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, tagIds: ["alias"], dirty: 0 }))
  await h.sync.runSync()
  assert.equal(await h.db.tags.get("alias"), undefined)
  assert.deepEqual((await h.db.entries.get(OTHER_ID)).tagIds, ["canonical"])
})
test("protection appearing during media upload is rechecked before sending tags or dependent entries", async () => {
  const h = await fixture({ onUpload: async state => protect(state) })
  await h.db.tags.put(tag("held")); await h.db.tags.put(tag("free"))
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, tagIds: ["held"] }))
  await h.db.media.put({ id: "ordinary-photo", entryId: OTHER_ID, blob: new Blob(["x"]), dirty: 1 })
  await h.sync.runSync()
  assert.equal(h.uploads.length, 1)
  assert.ok(h.sent.every(body => body.tags.every(r => r.id !== "held") && body.entries.every(r => r.id !== OTHER_ID)))
  assert.equal((await h.db.tags.get("held")).dirty, 1)
})
test("late entry ACK retains dirty when a shared tag becomes protected in flight", async () => {
  const h = await fixture({ onPush: async body => {
    await protect(h)
    return { serverTime: AT, entries: body.entries.map(r => ({ id: r.id, status: "applied" })), tags: [], mediaMeta: [] }
  } })
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, tagIds: ["held"] }))
  await h.sync.runSync(); assert.equal((await h.db.entries.get(OTHER_ID)).dirty, 1)
})
test("protection releases only after queue removal and confirmed clean source", async () => {
  const h = await fixture(); await protect(h); await h.db.tags.put(tag("held"))
  await h.sync.runSync(); assert.equal(h.sent.length, 0)
  await h.db.meta.put({ key: "scheduleConversions", value: [] })
  await h.db.schedules.update(ID, { dirty: 0, serverUpdatedAt: AT })
  await h.db.entries.update(ID, { dirty: 0 })
  await h.sync.runSync(); assert.equal((await h.db.tags.get("held")).dirty, 0)
})
