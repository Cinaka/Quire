const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS, memoryDB } = require("./schedules-harness.cjs")
const content = text => ({ schemaVersion: 1, doc: { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text }] },
] } })
function setup() {
  const memory = memoryDB()
  let counter = 0
  const time = { ...loadTS("shared/time.ts"), todayLocal: () => "2026-10-08", utcNow: () => "2026-10-08T10:00:00.000Z" }
  const repo = loadTS("db/scheduleRepo.ts", {
    "./schema": { db: memory.db },
    "@/shared/ids": { newId: () => `019a0300-1234-7000-8000-${String(++counter).padStart(12, "0")}` },
    "./time": time, "@/shared/time": time,
  }).localScheduleRepo
  return { ...memory, repo }
}
test("create persists pending, local dirty and text derived from content", async () => {
  const h = setup()
  const row = await h.repo.create({ remindDate: "2026-10-09", title: "", content: content("正文") })
  assert.equal(row.contentText, "正文")
  assert.equal(row.status, "pending")
  assert.equal(row.dirty, 1)
  assert.equal(row.serverUpdatedAt, "")
  assert.equal(row.convertedEntryId, null)
  assert.equal(h.rows.size, 1)
})
test("invalid, elapsed, empty and image-only new rows never reach the table", async () => {
  const h = setup()
  for (const dto of [
    { remindDate: "2026-10-08", title: "today" },
    { remindDate: "2026-02-29", title: "bad" },
    { remindDate: "2026-10-09", title: " " },
    { remindDate: "2026-10-09", content: { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image" }] } } },
  ]) await assert.rejects(h.repo.create(dto))
  assert.equal(h.rows.size, 0)
})
test("field-by-field updates preserve omitted content and allow elapsed rescheduling", async () => {
  const h = setup()
  const row = await h.repo.create({ remindDate: "2026-10-09", title: "t", content: content("保留") })
  const next = await h.repo.update(row.id, { remindDate: "2026-10-07", title: "新标题" })
  assert.equal(next.contentText, "保留")
  assert.equal(next.content.doc.content[0].content[0].text, "保留")
  assert.equal(next.remindDate, "2026-10-07")
  assert.equal(next.createdAt, row.createdAt)
  assert.equal(next.clientUpdatedAt, "2026-10-08T10:00:00.001Z")
  const cleared = await h.repo.update(row.id, { content: null })
  assert.equal(cleared.contentText, "")
  assert.equal(cleared.clientUpdatedAt, "2026-10-08T10:00:00.002Z")
})
test("converted rows are read-only; deleted rows require restoring first", async () => {
  const h = setup()
  const row = await h.repo.create({ remindDate: "2026-10-09", title: "t" })
  await h.repo.remove(row.id)
  await assert.rejects(h.repo.update(row.id, { title: "x" }), /恢复/)
  await h.repo.restore(row.id)
  h.rows.set(row.id, { ...h.rows.get(row.id), status: "converted", convertedEntryId: row.id, convertedAt: row.createdAt })
  await assert.rejects(h.repo.update(row.id, { title: "x" }), /已转简/)
  await h.repo.remove(row.id)
  await h.repo.restore(row.id)
  assert.equal(h.rows.get(row.id).status, "converted")
  assert.equal(h.rows.get(row.id).convertedEntryId, row.id)
})
test("soft deletion/recovery are idempotent and never clear terminal identity", async () => {
  const h = setup()
  const row = await h.repo.create({ remindDate: "2026-10-09", title: "t" })
  await h.repo.remove(row.id)
  const removed = JSON.stringify(h.rows.get(row.id))
  await h.repo.remove(row.id)
  assert.equal(JSON.stringify(h.rows.get(row.id)), removed)
  await h.repo.restore(row.id)
  assert.equal(h.rows.get(row.id).deletedAt, null)
  assert.equal(h.rows.get(row.id).isDeleted, 0)
})
test("lists sort by natural date and stable ID with deleted/status/range filters", async () => {
  const h = setup()
  const late = await h.repo.create({ remindDate: "2026-10-11", title: "late" })
  const early = await h.repo.create({ remindDate: "2026-10-09", title: "early" })
  const result = await h.repo.list({ pageSize: 1 })
  assert.equal(result.items[0].id, early.id)
  assert.equal(result.total, 2)
  await h.repo.remove(late.id)
  assert.equal((await h.repo.list()).total, 1)
  assert.equal((await h.repo.list({ onlyDeleted: true })).items[0].id, late.id)
  assert.equal((await h.repo.list({ dateFrom: "2026-10-10" })).total, 0)
  await assert.rejects(h.repo.list({ page: NaN }))
  await assert.rejects(h.repo.list({ dateFrom: "2026-10-11", dateTo: "2026-10-09" }))
})
test("transaction failures do not change data, and concurrent edits retain both fields", async () => {
  const h = setup()
  const row = await h.repo.create({ remindDate: "2026-10-09", title: "old" })
  h.failNextPut()
  await assert.rejects(h.repo.update(row.id, { title: "lost" }), /injected/)
  assert.equal((await h.repo.get(row.id)).title, "old")
  await Promise.all([h.repo.update(row.id, { title: "new" }), h.repo.update(row.id, { remindDate: "2026-10-10" })])
  const next = await h.repo.get(row.id)
  assert.equal(next.title, "new")
  assert.equal(next.remindDate, "2026-10-10")
})
