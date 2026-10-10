const { test } = require("node:test")
const assert = require("node:assert/strict")
const { ID, OTHER_ID, AT, content, schedule, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const { networkHarness } = require("./schedules-network-harness.cjs")
const FIRST = "2026-10-08T10:00:00.001Z", SERVER = "2026-10-08T10:00:02.000Z"
const lease = () => ({ ownerUserId: "account-a", generation: "epoch", tokenGeneration: 0 })
const ok = data => ({ status: 200, data: { code: 0, message: "ok", data } })
const rejected = data => ({ status: 409, data: { code: 409, message: "private raw credentials message", data } })
function wireSource(row) { return { id: row.id, remind_date: row.remindDate, title: row.title, content: row.content,
  content_text: row.contentText, status: row.status, converted_entry_id: row.convertedEntryId, converted_at: row.convertedAt,
  client_updated_at: row.clientUpdatedAt, deleted_at: row.deletedAt, created_at: row.createdAt, updated_at: SERVER } }
function wireEntry(row) { return { id: row.id, from_schedule_id: row.fromScheduleId, entry_date: row.entryDate,
  sort_order: row.sortOrder, title: row.title, content: row.content, content_text: row.contentText,
  mood: row.mood, weather: row.weather, tag_ids: row.tagIds, client_updated_at: row.clientUpdatedAt,
  deleted_at: row.deletedAt, created_at: row.createdAt, updated_at: SERVER } }
const sourceSuccess = () => ({ interrupted: false, schedules: [{ index: 0, id: ID, status: "applied", reason: "replayed",
  submitted_client_updated_at: AT, current: wireSource(schedule()) }] })
const conversionConflict = () => ({ schedule: wireSource(terminal({ clientUpdatedAt: FIRST })),
  entry: wireEntry(entry({ clientUpdatedAt: SERVER, title: "云端候选" })), entry_state: "active", confirmed: false,
  created: false, reason: "intent_conflict", first_entry_date: "2026-10-07", first_entry_deleted: false,
  token: "never persist this", user_id: "private-owner" })
async function fixture(options = {}) {
  let h
  const net = networkHarness(async (url, body, config, count) => {
    if (options.serve) return options.serve(h, url, body, config, count)
    return url.endsWith("/push") ? ok(sourceSuccess()) : rejected(conversionConflict())
  })
  h = setup(); h.net = net; h.mocks["./tokenStore"] = net.tokens; h.mocks["@/api/tokenStore"] = net.tokens
  h.mocks["./request"] = net.api
  const core = h.load("shared/scheduleConversionSync.ts")
  h.mocks["@/shared/scheduleConversionSync"] = core
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "ownerGeneration", value: "epoch" })
  await h.db.schedules.put(terminal({ clientUpdatedAt: FIRST, convertedAt: FIRST }))
  const first = entry({ title: "预简", content: content("计划"), contentText: "计划", clientUpdatedAt: FIRST })
  await h.db.entries.put(first)
  await h.db.meta.put({ key: "scheduleConversions", value: [intent({ entry: first, ownerUserId: "account-a", queuedAt: FIRST })] })
  const transport = h.load("api/scheduleConversionTransport.ts").createScheduleConversionTransport()
  const consumer = h.load("db/scheduleConversionSyncRepo.ts").createInternalScheduleConversionConsumer(transport)
  return { ...h, net, consumer, transport }
}
const queued = async h => (await h.db.meta.get("scheduleConversions")).value
const log = async (h,key = "scheduleConflicts") => (await h.db.meta.get(key))?.value ?? []
const state = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([k,v]) => [k,[...v.rows.values()]])))

test("only pinned P4 HTTP 409 preserves candidate data; legacy posts remain data-less", async () => {
  const net = networkHarness(async () => rejected({ candidate: "business only" }))
  await assert.rejects(net.api.postPinnedSchedule(`/schedules/${ID}/convert`, {}, lease()), error => {
    assert.equal(error.status, 409); assert.deepEqual(error.data, { candidate: "business only" }); return true
  })
  await assert.rejects(net.api.post("/sync/push", {}, "account-a"), error => { assert.equal(error.data, undefined); return true })
})
test("supplied stale generation rejects before Authorization even after A-B-A", async () => {
  const net = networkHarness(async () => ok("wrong owner")); net.switch("account-b"); net.switch("account-a")
  await assert.rejects(net.api.postPinnedSchedule("/schedules/sync/push", {}, lease()))
  assert.equal(net.calls.length, 0)
})
for (const path of ["https://example.com/schedules/sync/push", "/sync/push", "/auth/refresh", `/schedules/${OTHER_ID}/convert?extra=1`]) {
  test(`pinned schedule helper rejects unrelated or injected path ${path}`, async () => {
    const net = networkHarness(async () => ok("no"))
    await assert.rejects(net.api.postPinnedSchedule(path, {}, lease())); assert.equal(net.calls.length, 0)
  })
}
test("pinned same-owner 401 refresh keeps original generation and safely replays", async () => {
  const net = networkHarness(async (_u,_b,_c,count) => count === 1 ? { status: 401, data: { code: 401, data: null } } : ok("success"))
  assert.equal(await net.api.postPinnedSchedule("/schedules/sync/push", {}, lease()), "success")
  assert.equal(net.refreshes(), 1); assert.equal(net.calls.length, 2)
  assert.ok(net.calls.every(c => c._syncOwner === "account-a" && c._tokenGeneration === 0))
  assert.ok(net.calls[1].headers.Authorization.endsWith("fresh"))
})
test("successful stale-account HTTP response is rejected before returning data", async () => {
  const net = networkHarness(async () => { net.switch("account-b"); return ok("private A data") })
  await assert.rejects(net.api.postPinnedSchedule("/schedules/sync/push", {}, lease()), /旧日程响应/)
})
test("validated conversion 409 preserves first snapshot and remote candidate without replacing local resources", async () => {
  const h = await fixture(), before = await h.db.entries.get(ID), source = await h.db.schedules.get(ID)
  const result = await h.consumer.consumeOne(ID)
  assert.equal(result.kind, "conflict"); assert.equal(result.reason, "intent_conflict")
  assert.deepEqual(await h.db.entries.get(ID), before); assert.deepEqual(await h.db.schedules.get(ID), source)
  assert.equal((await queued(h)).length, 1)
  const record = (await log(h))[0]
  assert.equal(record.serverEntry.title, "云端候选"); assert.equal(record.firstEntryDate, "2026-10-07")
  assert.deepEqual(record.firstIntent.entry, before); assert.equal(record.kind, "conversion-transport")
  assert.equal(JSON.stringify(record).includes("never persist this"), false)
  assert.equal(JSON.stringify(record).includes("private raw credentials"), false)
  assert.equal(Object.hasOwn(record, "tokenGeneration"), false)
  assert.ok(h.net.calls.every(c => c._syncOwner === "account-a" && c._tokenGeneration === 0))
})
test("source stale candidate is retained and convert is not sent", async () => {
  const h = await fixture({ serve: async () => ok({ interrupted: false, schedules: [{ index: 0, id: ID, status: "stale", reason: "stale",
    submitted_client_updated_at: AT, current: wireSource(schedule({ title: "新版来源", clientUpdatedAt: SERVER })) }] }) })
  const result = await h.consumer.consumeOne(ID)
  assert.equal(result.kind, "conflict"); assert.equal(result.reason, "stale")
  assert.equal(h.net.calls.length, 1); assert.equal((await log(h))[0].serverSchedule.title, "新版来源")
  assert.equal((await queued(h)).length, 1)
})
for (const reason of ["invalid", "retry", "storage", "aborted"]) {
  test(`source item ${reason} is logged without ACK or following convert`, async () => {
    const h = await fixture({ serve: async () => ok({ interrupted: reason === "aborted", schedules: [{ index: 0, id: ID,
      status: "error", reason, current: null }] }) })
    assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    assert.equal(h.net.calls.length, 1); assert.equal((await log(h,"scheduleSyncErrors"))[0].reason, reason)
    assert.equal((await queued(h)).length, 1)
  })
}
for (const code of [401, 404, 422, 500]) {
  test(`HTTP ${code} retains only classified error, not raw server message`, async () => {
    const h = await fixture({ serve: async (_h,url) => url.endsWith("/push") ? ok(sourceSuccess()) :
      { status: code, data: { code, message: "private raw credentials", data: { token: "never persist" } } } })
    assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    const records = await log(h,"scheduleSyncErrors")
    // Exhausted 401 refresh leaves the same mock token owner unchanged; error remains local.
    assert.equal(records.length, 1); assert.equal(records[0].serverEntry, null)
    assert.equal(JSON.stringify(records).includes("never persist"), false)
    assert.equal((await queued(h)).length, 1)
  })
}
test("null lock-conflict payload records retry without inventing current source", async () => {
  const h = await fixture({ serve: async (_h,url) => url.endsWith("/push") ? ok(sourceSuccess()) : rejected(null) })
  assert.equal((await h.consumer.consumeOne(ID)).reason, "retry")
  const r = (await log(h,"scheduleSyncErrors"))[0]; assert.equal(r.serverSchedule, null); assert.equal(r.serverEntry, null)
})
for (const mode of ["wrong_id", "missing_summary", "confirmed_true", "invalid_day", "wrong_state"]) {
  test(`malformed 409 ${mode} is quarantined as invalid_response, not trusted candidate`, async () => {
    const h = await fixture({ serve: async (_h,url) => {
      if (url.endsWith("/push")) return ok(sourceSuccess())
      const a = conversionConflict()
      if (mode === "wrong_id") a.entry.id = OTHER_ID
      if (mode === "missing_summary") delete a.first_entry_date
      if (mode === "confirmed_true") a.confirmed = true
      if (mode === "invalid_day") a.first_entry_date = "2026-02-29"
      if (mode === "wrong_state") a.entry_state = "purged"
      return rejected(a)
    } })
    assert.equal((await h.consumer.consumeOne(ID)).reason, "invalid_response")
    assert.equal((await log(h)).length, 0); assert.equal((await log(h,"scheduleSyncErrors"))[0].serverEntry, null)
    assert.equal((await queued(h)).length, 1)
  })
}
test("possible post-commit timeout logs network error and never removes intent", async () => {
  const h = await fixture({ serve: async (_h,url) => { if (url.endsWith("/push")) return ok(sourceSuccess()); throw new Error("Bearer-private") } })
  assert.equal((await h.consumer.consumeOne(ID)).reason, "network")
  assert.equal((await queued(h)).length, 1); assert.equal(JSON.stringify(await log(h,"scheduleSyncErrors")).includes("Bearer-private"), false)
})
test("distinct old candidates remain and an unresolved target conflict blocks replay", async () => {
  let version = "第一份云端候选"
  const h = await fixture({ serve: async (_h,url) => { if (url.endsWith("/push")) return ok(sourceSuccess())
    const c = conversionConflict(); c.entry.title = version; return rejected(c) } })
  await h.db.meta.put({ key: "scheduleConflicts", value: [{ scheduleId: OTHER_ID, kind: "old" }] })
  await h.consumer.consumeOne(ID)
  const calls = h.net.calls.length
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
  version = "第二份云端候选"
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
  const records = await log(h); assert.equal(records.length, 2)
  assert.equal(h.net.calls.length, calls)
  assert.equal(records[0].kind, "old"); assert.equal(records[1].serverEntry.title, "第一份云端候选")
})
test("identical safe error retries are deduplicated without blocking conversion intent", async () => {
  const h = await fixture({ serve: async () => { throw new Error("private timeout") } })
  await h.consumer.consumeOne(ID); await h.consumer.consumeOne(ID)
  assert.equal((await log(h,"scheduleSyncErrors")).length, 1)
  assert.equal((await queued(h)).length, 1); assert.equal(h.net.calls.length, 2)
})

for (const mode of ["account", "epoch", "intent"]) {
  test(`late rejected response after ${mode} change cannot persist old candidate`, async () => {
    const h = await fixture({ serve: async (h,url) => {
      if (url.endsWith("/push")) return ok(sourceSuccess())
      if (mode === "account") h.net.switch("account-b")
      if (mode === "epoch") await h.db.meta.put({ key: "ownerGeneration", value: "restored" })
      if (mode === "intent") { const rows = await queued(h); rows[0].queuedAt = SERVER
        await h.db.meta.put({ key: "scheduleConversions", value: rows }) }
      return rejected(conversionConflict())
    } })
    assert.equal((await h.consumer.consumeOne(ID)).kind, "held")
    assert.equal((await log(h)).length, 0); assert.equal((await log(h,"scheduleSyncErrors")).length, 0)
    assert.equal((await queued(h)).length, 1)
  })
}
test("candidate storage failure rolls back and retains all prior state", async () => {
  const h = await fixture(); h.failNext("meta"); const before = state(h)
  assert.equal((await h.consumer.consumeOne(ID)).kind, "held"); assert.equal(state(h), before)
})
test("malformed existing candidate log is preserved rather than replaced", async () => {
  const h = await fixture(); await h.db.meta.put({ key: "scheduleConflicts", value: "old malformed log" })
  const before = state(h); assert.equal((await h.consumer.consumeOne(ID)).kind, "held"); assert.equal(state(h), before)
})
test("creating protocol and consumer factories sends no request or enables automatic sync", async () => {
  const h = await fixture(); assert.equal(h.net.calls.length, 0)
  const fs = require("node:fs"), path = require("node:path")
  for (const file of ["repo/index.ts", "api/sync.ts"]) {
    assert.equal(fs.readFileSync(path.join(__dirname,"../src",file),"utf8").includes("scheduleConversionTransport"), false)
  }
})

test("real protocol adapter can confirm first conversion without clearing current diary dirty", async () => {
  const h = await fixture({ serve: async (_h,url) => {
    if (url.endsWith("/push")) return ok(sourceSuccess())
    return ok({ schedule: wireSource(terminal({ clientUpdatedAt: FIRST, convertedAt: FIRST })),
      entry: wireEntry(entry({ title: "预简", content: content("计划"), contentText: "计划", clientUpdatedAt: FIRST })),
      entry_state: "active", confirmed: true, created: true, reason: "applied", first_entry_date: "2026-10-09", first_entry_deleted: false })
  } })
  const before = await h.db.entries.get(ID)
  assert.equal((await h.consumer.consumeOne(ID)).kind, "confirmed")
  assert.equal((await queued(h)).length, 0); assert.deepEqual(await h.db.entries.get(ID), before)
  assert.equal((await h.db.entries.get(ID)).dirty, 1); assert.equal(h.net.calls.length, 2)
})
test("401 replay retains opt-in 409 candidate under the same account generation", async () => {
  const h = await fixture({ serve: async (_h,url,_body,config) => {
    if (url.endsWith("/push")) return ok(sourceSuccess())
    return config._retried ? rejected(conversionConflict()) : { status: 401, data: { code: 401, data: null } }
  } })
  assert.equal((await h.consumer.consumeOne(ID)).kind, "conflict")
  assert.equal(h.net.refreshes(), 1); assert.equal(h.net.calls.length, 3)
  assert.equal((await log(h))[0].serverEntry.title, "云端候选")
  assert.ok(h.net.calls.every(c => c._tokenGeneration === 0))
})
test("malformed source failure identity stores only an invalid-response marker", async () => {
  const h = await fixture({ serve: async () => ok({ interrupted: false, schedules: [{ index: 0, id: OTHER_ID,
    status: "stale", reason: "stale", current: wireSource(schedule({ id: OTHER_ID })) }] }) })
  assert.equal((await h.consumer.consumeOne(ID)).reason, "invalid_response")
  const r = (await log(h,"scheduleSyncErrors"))[0]
  assert.equal(r.serverSchedule, null); assert.equal((await queued(h)).length, 1)
})
test("invalid transport resource IDs fail locally without making a request", async () => {
  const h = await fixture()
  await assert.rejects(h.transport.convert("../../auth", {}, lease()))
  await assert.rejects(h.transport.pushSource({ schedules: [{ id: "bad" }] }, lease()))
  assert.equal(h.net.calls.length, 0)
})
