// Real boundary modules with mocked network/UUID ports; not IndexedDB or browser E2E.
const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
const { networkHarness } = require("./schedules-network-harness.cjs")
const OLD = "0198f2a1-4b3c-7000-8000-abcdef123456"
const ID = OLD.replaceAll("-", ""), OTHER = ID.slice(0, -1) + "7"
const AT = "2026-10-26T00:00:00.000Z"
const body = { schemaVersion: 1, doc: { type: "doc", content: [
  { type: "text", text: OLD }, { type: "image", attrs: { src: `local://media/${OLD}` } },
] } }
const entry = (extra = {}) => ({ id: ID, entry_date: "2026-10-26", sort_order: 0,
  title: OLD, content: body, content_text: OLD, mood: null, weather: null, tag_ids: [OTHER],
  from_schedule_id: null, client_updated_at: AT, deleted_at: null, ...extra })
const media = (extra = {}) => ({ id: ID, entry_id: OTHER, sort_order: 0, width: 1, height: 1,
  size: 3, mime: "image/png", created_at: AT, url: `/media/${OLD}.png`, thumb_url: "", ...extra })
const plain = value => JSON.parse(JSON.stringify(value))
const codec = loadTS("shared/uuidHex.ts")
const wire = loadTS("api/uuidWire.ts")
const mappers = loadTS("api/mappers.ts")
function endpointHarness(handlers = {}) {
  const calls = [], request = {}
  for (const method of ["get", "post", "put", "del"]) request[method] = async (...args) => {
    calls.push({ method, args }); return handlers[method]?.(...args)
  }
  return { api: loadTS("api/endpoints.ts", { "./request": request }), calls }
}
test("newId keeps UUIDv7 identity and emits lowercase hex32", () => {
  assert.equal(loadTS("shared/ids.ts", { uuid: { v7: () => OLD.toUpperCase() } }).newId(), ID)
  assert.throws(() => loadTS("shared/ids.ts", { uuid: { v7: () => OLD.replace("-7000-", "-4000-") } }).newId())
})
for (const invalid of [OLD, ID.toUpperCase(), ` ${ID}`, `${ID}\n`, `{${OLD}}`, `urn:uuid:${OLD}`]) {
  test(`local keys are never silently re-keyed: ${JSON.stringify(invalid)}`, () => assert.throws(() => codec.localUuidHex(invalid)))
}
test("incoming explicit identities normalize without touching title/content/URL", () => {
  const raw = entry({ id: OLD.toUpperCase(), tag_ids: [OTHER.toUpperCase()], from_schedule_id: OLD })
  const before = JSON.stringify(raw), parsed = mappers.fromWireEntry(raw)
  assert.equal(parsed.id, ID); assert.equal(parsed.fromScheduleId, ID)
  assert.deepEqual(plain(parsed.tagIds), [OTHER]); assert.equal(parsed.title, OLD)
  assert.deepEqual(plain(parsed.content), body); assert.equal(JSON.stringify(raw), before)
  assert.equal(mappers.mediaPatchFromWire(media({ id: OLD, entry_id: OLD })).remoteUrl, `/media/${OLD}.png`)
  assert.equal(mappers.mediaPatchFromWire(media({ id: OLD, entry_id: OLD })).entryId, ID)
})
test("outgoing mappers keep canonical local identities and reject legacy dirty keys", () => {
  const local = mappers.fromWireEntry(entry())
  assert.equal(mappers.toWireEntry(local).id, ID)
  assert.equal(mappers.toWireTag({ id: ID, name: OLD, color: null, createdAt: AT }).name, OLD)
  assert.equal(mappers.toWireMediaMetaPush({ ...media(), entryId: OTHER, sortOrder: 0, createdAt: AT }).entry_id, OTHER)
  assert.throws(() => mappers.toWireEntry({ ...local, id: OLD }))
  assert.throws(() => mappers.toWireEntry({ ...local, tagIds: [OLD] }))
  assert.throws(() => mappers.toWireEntry({ ...local, fromScheduleId: OLD }))
})
test("alias collisions and invalid versions are rejected on receive", () => {
  assert.throws(() => wire.entryWire(entry({ tag_ids: [ID, OLD] })))
  assert.throws(() => wire.uniqueWireRows([entry(), entry({ id: OLD })], wire.entryWire))
  assert.throws(() => wire.mediaWire(media({ entry_id: "bad" })))
  assert.throws(() => wire.tagWire({ id: ID.slice(0, 12) + "4" + ID.slice(13) }))
})
test("ACKs bind every submitted identity exactly once; duplicate-tag identity only is normalized", () => {
  const result = wire.pushAcks([{ id: OLD, status: "error", message: `duplicate_tag:${OLD}` }], [{ id: ID }])
  assert.equal(result[0].id, ID); assert.equal(result[0].message, `duplicate_tag:${ID}`)
  for (const acks of [[], [{ id: OTHER, status: "applied" }], [{ id: ID, status: "unknown" }], [{ id: null, status: "error" }]]) {
    assert.throws(() => wire.pushAcks(acks, [{ id: ID }]))
  }
  assert.throws(() => wire.pushAcks([{ id: ID, status: "applied" }, { id: OLD, status: "applied" }], [{ id: ID }, { id: OTHER }]))
})
test("push validates local keys before HTTP and maps legacy ACKs to canonical keys", async () => {
  const h = endpointHarness({ post: () => ({ server_time: AT, entries: [{ id: OLD, status: "applied" }], tags: [], media_meta: [] }) })
  await assert.rejects(h.api.pushBatch({ entries: [entry({ id: OLD })], tags: [], mediaMeta: [] }))
  assert.equal(h.calls.length, 0)
  const result = await h.api.pushBatch({ entries: [entry()], tags: [], mediaMeta: [] })
  assert.equal(result.entries[0].id, ID); assert.equal(h.calls[0].args[1].entries[0].id, ID)
})
test("pull normalizes explicit page/cursor identities before any persistence", async () => {
  const h = endpointHarness({ get: () => ({ server_time: AT, sync_until: AT, cursor_id: OLD,
    has_more: true, entries: [entry({ id: OLD })], tags: [], media_meta: [media({ id: OLD })] }) })
  const page = await h.api.pullChanges({ since: AT, afterId: OLD, limit: 20 })
  assert.equal(h.calls[0].args[1].after_id, ID); assert.equal(page.cursorId, ID)
  assert.equal(page.entries[0].id, ID); assert.equal(page.mediaMeta[0].id, ID)
  assert.equal(page.mediaMeta[0].url, `/media/${OLD}.png`)
})
test("malformed/ambiguous page is rejected as a whole", async () => {
  const raw = { server_time: AT, sync_until: AT, cursor_id: null, has_more: false,
    entries: [entry(), entry({ id: OLD })], tags: [], media_meta: [] }
  const h = endpointHarness({ get: () => raw })
  await assert.rejects(h.api.pullChanges({ since: AT, limit: 20 }))
  raw.entries = []; raw.has_more = true
  await assert.rejects(h.api.pullChanges({ since: AT, limit: 20 }))
})
test("media upload binds path/form/ACK identity, preserving exact old server URL", async () => {
  const h = endpointHarness({ post: () => media({ id: OLD }) })
  const result = await h.api.uploadMedia(ID, new Blob(["png"], { type: "image/png" }), { entryId: OTHER })
  assert.equal(h.calls[0].args[0], `/media/${ID}`)
  assert.equal(h.calls[0].args[1].get("entry_id"), OTHER)
  assert.equal(h.calls[0].args[1].get("file").name, `${ID}.png`)
  assert.equal(result.id, ID); assert.equal(result.url, `/media/${OLD}.png`)
  const wrong = endpointHarness({ post: () => media({ id: OTHER }) })
  await assert.rejects(wrong.api.uploadMedia(ID, new Blob(["png"])))
  const legacy = endpointHarness(); await assert.rejects(legacy.api.uploadMedia(OLD, new Blob(["png"])))
  assert.equal(legacy.calls.length, 0)
})
test("entry path/body mismatch and legacy deletion never send HTTP", async () => {
  const h = endpointHarness()
  await assert.rejects(h.api.putEntry(ID, entry({ id: OTHER })))
  await assert.rejects(h.api.deleteEntry(OLD, AT)); assert.equal(h.calls.length, 0)
})
test("new media references and read/export projections accept hex32; old exact local keys stay readable", () => {
  const text = loadTS("shared/text.ts"), notebook = loadTS("shared/notebookContent.ts")
  assert.equal(text.toLocalSrc(ID), `local://media/${ID}`)
  assert.throws(() => text.toLocalSrc(OLD))
  for (const id of [ID, OLD]) {
    assert.equal(text.parseLocalSrc(`local://media/${id}`), id)
    assert.equal(notebook.notebookMediaId(`local://media/${id}`), id)
    const projection = notebook.projectNotebookContent({ schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: `local://media/${id}` } }] } })
    assert.deepEqual(plain(projection.mediaIds), [id])
  }
  for (const suffix of ["?x", "#x", "/extra", "\n"]) {
    assert.equal(text.parseLocalSrc(`local://media/${ID}${suffix}`), null)
    assert.equal(notebook.notebookMediaId(`local://media/${ID}${suffix}`), null)
  }
})
test("schedule-derived identity uses new hex32 without mutating old offline keys", () => {
  const schedules = loadTS("shared/schedules.ts")
  assert.equal(schedules.scheduleEntryId(ID), ID)
  assert.equal(schedules.scheduleEntryId(OLD), OLD)
  for (const invalid of ["bad", `${ID}\n`, `{${OLD}}`]) assert.throws(() => schedules.scheduleEntryId(invalid))
})
test("pinned detail/review/resources/convert accept new identities under the existing lease", async () => {
  const h = networkHarness(() => ({ status: 200, data: { code: 0, data: { ok: true } } }))
  const lease = { ownerUserId: "account-a", tokenGeneration: 0 }
  await h.api.getPinnedScheduleDetail(ID, lease)
  await h.api.getPinnedScheduleReview(ID, lease)
  await h.api.getPinnedScheduleResourceReview(ID, lease)
  await h.api.postPinnedSchedule(`/schedules/${ID}/convert`, {}, lease)
  assert.equal(h.calls.length, 4); assert.ok(h.calls.every(call => call.url.includes(ID)))
  await assert.rejects(h.api.postPinnedSchedule(`/schedules/${ID}/convert\n`, {}, lease))
  await assert.rejects(h.api.getPinnedScheduleDetail(`${ID}?x`, lease))
  assert.equal(h.calls.length, 4)
})
test("late hex32 schedule response is held after account switch", async () => {
  let release
  const h = networkHarness(() => new Promise(resolve => { release = resolve }))
  const pending = h.api.getPinnedScheduleDetail(ID, { ownerUserId: "account-a", tokenGeneration: 0 })
  h.switch("account-b"); release({ status: 200, data: { code: 0, data: {} } })
  await assert.rejects(pending); assert.equal(h.refreshes(), 0)
})
test("isolated HTTP config accepts hex32 and canonical fixture input, never uppercase/URN/whitespace", () => {
  const { validateConfig } = require("../scripts/check-p4-resource-http.cjs")
  const config = { origin: "http://127.0.0.1:49152", nonce: "n".repeat(43), source_id: OLD,
    media_id: OTHER, user_id: ID, token: "a.b.c", other_token: "d.e.f", scenario: "roundtrip" }
  assert.equal(validateConfig(config).source_id, ID); assert.equal(config.source_id, OLD)
  for (const source_id of [ID.toUpperCase(), ` ${ID}`, `urn:uuid:${OLD}`, `${ID}\n`]) {
    assert.throws(() => validateConfig({ ...config, source_id }))
  }
})
function scheduleWire(id = ID, converted = false) {
  return { id, remind_date: "2026-10-26", title: "青简", content: null, content_text: "",
    status: converted ? "converted" : "pending", converted_entry_id: converted ? id : null,
    converted_at: converted ? AT : null, client_updated_at: AT, deleted_at: null, created_at: AT, updated_at: AT }
}
test("real schedule DTO/push/conversion/review parsers accept hex32 relationships", () => {
  const push = loadTS("shared/schedulePush.ts"), conversion = loadTS("shared/scheduleConversionSync.ts")
  const review = loadTS("shared/scheduleTerminalReview.ts")
  const local = push.parseScheduleWire(scheduleWire(), ID)
  assert.equal(push.buildSchedulePushItem({ ...local, dirty: 1 }).wire.id, ID)
  const rawEntry = entry({ from_schedule_id: ID, tag_ids: [], created_at: AT, updated_at: AT })
  const ack = { confirmed: true, reason: "applied", created: true, first_entry_date: rawEntry.entry_date,
    first_entry_deleted: false, schedule: scheduleWire(ID, true), entry: rawEntry, entry_state: "active" }
  const parsed = conversion.parseConversionAck(ack, { intent: { scheduleId: ID, entry: { entryDate: rawEntry.entry_date, isDeleted: 0 } } })
  assert.equal(parsed.schedule.convertedEntryId, ID); assert.equal(parsed.entry.fromScheduleId, ID)
  const checked = review.parseScheduleTerminalReview({ read_only: true, reviewable: true, reason: "terminal_review",
    schedule: ack.schedule, entry: ack.entry, entry_state: "active", receipt_known: true,
    first_entry_date: rawEntry.entry_date, first_entry_deleted: false }, ID)
  assert.equal(checked.entry.id, ID); assert.equal(checked.reviewable, true)
  assert.throws(() => conversion.parseConversionEntry({ ...rawEntry, from_schedule_id: OTHER }, ID))
})
test("real schedule pagination preserves hex32 cursor binding and rejects wrong last identity", () => {
  const pull = loadTS("shared/schedulePull.ts")
  const ticket = { lease: { ownerUserId: ID, generation: "g", tokenGeneration: 0 },
    cursor: { since: "2026-10-25T00:00:00.000Z", afterId: null, until: null }, fingerprint: "f", limit: 1 }
  const raw = { schedules: [scheduleWire()], sync_until: AT, server_time: AT, has_more: true, cursor_id: ID }
  const page = pull.parseSchedulePullPage(raw, ticket)
  assert.equal(page.next.afterId, ID); assert.equal(page.rows[0].id, ID)
  assert.throws(() => pull.parseSchedulePullPage({ ...raw, cursor_id: OTHER }, ticket))
})
test("legacy schedule evidence remains readable without being silently converted", () => {
  const push = loadTS("shared/schedulePush.ts")
  assert.equal(push.parseScheduleWire(scheduleWire(OLD), OLD).id, OLD)
})
test("private media reads normalize old input only at the network boundary", async () => {
  const calls = [], lease = { ownerUserId: ID, tokenGeneration: 0 }
  const api = loadTS("api/privateMedia.ts", {
    "./request": { ApiError: Error, http: { get: async (path, options) => {
      calls.push({ path, options }); return { status: 200, data: new Blob(["png"], { type: "image/png" }) }
    } } },
    "./tokenStore": { accessTokenSubject: () => ID, tokenGeneration: () => 0 },
  }, { AbortController })
  const blob = await api.readPrivateMedia(OLD, "original", lease)
  assert.equal(blob.size, 3); assert.equal(calls[0].path, `/media/${ID}/original`)
  await assert.rejects(api.readPrivateMedia(`${ID}?x`, "original", lease))
  await assert.rejects(api.readPrivateMedia(ID, "invalid", lease)); assert.equal(calls.length, 1)
})
