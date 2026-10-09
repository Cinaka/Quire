const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, AT, content, schedule, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const TODAY = "2026-10-08"
function harness() {
  const time = { ...loadTS("shared/time.ts"), todayLocal: () => TODAY, utcNow: () => AT }
  const h = setup({ "./time": time, "@/shared/time": time })
  return { ...h, repo: h.load("db/scheduleRepo.ts").localScheduleRepo,
    entryRepo: h.load("db/entryRepo.ts").localEntryRepo }
}
const request = extra => ({ expectedClientUpdatedAt: AT, ...extra })
const due = extra => schedule({ remindDate: TODAY, ...extra })
const queue = async h => (await h.db.meta.get("scheduleConversions"))?.value ?? []
const state = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([key, store]) => [key, [...store.rows.values()]])))

test("due conversion atomically creates a text Entry, terminal source and first intent", async () => {
  const h = harness(); await h.db.schedules.put(due({ contentText: "不可相信的派生值" }))
  const result = await h.repo.convert(ID, request())
  assert.equal(result.created, true); assert.equal(result.entryState, "active"); assert.equal(result.pendingConfirmation, true)
  assert.equal(result.entry.id, ID); assert.equal(result.entry.fromScheduleId, ID)
  assert.equal(result.entry.entryDate, TODAY); assert.equal(result.entry.contentText, "计划")
  assert.equal(result.entry.sortOrder, 0); assert.equal(result.entry.serverUpdatedAt, ""); assert.equal(result.entry.dirty, 1)
  assert.equal(result.entry.mood, null); assert.equal(result.entry.weather, null); assert.equal(JSON.stringify(result.entry.tagIds), "[]")
  assert.equal(result.schedule.status, "converted"); assert.equal(result.schedule.convertedEntryId, ID)
  assert.equal(result.schedule.clientUpdatedAt, "2026-10-08T10:00:00.001Z")
  const first = (await queue(h))[0]
  assert.equal(first.source.status, "pending"); assert.equal(first.source.clientUpdatedAt, AT)
  assert.equal(first.source.contentText, "计划"); assert.equal(first.ownerUserId, "")
  assert.equal(JSON.stringify(first.entry), JSON.stringify(result.entry))
  result.entry.content.doc.content[0].content[0].text = "返回值修改"
  assert.equal((await h.db.entries.get(ID)).contentText, "计划")
  assert.equal((await queue(h))[0].entry.content.doc.content[0].content[0].text, "计划")
})
test("overdue conversion defaults to original date and can explicitly choose another elapsed day", async () => {
  for (const target of [undefined, "2026-10-06", TODAY]) {
    const h = harness(); await h.db.schedules.put(due({ remindDate: "2026-10-01" }))
    const result = await h.repo.convert(ID, request({ entryDate: target }))
    assert.equal(result.entry.entryDate, target ?? "2026-10-01")
    assert.equal(result.schedule.remindDate, "2026-10-01")
  }
})
test("title-only and text-only sources retain content without adding diary metadata", async () => {
  for (const extra of [{ title: "只有标题", content: null }, { title: "", content: content("只有正文") }]) {
    const h = harness(); await h.db.schedules.put(due(extra))
    const result = await h.repo.convert(ID, request())
    assert.equal(result.entry.title, extra.title); assert.deepEqual(result.entry.content, extra.content)
    assert.deepEqual((await queue(h))[0].source.content, extra.content)
  }
})
test("future, deleted, empty and unsupported sources fail without partial writes", async () => {
  for (const row of [schedule(), due({ isDeleted: 1, deletedAt: AT }), due({ title: " ", content: null }),
    due({ content: { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image" }] } } }),
    due({ content: { schemaVersion: 9, doc: { type: "doc", content: [] } } })]) {
    const h = harness(); await h.db.schedules.put(row); const before = state(h)
    await assert.rejects(h.repo.convert(ID, request())); assert.equal(state(h), before)
  }
})
test("invalid or future target dates cannot create a future Entry", async () => {
  for (const date of ["2026-02-29", "2026-10-09", "", "2026/10/08"]) {
    const h = harness(); await h.db.schedules.put(due()); const before = state(h)
    await assert.rejects(h.repo.convert(ID, request({ entryDate: date })))
    assert.equal(state(h), before)
  }
})
test("missing source, malformed ID and missing/malformed expected revision fail closed", async () => {
  const h = harness()
  await assert.rejects(h.repo.convert(ID, request()), /不存在/)
  await h.db.schedules.put(due())
  for (const [id, req] of [["bad", request()], [ID.toUpperCase(), request()], [ID, {}], [ID, request({ expectedClientUpdatedAt: "bad" })]]) {
    await assert.rejects(h.repo.convert(id, req))
  }
  assert.equal(h.stores.entries.rows.size, 0); assert.equal((await queue(h)).length, 0)
})
test("stale source revision cannot silently convert a newer edit or reschedule", async () => {
  const h = harness(); await h.db.schedules.put(due())
  await h.repo.update(ID, { title: "后来编辑", remindDate: "2026-10-07" })
  const before = state(h)
  await assert.rejects(h.repo.convert(ID, request()), /重新读取/); assert.equal(state(h), before)
})
test("deletion winning the local transaction race prevents conversion without creating a candidate", async () => {
  const h = harness(); await h.db.schedules.put(due())
  await Promise.all([
    h.repo.remove(ID),
    assert.rejects(h.repo.convert(ID, request()), /已删除/),
  ])
  assert.equal(h.stores.entries.rows.size, 0); assert.equal((await queue(h)).length, 0)
  assert.equal((await h.db.schedules.get(ID)).status, "pending")
})
test("conversion winning before source deletion retains the terminal identity and intent", async () => {
  const h = harness(); await h.db.schedules.put(due())
  await h.repo.convert(ID, request())
  await h.repo.remove(ID)
  assert.equal((await h.db.schedules.get(ID)).isDeleted, 1)
  assert.equal((await h.db.schedules.get(ID)).status, "converted")
  assert.equal((await queue(h))[0].source.isDeleted, 0)
  assert.equal((await h.repo.convert(ID, request())).created, false)
})
test("main key collision and nonstable/duplicate source links never overwrite old diaries", async () => {
  for (const rows of [[entry({ fromScheduleId: null })], [entry({ id: OTHER_ID })], [entry(), entry({ id: OTHER_ID })], [entry()]]) {
    const h = harness(); await h.db.schedules.put(due())
    for (const row of rows) await h.db.entries.put(row)
    const before = state(h)
    await assert.rejects(h.repo.convert(ID, request()), /冲突|不完整/); assert.equal(state(h), before)
  }
})
test("two independent callers repeatedly converting one source produce one diary and one intent", async () => {
  const h = harness(); await h.db.schedules.put(due())
  const other = h.load("db/scheduleRepo.ts").localScheduleRepo
  const results = await Promise.all([h.repo.convert(ID, request()), other.convert(ID, request()), h.repo.convert(ID, request())])
  assert.equal(results.filter(result => result.created).length, 1)
  assert.ok(results.every(result => result.entry.id === ID))
  assert.equal(h.stores.entries.rows.size, 1); assert.equal((await queue(h)).length, 1)
})
test("conversion sorting matches existing day rules and ignores deleted/other-day rows", async () => {
  const h = harness(); await h.db.schedules.put(due())
  await h.db.entries.put(entry({ id: OTHER_ID, fromScheduleId: null, entryDate: TODAY, sortOrder: 7 }))
  await h.db.entries.put(entry({ id: "other-day", fromScheduleId: null, entryDate: "2026-10-07", sortOrder: 99 }))
  await h.db.entries.put(entry({ id: "deleted", fromScheduleId: null, entryDate: TODAY, sortOrder: 999, isDeleted: 1, deletedAt: AT }))
  const result = await h.repo.convert(ID, request()); assert.equal(result.entry.sortOrder, 8)
})
test("different sources converting concurrently preserve both queue items and unique local ordering", async () => {
  const h = harness(); await h.db.schedules.put(due()); await h.db.schedules.put(due({ id: OTHER_ID }))
  const results = await Promise.all([h.repo.convert(ID, request()), h.repo.convert(OTHER_ID, request())])
  assert.deepEqual(results.map(row => row.entry.sortOrder).sort(), [0, 1])
  assert.equal((await queue(h)).length, 2)
})
for (const table of ["entries", "schedules", "meta"]) {
  test(`conversion rolls back source, candidate and intent if ${table} write fails`, async () => {
    const h = harness(); await h.db.schedules.put(due()); const before = state(h)
    h.failNext(table)
    await assert.rejects(h.repo.convert(ID, request()), /injected/)
    assert.equal(state(h), before)
    assert.equal((await h.repo.convert(ID, request())).created, true)
  })
}
test("login owner binds conversion intentions without starting cloud requests", async () => {
  const h = harness(); await h.db.meta.put({ key: "ownerUserId", value: "account-a" }); await h.db.schedules.put(due())
  const result = await h.repo.convert(ID, request())
  assert.equal((await queue(h))[0].ownerUserId, "account-a"); assert.equal(result.pendingConfirmation, true)
})
test("owner changes and same-owner restore between read and write reject stale local conversion", async () => {
  for (const replacement of [{ ownerUserId: "account-b", epoch: "changed" }, { ownerUserId: "account-a", epoch: "restored" }]) {
    const h = harness(); await h.db.meta.put({ key: "ownerUserId", value: "account-a" }); await h.db.schedules.put(due())
    const tx = h.db.transaction.bind(h.db); let changed = false
    h.db.transaction = async (...args) => {
      const result = await tx(...args)
      if (args[0] === "r" && !changed) {
        changed = true
        await h.db.meta.put({ key: "ownerUserId", value: replacement.ownerUserId })
        await h.db.meta.put({ key: "ownerGeneration", value: replacement.epoch })
      }
      return result
    }
    await assert.rejects(h.repo.convert(ID, request()), /旧操作/)
    assert.equal((await h.db.schedules.get(ID)).status, "pending"); assert.equal(h.stores.entries.rows.size, 0)
  }
})
test("malformed, duplicate or foreign-owner intentions cannot be discarded while appending", async () => {
  for (const items of [{}, [null], [{ ...intent(), ownerUserId: "foreign" }],
    [{ ...intent(), ownerUserId: "" }, { ...intent(), ownerUserId: "" }]]) {
    const h = harness(); await h.db.schedules.put(due({ id: OTHER_ID }))
    await h.db.meta.put({ key: "scheduleConversions", value: items }); const before = state(h)
    await assert.rejects(h.repo.convert(OTHER_ID, request()), /队列/); assert.equal(state(h), before)
  }
})
test("a matching intention with pending source is not silently replaced", async () => {
  const h = harness(); await h.db.schedules.put(due())
  await h.db.meta.put({ key: "scheduleConversions", value: [{ ...intent({ source: due() }), ownerUserId: "" }] })
  const before = state(h); await assert.rejects(h.repo.convert(ID, request()), /不完整/); assert.equal(state(h), before)
})
test("repeated convert returns edited diary and never replaces the immutable first snapshot", async () => {
  const h = harness(); await h.db.schedules.put(due()); await h.repo.convert(ID, request())
  const first = JSON.stringify((await queue(h))[0])
  await h.entryRepo.update(ID, { title: "后来日记", content: content("后来正文"), mood: "喜", tagIds: ["tag"] })
  const result = await h.repo.convert(ID, request({ entryDate: "2026-10-07" }))
  assert.equal(result.created, false); assert.equal(result.entry.title, "后来日记")
  assert.equal(result.entry.entryDate, TODAY); assert.equal(result.entry.mood, "喜")
  assert.equal(JSON.stringify((await queue(h))[0]), first)
})
test("deleted diary remains deleted; pending purge and physical removal never regenerate an Entry", async () => {
  const h = harness(); await h.db.schedules.put(due()); await h.repo.convert(ID, request())
  const first = JSON.stringify((await queue(h))[0])
  await h.entryRepo.remove(ID)
  assert.equal((await h.repo.convert(ID, request())).entryState, "deleted")
  await h.entryRepo.purge(ID)
  const purged = await h.repo.convert(ID, request())
  assert.equal(purged.entryState, "purged"); assert.equal(purged.entry, undefined); assert.equal(purged.created, false)
  assert.equal(JSON.stringify((await queue(h))[0]), first)
  await h.db.entries.delete(ID)
  const missing = await h.repo.convert(ID, request())
  assert.equal(missing.entryState, "purged"); assert.equal(h.stores.entries.rows.size, 0)
  assert.equal((await h.db.schedules.get(ID)).status, "converted")
})
test("terminal source deletion/recovery does not unlock conversion", async () => {
  const h = harness(); await h.db.schedules.put(due()); await h.repo.convert(ID, request())
  await h.repo.remove(ID); assert.equal((await h.repo.convert(ID, request())).created, false)
  await h.repo.restore(ID); assert.equal((await h.repo.convert(ID, request())).created, false)
  assert.equal(h.stores.entries.rows.size, 1); assert.equal((await queue(h)).length, 1)
})
test("confirmed terminal receipts return existing or purged state without constructing an intent", async () => {
  for (const present of [false, true]) {
    const h = harness(); await h.db.schedules.put(terminal({ remindDate: TODAY, dirty: 0, serverUpdatedAt: AT }))
    if (present) await h.db.entries.put(entry({ entryDate: TODAY, dirty: 0, serverUpdatedAt: AT }))
    const before = state(h); const result = await h.repo.convert(ID, request())
    assert.equal(result.pendingConfirmation, false); assert.equal(result.created, false)
    assert.equal(result.entryState, present ? "active" : "purged"); assert.equal(state(h), before)
  }
})
test("conversion export remains backup-v3 compatible and maps sources on a copied restore", async () => {
  const h = harness(); await h.db.schedules.put(due()); await h.repo.convert(ID, request())
  const file = await h.load("db/backupRepo.ts").localBackupRepo.exportAll()
  assert.equal(file.scheduleConversions.length, 1); assert.equal(file.scheduleConversions[0].source.status, "pending")
  const restored = harness(); await restored.load("db/backupRepo.ts").localBackupRepo.importAll(file, "asCopy")
  const row = [...restored.stores.schedules.rows.values()][0]
  const result = await restored.repo.convert(row.id, { expectedClientUpdatedAt: row.clientUpdatedAt })
  assert.equal(result.created, false); assert.equal(result.entry.id, row.id)
  assert.equal((await queue(restored)).length, 1)
})
test("P2 protection sees new conversion candidates and later-added diary image references", async () => {
  const h = harness(); await h.db.schedules.put(due()); await h.repo.convert(ID, request())
  const mediaId = "photo-id"
  await h.entryRepo.update(ID, { content: { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: `local://media/${mediaId}` } }] } } })
  const protectedRows = await h.load("db/scheduleStateRepo.ts").protectedConversions()
  assert.equal(protectedRows.entryIds.has(ID), true); assert.equal(protectedRows.mediaIds.has(mediaId), true)
  assert.equal((await queue(h))[0].entry.contentText, "计划")
})
