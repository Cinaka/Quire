const { test } = require("node:test")
const assert = require("node:assert/strict")
const { ID, OTHER_ID, AT, content, schedule, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const FIRST = "2026-10-08T10:00:00.001Z", SERVER = "2026-10-08T10:00:02.000Z"
function wireSource(row) { return { id: row.id, remind_date: row.remindDate, title: row.title,
  content: row.content, content_text: row.contentText, status: row.status,
  converted_entry_id: row.convertedEntryId, converted_at: row.convertedAt,
  client_updated_at: row.clientUpdatedAt, deleted_at: row.deletedAt,
  created_at: row.createdAt, updated_at: SERVER } }
function wireEntry(row) { return { id: row.id, from_schedule_id: row.fromScheduleId, entry_date: row.entryDate,
  sort_order: row.sortOrder, title: row.title, content: row.content, content_text: row.contentText,
  mood: row.mood, weather: row.weather, tag_ids: row.tagIds, client_updated_at: row.clientUpdatedAt,
  deleted_at: row.deletedAt, created_at: row.createdAt, updated_at: SERVER } }
async function harness(options = {}) {
  const h = setup()
  h.mocks["@/api/tokenStore"] = h.tokens
  const first = entry({ title: "预简", content: content("计划"), contentText: "计划", clientUpdatedAt: FIRST })
  const source = terminal({ clientUpdatedAt: FIRST, convertedAt: FIRST })
  const queued = intent({ entry: first, queuedAt: FIRST, ownerUserId: "account-a" })
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "ownerGeneration", value: "epoch-a" })
  await h.db.meta.put({ key: "scheduleConversions", value: [queued] })
  await h.db.schedules.put(source); await h.db.entries.put(first)
  const calls = []
  const transport = {
    async pushSource(body, lease) {
      calls.push({ kind: "push", body: structuredClone(body), lease })
      if (options.push) return options.push(h, body, lease)
      return { interrupted: false, schedules: [{ index: 0, id: ID, status: "applied", reason: "replayed",
        submitted_client_updated_at: AT, current: wireSource(schedule()) }] }
    },
    async convert(id, body, lease) {
      calls.push({ kind: "convert", id, body: structuredClone(body), lease })
      if (options.during) await options.during(h, body)
      if (options.fail) throw new Error("timeout after remote commit")
      return options.ack ? options.ack(h) : ack()
    },
  }
  const ack = () => ({ schedule: wireSource(source), entry: wireEntry(first), entry_state: "active",
    confirmed: true, created: true, reason: "applied", first_entry_date: first.entryDate, first_entry_deleted: false })
  const consumer = h.load("db/scheduleConversionSyncRepo.ts").createInternalScheduleConversionConsumer(transport)
  return { ...h, first, source, queued, calls, consumer, ack }
}
async function queue(h) { return (await h.db.meta.get("scheduleConversions"))?.value ?? [] }
const state = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v]) => [k,[...v.rows.values()]])))

test("explicit single-intent consumer sends pending source then first conversion and atomically acknowledges only source", async () => {
  const h = await harness(), before = await h.db.entries.get(ID)
  const result = await h.consumer.consumeOne(ID)
  assert.equal(result.kind, "confirmed"); assert.equal((await queue(h)).length, 0)
  assert.deepEqual(await h.db.entries.get(ID), before)
  assert.equal((await h.db.schedules.get(ID)).dirty, 0)
  assert.equal((await h.db.schedules.get(ID)).serverUpdatedAt, SERVER)
  assert.deepEqual(h.calls.map(c => c.kind), ["push", "convert"])
  assert.equal(h.calls[0].body.schedules[0].status, "pending")
  assert.equal(h.calls[1].body.expected_schedule_client_updated_at, AT)
  assert.equal(h.calls[1].body.entry.client_updated_at, FIRST)
  assert.equal(JSON.stringify(h.calls).includes("ownerUserId\":\"account-a"), true)
  assert.equal(Object.hasOwn(h.calls[1].body, "ownerUserId"), false)
  assert.equal(Object.hasOwn(h.calls[1].body.entry, "serverUpdatedAt"), false)
})
test("new local diary text, date, images, tags and dirty revisions survive first ACK", async () => {
  const h = await harness({ during: async h => {
    const e = await h.db.entries.get(ID)
    await h.db.entries.put({ ...e, title: "后来编辑", entryDate: "2026-10-07", tagIds: [OTHER_ID], mood: "好",
      content: { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: `local://media/${OTHER_ID}` } }] } },
      clientUpdatedAt: SERVER, dirty: 1 })
    const rows = await queue(h); rows[0].protectedMediaIds = [OTHER_ID]
    await h.db.meta.put({ key: "scheduleConversions", value: rows })
  } })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "confirmed")
  const e = await h.db.entries.get(ID)
  assert.equal(e.title, "后来编辑"); assert.equal(e.clientUpdatedAt, SERVER); assert.equal(e.dirty, 1)
  assert.deepEqual(e.tagIds, [OTHER_ID]); assert.equal(e.content.doc.content[0].type, "image")
  assert.equal((await queue(h)).length, 0)
})
test("a locally soft-deleted diary stays deleted after a first active cloud receipt", async () => {
  const h = await harness({ during: async h => { const e = await h.db.entries.get(ID)
    await h.db.entries.put({ ...e, isDeleted: 1, deletedAt: SERVER, clientUpdatedAt: SERVER }) } })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "confirmed")
  assert.equal((await h.db.entries.get(ID)).isDeleted, 1)
})
test("terminal source push error can advance to read-only convert replay without resending pending content", async () => {
  const h = await harness({ push: async h => ({ interrupted: false, schedules: [{ index: 0, id: ID,
    status: "error", reason: "terminal", current: wireSource(h.source ?? terminal({ clientUpdatedAt: FIRST })) }] }) })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "confirmed")
  assert.equal(h.calls.length, 2)
})
for (const mode of ["stale", "wrong_id", "wrong_revision", "truncated", "interrupted", "changed_content"]) {
  test(`unconfirmed source ${mode} never sends convert or acknowledges`, async () => {
    const h = await harness({ push: async () => {
      const r = { index: 0, id: ID, status: "applied", reason: "applied", submitted_client_updated_at: AT, current: wireSource(schedule()) }
      if (mode === "stale") { r.status = "stale"; r.reason = "stale" }
      if (mode === "wrong_id") r.id = OTHER_ID
      if (mode === "wrong_revision") r.current.client_updated_at = SERVER
      if (mode === "changed_content") r.current.title = "另设备内容"
      return { interrupted: mode === "interrupted", schedules: mode === "truncated" ? [] : [r] }
    } })
    const before = state(h); assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    assert.equal(state(h), before); assert.equal(h.calls.length, 1)
  })
}
for (const mode of ["confirmed_false", "wrong_first_day", "wrong_identity", "bad_time", "wrong_state", "missing_receipt"]) {
  test(`malformed conversion ACK ${mode} leaves local rows and queue untouched`, async () => {
    const h = await harness({ ack: () => { const a = h.ack()
      if (mode === "confirmed_false") a.confirmed = false
      if (mode === "wrong_first_day") a.first_entry_date = "2099-01-01"
      if (mode === "wrong_identity") a.entry.id = OTHER_ID
      if (mode === "bad_time") a.schedule.updated_at = "2026-02-30T10:00:00Z"
      if (mode === "wrong_state") a.entry_state = "purged"
      if (mode === "missing_receipt") delete a.first_entry_deleted
      return a } })
    const before = state(h); assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    assert.equal(state(h), before)
  })
}
test("timeout even after possible server commit keeps first intent and all protections", async () => {
  const h = await harness({ fail: true }), before = state(h)
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held"); assert.equal(state(h), before)
})
for (const mode of ["account", "logout", "epoch", "owner", "intent"]) {
  test(`late ACK after ${mode} change cannot remove intention or clear dirty`, async () => {
    const h = await harness({ during: async h => {
      if (mode === "account") h.user("account-b")
      if (mode === "logout") h.user("")
      if (mode === "epoch") await h.db.meta.put({ key: "ownerGeneration", value: "new-epoch" })
      if (mode === "owner") await h.db.meta.put({ key: "ownerUserId", value: "account-b" })
      if (mode === "intent") { const rows = await queue(h); rows[0].queuedAt = SERVER
        await h.db.meta.put({ key: "scheduleConversions", value: rows }) }
      if (mode === "new_source") { const s = await h.db.schedules.get(ID)
        await h.db.schedules.put({ ...s, isDeleted: 1, deletedAt: SERVER, clientUpdatedAt: SERVER }) }
    } })
    assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    assert.equal((await queue(h)).length, 1); assert.equal((await h.db.schedules.get(ID)).dirty, 1)
  })
}
for (const mode of ["server_edit", "server_delete", "server_purged", "server_clock_ahead"]) {
  test(`server current diary ${mode} is quarantined rather than overwriting local`, async () => {
    const h = await harness({ ack: () => { const a = h.ack(); a.created = false; a.reason = "replayed"
      if (mode === "server_edit") a.entry.title = "云端后续编辑"
      if (mode === "server_delete") { a.entry.deleted_at = SERVER; a.entry_state = "deleted" }
      if (mode === "server_purged") { a.entry = null; a.entry_state = "purged" }
      if (mode === "server_clock_ahead") a.entry.client_updated_at = SERVER
      return a } })
    const before = await h.db.entries.get(ID)
    assert.equal((await h.consumer.consumeOne(ID)).kind, "conflict")
    assert.deepEqual(await h.db.entries.get(ID), before); assert.equal((await queue(h)).length, 1)
    assert.equal((await h.db.meta.get("scheduleConflicts")).value[0].kind, "conversion-ack")
  })
}
test("missing local diary is not recreated and remains protected against later P2 pull", async () => {
  const h = await harness(); await h.db.entries.delete(ID)
  await h.db.meta.put({ key: "pendingPurges", value: [ID] })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
  assert.equal(await h.db.entries.get(ID), undefined); assert.equal((await queue(h)).length, 1)
  assert.deepEqual((await h.db.meta.get("pendingPurges")).value, [ID])
})
test("local and server purged identity can confirm without constructing any entry", async () => {
  const h = await harness({ ack: () => ({ ...h.ack(), created: false, reason: "replayed", entry: null, entry_state: "purged" }) })
  await h.db.entries.delete(ID)
  assert.equal((await h.consumer.consumeOne(ID)).kind, "confirmed")
  assert.equal(await h.db.entries.get(ID), undefined); assert.equal((await queue(h)).length, 0)
})
for (const table of ["schedules", "meta"]) {
  test(`failed ${table} ACK write rolls back watermark and intention together`, async () => {
    const h = await harness(); h.failNext(table); const before = state(h)
    assert.equal((await h.consumer.consumeOne(ID)).kind, "held"); assert.equal(state(h), before)
  })
}
for (const mode of ["duplicate", "foreign", "malformed", "future_content", "restored_rich_first", "mismatch"]) {
  test(`invalid or incompatible queue ${mode} fails before any outbound request`, async () => {
    const h = await harness(), rows = await queue(h)
    if (mode === "duplicate") rows.push(rows[0])
    if (mode === "foreign") rows[0].ownerUserId = "account-b"
    if (mode === "malformed") rows[0].entry.id = OTHER_ID
    if (mode === "future_content") rows[0].source.content.schemaVersion = 99
    if (mode === "restored_rich_first") rows[0].entry.mood = "好"
    if (mode === "mismatch") rows[0].entry.title = "不同正文"
    await h.db.meta.put({ key: "scheduleConversions", value: rows })
    const before = state(h); assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    assert.equal(state(h), before); assert.equal(h.calls.length, 0)
  })
}
test("same-consumer concurrent click is held and later repeated attempt finds no intention", async () => {
  let release; const gate = new Promise(resolve => { release = resolve })
  const h = await harness({ during: async () => gate })
  const first = h.consumer.consumeOne(ID)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await h.consumer.consumeOne(ID)).reason, "busy")
  release(); assert.equal((await first).kind, "confirmed")
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held"); assert.equal(h.calls.length, 2)
})
test("consumer factory stays internal and is not wired to repo, router or ordinary sync", () => {
  const fs = require("node:fs"), path = require("node:path")
  for (const file of ["repo/index.ts", "api/sync.ts"]) {
    const text = fs.readFileSync(path.join(__dirname, "../src", file), "utf8")
    assert.equal(text.includes("createInternalScheduleConversionConsumer"), false)
  }
})

test("A to B to A login cycle still invalidates the original generation", async () => {
  const h = await harness({ during: async h => { h.user("account-b"); h.user("account-a") } })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
  assert.equal((await queue(h)).length, 1); assert.equal((await h.db.schedules.get(ID)).dirty, 1)
})
test("a successful ACK preserves all other intentions and media protection", async () => {
  const h = await harness(), rows = await queue(h)
  const other = structuredClone(rows[0]); other.scheduleId = OTHER_ID; other.source.id = OTHER_ID
  other.entry.id = OTHER_ID; other.entry.fromScheduleId = OTHER_ID; other.protectedMediaIds = [ID]
  await h.db.meta.put({ key: "scheduleConversions", value: [...rows, other] })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "confirmed")
  assert.deepEqual(await queue(h), [other])
})
test("server naive UTC timestamps and content object key order are normalized safely", async () => {
  const h = await harness({ ack: () => { const a = h.ack()
    a.schedule.updated_at = "2026-10-08T10:00:02"
    a.schedule.content = { doc: a.schedule.content.doc, schemaVersion: 1 }
    a.entry.updated_at = "2026-10-08T10:00:02.000"
    return a } })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "confirmed")
  assert.equal((await h.db.schedules.get(ID)).serverUpdatedAt, SERVER)
})
test("older cloud watermark is not allowed to roll back an existing confirmed stamp", async () => {
  const h = await harness(), s = await h.db.schedules.get(ID)
  await h.db.schedules.put({ ...s, serverUpdatedAt: "2026-10-08T10:00:03.000Z" })
  const before = state(h)
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held"); assert.equal(state(h), before)
})
test("server first clock differences keep source dirty even when first diary business is compatible", async () => {
  const h = await harness({ ack: () => { const a = h.ack()
    a.schedule.client_updated_at = "2026-10-08T10:00:00.002Z"
    return a } })
  assert.equal((await h.consumer.consumeOne(ID)).reason, "source_revision_held")
  assert.equal((await h.db.schedules.get(ID)).dirty, 1)
  assert.equal((await queue(h)).length, 0)
  const held = await h.load("db/scheduleStateRepo.ts").protectedConversions()
  assert.equal(held.entryIds.has(ID), true)
})
test("incompatible server diary cannot replace a malformed existing conflict log", async () => {
  const h = await harness({ ack: () => { const a = h.ack(); a.entry.title = "云端修改"; return a } })
  await h.db.meta.put({ key: "scheduleConflicts", value: "malformed retained" })
  const before = state(h)
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held"); assert.equal(state(h), before)
})

for (const key of ["ownerUserId", "ownerGeneration"]) {
  test(`malformed ${key} marker is not treated as an empty legacy lease`, async () => {
    const h = await harness(); await h.db.meta.put({ key, value: { malformed: true } })
    const before = state(h)
    assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    assert.equal(h.calls.length, 0); assert.equal(state(h), before)
  })
}
