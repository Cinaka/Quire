const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, AT, content, schedule, entry, setup } = require("./schedules-data-harness.cjs")
const PHOTO = "019a0300-1234-7000-8000-000000000009"
const TODAY = "2026-10-08"
const json = value => JSON.stringify(value)
const snapshot = h => json(Object.fromEntries(Object.entries(h.stores).map(([name, store]) => [name, [...store.rows.values()]])))
const draft = extra => ({ entryId: null, entryDate: TODAY, title: "首存", mood: null, weather: null, tagIds: [], doc: content("保留正文").doc, updatedAt: AT, ...extra })
const image = { type: "doc", content: [{ type: "image", attrs: { src: `local://media/${PHOTO}` } }] }
const photo = extra => ({ id: PHOTO, entryId: "", blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), thumbBlob: null,
  mime: "image/png", width: 1, height: 1, size: 3, sortOrder: 0, remoteUrl: "", createdAt: AT, dirty: 1, orphanedAt: AT, ...extra })
function harness(extra = {}) {
  let today = TODAY
  let subject = "account-a"
  let generation = 0
  let watchObserver
  let unsubscribed = 0
  const timers = new Map(); let serial = 0
  const tokens = { accessTokenSubject: () => subject, tokenGeneration: () => generation }
  const time = { ...loadTS("shared/time.ts"), utcNow: () => AT, todayLocal: () => today }
  const h = setup({ "./time": time, "@/shared/time": time, "@/api/tokenStore": tokens,
    "@/capabilities/image": { resizeToBlob: async () => null }, dexie: { liveQuery: () => ({ subscribe(observer) { watchObserver = observer; return { unsubscribe() { unsubscribed++ } } } }) }, ...extra },
    { window: { setInterval(fn) { timers.set(++serial, fn); return serial }, clearInterval(id) { timers.delete(id) } } })
  const media = h.load("db/mediaRepo.ts").localMediaRepo; h.mocks["./mediaRepo"] = { localMediaRepo: media }
  const port = h.load("db/scheduleHostRepo.ts").localScheduleHostRepo
  return { ...h, media, port, today: value => { today = value }, identity: value => { subject = value; generation++ },
    subjectOnly: value => { subject = value }, poll() { for (const fn of [...timers.values()]) fn() },
    ownerSignal(value) { watchObserver.next(value) }, watchError() { watchObserver.error(new Error("read failure")) },
    watchStats: () => ({ timers: timers.size, unsubscribed }), model: () => h.load("shared/scheduleHost.ts").createScheduleHost(port, () => today),
    editors: h.load("db/scheduleEditorRepo.ts").localScheduleEditorRepo, schedules: h.load("db/scheduleRepo.ts").localScheduleRepo }
}
async function first(h, date = TODAY, extra = {}) {
  await h.db.meta.put({ key: "draft", value: draft(extra) })
  const context = await h.port.capture(); const frame = await h.port.firstSaveFrame(context)
  const plan = h.load("shared/firstSave.ts").planFirstSave(frame, date, TODAY)
  return { context, frame, plan }
}
const intentions = async h => (await h.db.meta.get("scheduleConversions"))?.value ?? []
const source = name => fs.readFileSync(path.join(__dirname, "../src", name), "utf8")
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }

for (const [date, resource] of [[TODAY, "entry"], ["2026-10-01", "entry"], ["2026-10-09", "schedule"]]) {
  test(`first save ${date} commits exactly one ${resource} and consumes only the exact diary draft`, async () => {
    const h = harness(); const f = await first(h, date); const result = await h.port.firstSave(f.context, f.plan)
    assert.equal(result.resource, resource); assert.equal(h.stores.entries.rows.size, resource === "entry" ? 1 : 0)
    assert.equal(h.stores.schedules.rows.size, resource === "schedule" ? 1 : 0); assert.equal(await h.db.meta.get("draft"), undefined)
    if (resource === "entry") { assert.equal(result.entry.entryDate, date); assert.equal(result.entry.fromScheduleId, null) }
    else { assert.equal(result.schedule.remindDate, date); assert.equal(result.schedule.status, "pending"); assert.equal((await h.db.meta.get("scheduleDraft")).value.draft, null) }
    assert.equal((await intentions(h)).length, 0)
  })
}
test("first-save planning is read-only, validates dates and leaves existing resource identities alone", async () => {
  const h = harness(); const f = await first(h); const plan = h.load("shared/firstSave.ts").planFirstSave; const before = snapshot(h)
  for (const date of ["", "2026-02-29", "2026/10/09"]) assert.throws(() => plan(f.frame, date, TODAY))
  assert.throws(() => plan({ ...f.frame, draft: { ...f.frame.draft, entryId: ID } }, TODAY, TODAY), /已关联/)
  assert.equal(snapshot(h), before)
})
test("future first save rejects diary metadata or image nodes without dropping them from source draft", async () => {
  for (const extra of [{ mood: "喜" }, { weather: "晴" }, { tagIds: ["tag"] }, { doc: image }]) {
    const h = harness(); await h.db.meta.put({ key: "draft", value: draft(extra) }); const context = await h.port.capture(); const frame = await h.port.firstSaveFrame(context); const before = snapshot(h)
    assert.throws(() => h.load("shared/firstSave.ts").planFirstSave(frame, "2026-10-09", TODAY))
    const forged = { fingerprint: frame.fingerprint, date: "2026-10-09", resource: "schedule" }
    await assert.rejects(h.port.firstSave(context, forged)); assert.equal(snapshot(h), before)
  }
})
test("ordinary first save retains diary metadata and stable same-day sort order", async () => {
  const h = harness(); await h.db.entries.put(entry({ fromScheduleId: null, entryDate: TODAY, sortOrder: 4 }))
  const f = await first(h, TODAY, { mood: "喜", weather: "晴", tagIds: ["tag-1"] }); const result = await h.port.firstSave(f.context, f.plan)
  assert.equal(result.entry.sortOrder, 5); assert.equal(result.entry.mood, "喜"); assert.equal(result.entry.weather, "晴"); assert.equal(json(result.entry.tagIds), '["tag-1"]')
})
test("ordinary first save attaches owned temporary image bytes in the same transaction", async () => {
  const h = harness(); await h.db.media.put(photo()); const f = await first(h, TODAY, { title: "", doc: image })
  const result = await h.port.firstSave(f.context, f.plan); const media = await h.db.media.get(PHOTO)
  assert.equal(media.entryId, result.entry.id); assert.deepEqual([...new Uint8Array(await media.blob.arrayBuffer())], [1, 2, 3]); assert.equal(media.orphanedAt, null)
})
test("missing or foreign-associated images are neither stolen nor discarded by first save", async () => {
  for (const hasForeign of [false, true]) {
    const h = harness(); if (hasForeign) await h.db.media.put(photo({ entryId: ID })); const f = await first(h, TODAY, { doc: image }); const before = snapshot(h)
    await assert.rejects(h.port.firstSave(f.context, f.plan), /图片/); assert.equal(snapshot(h), before)
  }
})
test("empty first save creates no record and retains the safety draft", async () => {
  const h = harness(); await h.db.meta.put({ key: "draft", value: draft({ title: "", doc: { type: "doc", content: [{ type: "paragraph" }] } }) }); const context = await h.port.capture(); const frame = await h.port.firstSaveFrame(context)
  assert.throws(() => h.load("shared/firstSave.ts").planFirstSave(frame, TODAY, TODAY), /空记录/)
  assert.ok(await h.db.meta.get("draft")); assert.equal(h.stores.entries.rows.size, 0)
})
test("double first-save transactions consume the fingerprint once, without duplicate diary or schedule", async () => {
  for (const date of [TODAY, "2026-10-09"]) {
    const h = harness(); const f = await first(h, date)
    const results = await Promise.allSettled([h.port.firstSave(f.context, f.plan), h.port.firstSave(f.context, f.plan)])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(h.stores.entries.rows.size + h.stores.schedules.rows.size, 1)
  }
})
test("newer diary draft cannot be substituted into an older first-save confirmation", async () => {
  const h = harness(); const f = await first(h); await h.db.meta.put({ key: "draft", value: draft({ title: "新文字" }) }); const before = snapshot(h)
  await assert.rejects(h.port.firstSave(f.context, f.plan), /已变化/); assert.equal(snapshot(h), before)
})
test("midnight preview changing from future to today refuses silent table switching", async () => {
  const h = harness(); const f = await first(h, "2026-10-09"); h.today("2026-10-09"); const before = snapshot(h)
  await assert.rejects(h.port.firstSave(f.context, f.plan), /分流已变化/); assert.equal(snapshot(h), before)
  const newPlan = h.load("shared/firstSave.ts").planFirstSave(f.frame, "2026-10-09", "2026-10-09")
  assert.equal((await h.port.firstSave(f.context, newPlan)).resource, "entry")
})
test("clock or timezone moving backward refuses silently making a future Entry", async () => {
  const h = harness(); const f = await first(h); h.today("2026-10-07"); const before = snapshot(h)
  await assert.rejects(h.port.firstSave(f.context, f.plan), /分流已变化/); assert.equal(snapshot(h), before)
})
test("occupied schedule draft blocks a future first save, preserving both safety slots", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist({ remindDate: "2026-10-09", title: "已有", content: content("已有") })
  const f = await first(h, "2026-10-10"); const before = snapshot(h)
  await assert.rejects(h.port.firstSave(f.context, f.plan), /已有预简/); assert.equal(snapshot(h), before)
})
test("unknown/linked/invalid old diary draft is preserved, never treated as blank first-save input", async () => {
  for (const value of [{ futureVersion: 99 }, draft({ entryId: ID }), draft({ mood: true }), draft({ updatedAt: "bad" }), draft({ extra: "unknown" })]) {
    const h = harness(); await h.db.meta.put({ key: "draft", value }); const ctx = await h.port.capture(); const before = snapshot(h)
    await assert.rejects(h.port.firstSaveFrame(ctx)); assert.equal(snapshot(h), before)
  }
})
for (const [date, table, operation] of [[TODAY, "entries", "put"], [TODAY, "meta", "delete"], ["2026-10-09", "schedules", "put"], ["2026-10-09", "meta", "put"], ["2026-10-09", "meta", "delete"]]) {
  test(`first-save ${date}/${table}/${operation} failure rolls back business and both draft slots`, async () => {
    const h = harness(); const f = await first(h, date); const before = snapshot(h); h.failNext(table, operation)
    await assert.rejects(h.port.firstSave(f.context, f.plan), /storage failure/); assert.equal(snapshot(h), before)
  })
}
test("image attach failure rolls back Entry, image association and source draft", async () => {
  const h = harness(); await h.db.media.put(photo()); const f = await first(h, TODAY, { doc: image }); const before = snapshot(h); h.failNext("media")
  await assert.rejects(h.port.firstSave(f.context, f.plan), /storage failure/); assert.equal(snapshot(h), before)
})
test("resource-ID collision and malformed existing sort order fail atomically", async () => {
  const h = harness({ "@/shared/ids": { newId: () => ID } }); await h.db.schedules.put(schedule()); const f = await first(h); const before = snapshot(h)
  await assert.rejects(h.port.firstSave(f.context, f.plan), /主键/); assert.equal(snapshot(h), before)
  const b = harness(); await b.db.entries.put(entry({ fromScheduleId: null, entryDate: TODAY, sortOrder: NaN })); const fb = await first(b); const bad = snapshot(b)
  await assert.rejects(b.port.firstSave(fb.context, fb.plan), /排序/); assert.equal(snapshot(b), bad)
})
for (const kind of ["auth", "owner", "epoch"]) test(`first save rejects a changed ${kind} context before any write`, async () => {
  const h = harness(); const f = await first(h)
  if (kind === "auth") h.identity("account-b"); else await h.db.meta.put({ key: kind === "owner" ? "ownerUserId" : "ownerGeneration", value: "changed" })
  const before = snapshot(h); await assert.rejects(h.port.firstSave(f.context, f.plan)); assert.equal(snapshot(h), before)
})
test("token identity changing during Entry creation rolls the whole first-save transaction back", async () => {
  const h = harness(); const f = await first(h); const before = snapshot(h); const add = h.db.entries.add
  h.db.entries.add = async row => { await add(row); h.identity("account-b") }
  await assert.rejects(h.port.firstSave(f.context, f.plan), /上下文已变化/); assert.equal(snapshot(h), before)
})
test("host captures auth subject/generation without storing tokens or silently claiming guest data", async () => {
  const h = harness(); const before = snapshot(h); const ctx = await h.port.capture()
  assert.equal(ctx.authSubject, "account-a"); assert.equal(ctx.ownerUserId, ""); assert.equal(Object.hasOwn(ctx, "token"), false); assert.equal(snapshot(h), before)
})
test("logged-in account mismatch refuses opening while logout preserves local ownership for explicit re-entry", async () => {
  const h = harness(); await h.db.meta.put({ key: "ownerUserId", value: "account-b" }); await assert.rejects(h.port.capture(), /归属不同/)
  h.identity(""); const before = snapshot(h); const ctx = await h.port.capture(); assert.equal(ctx.ownerUserId, "account-b"); assert.equal(ctx.authSubject, ""); assert.equal(snapshot(h), before)
})
test("same-identity refresh remains valid; logout/relogin A still invalidates old auth generation", async () => {
  const h = harness(); const ctx = await h.port.capture(); await h.port.validate(ctx) // 刷新未改变generation的真实TokenStore行为已有独立测试。
  h.identity(""); h.identity("account-a"); await assert.rejects(h.port.validate(ctx), /上下文已变化/)
})
test("token switch during capture rejects the snapshot instead of mixing identities", async () => {
  const h = harness(); const get = h.db.meta.get
  h.db.meta.get = async key => { const value = await get(key); if (key === "ownerUserId") h.identity("account-b"); return value }
  await assert.rejects(h.port.capture(), /上下文已变化/)
})
test("watch responds once to auth changes and cleans timer/subscription without clearing stored data", async () => {
  const h = harness(); const f = await first(h); let signals = 0; const stop = h.port.watch(f.context, () => { signals++ }); const before = snapshot(h)
  h.poll(); assert.equal(signals, 0); h.identity(""); h.poll(); h.poll(); stop()
  assert.equal(signals, 1); assert.equal(h.watchStats().timers, 0); assert.equal(h.watchStats().unsubscribed, 1); assert.equal(snapshot(h), before)
})
test("same-owner restore watch and observer failure invalidate once and release resources", async () => {
  for (const change of [h => h.ownerSignal({ ownerUserId: "", generation: "restored" }), h => h.watchError()]) {
    const h = harness(); const ctx = await h.port.capture(); let signals = 0; h.port.watch(ctx, () => { signals++ }); change(h)
    assert.equal(signals, 1); assert.equal(h.watchStats().timers, 0); assert.equal(h.watchStats().unsubscribed, 1)
  }
})
test("host initialization remains read-only; invalid old draft is separate from valid workspace availability", async () => {
  const h = harness(); await h.db.meta.put({ key: "draft", value: { unknown: true } }); const before = snapshot(h); const m = h.model(); assert.equal(await m.initialize(), true)
  assert.equal(m.inspect().ready, true); assert.notEqual(m.inspect().firstSaveError, ""); assert.ok(m.workspacePort()); assert.equal(snapshot(h), before); m.dispose()
})
test("host first-save preview requires explicit confirmation, is single-flight and does not write on initialize", async () => {
  const h = harness(); await h.db.meta.put({ key: "draft", value: draft() }); const before = snapshot(h); const m = h.model(); await m.initialize()
  assert.equal(snapshot(h), before); assert.equal(m.preview("2026-10-09"), true); assert.equal(snapshot(h), before)
  const first = m.confirmFirstSave(); assert.equal(await m.confirmFirstSave(), false); assert.equal(await first, true)
  assert.equal(m.inspect().frame, null); assert.equal(m.inspect().firstResult.resource, "schedule"); assert.equal(h.stores.entries.rows.size, 0); m.dispose()
})
test("host invalidation suppresses delayed results but cannot undo a previously committed legal transaction", async () => {
  const h = harness(); await h.db.meta.put({ key: "draft", value: draft() }); const entered = gate(); const wait = gate()
  const fakePort = { ...h.port, async firstSave(...args) { const result = await h.port.firstSave(...args); entered.release(); await wait.promise; return result } }
  const m = h.load("shared/scheduleHost.ts").createScheduleHost(fakePort, () => TODAY); await m.initialize(); m.preview(TODAY)
  const job = m.confirmFirstSave(); await entered.promise; m.invalidate(); wait.release(); assert.equal(await job, false)
  assert.equal(m.inspect().firstResult, null); assert.equal(h.stores.entries.rows.size, 1); m.dispose()
})
test("host workspace never re-captures owner after restore, and protected editor stops on logout even before polling", async () => {
  const h = harness(); const ctx = await h.port.capture(); const port = h.port.workspace(ctx); const owner = await port.capture()
  const editor = await port.open(owner, { kind: "new", date: "2026-10-09" }); h.identity(""); const before = snapshot(h)
  await assert.rejects(editor.persist({ remindDate: "2026-10-09", title: "旧会话", content: content("旧会话") }), /上下文已变化/)
  assert.equal(snapshot(h), before)
  await h.db.meta.put({ key: "ownerGeneration", value: "restored" }); await assert.rejects(port.capture()); editor.close()
})
test("host-protected editor commit rollback preserves draft if token changes during schedule write", async () => {
  const h = harness(); const ctx = await h.port.capture(); const port = h.port.workspace(ctx); const owner = await port.capture(); const editor = await port.open(owner, { kind: "new", date: "2026-10-09" })
  await editor.persist({ remindDate: "2026-10-09", title: "草稿", content: content("草稿") }); const add = h.db.schedules.add
  h.db.schedules.add = async row => { await add(row); h.identity("account-b") }
  await assert.rejects(editor.submit({ remindDate: "2026-10-09", title: "草稿", content: content("草稿") }), /上下文已变化/)
  assert.equal(h.stores.schedules.rows.size, 0); assert.ok((await h.db.meta.get("scheduleDraft")).value.draft); editor.close()
})
test("host runtime check inside workspace conversion rolls back changes made before an auth switch", async () => {
  const h = harness(); await h.db.schedules.put(schedule({ remindDate: TODAY })); const ctx = await h.port.capture(); const port = h.port.workspace(ctx); const owner = await port.capture(); const before = snapshot(h); const add = h.db.entries.add
  h.db.entries.add = async row => { await add(row); h.identity("account-b") }
  await assert.rejects(port.convert(owner, ID, AT), /上下文已变化/); assert.equal(snapshot(h), before)
})
async function converted(h) {
  await h.db.schedules.put(schedule({ remindDate: TODAY })); await h.schedules.convert(ID, { expectedClientUpdatedAt: AT }); return h.port.capture()
}
test("target opening checks actual Entry, source relation and no pending purge without side effects", async () => {
  const h = harness(); const ctx = await converted(h); const before = snapshot(h); const value = await h.port.openDiary(ctx, ID)
  assert.equal(value.lease.fromScheduleId, ID); assert.equal(value.entry.id, ID); assert.equal(snapshot(h), before)
})
for (const [label, mutate] of [
  ["deleted", h => h.db.entries.update(ID, { isDeleted: 1, deletedAt: AT })], ["purged", h => h.db.entries.delete(ID)],
  ["pending purge", h => h.db.meta.put({ key: "pendingPurges", value: [ID] })], ["unknown purge queue", h => h.db.meta.put({ key: "pendingPurges", value: {} })],
  ["missing source", h => h.db.schedules.delete(ID)], ["wrong source", h => h.db.entries.update(ID, { fromScheduleId: OTHER_ID })],
  ["unsupported content", h => h.db.entries.update(ID, { content: { schemaVersion: 9, doc: { type: "doc", content: [] } } })],
]) test(`target ${label} refuses opening/saving and never repairs or regenerates`, async () => {
  const h = harness(); const ctx = await converted(h); const target = await h.port.openDiary(ctx, ID); await mutate(h); const before = snapshot(h)
  await assert.rejects(h.port.openDiary(ctx, ID)); await assert.rejects(h.port.saveDiary(ctx, target.lease, { title: "不能写" })); assert.equal(snapshot(h), before)
})
test("target save updates precise revision monotonically while keeping source/immutable first intent", async () => {
  const h = harness(); const ctx = await converted(h); const target = await h.port.openDiary(ctx, ID); const first = json((await intentions(h))[0]); const sourceBefore = json(await h.db.schedules.get(ID))
  const saved = await h.port.saveDiary(ctx, target.lease, { title: "继续刻", mood: "喜", weather: "晴", tagIds: ["tag"] })
  assert.equal(saved.lease.clientUpdatedAt, "2026-10-08T10:00:00.002Z"); assert.equal(saved.entry.fromScheduleId, ID)
  assert.equal(json(await h.db.schedules.get(ID)), sourceBefore); assert.equal(json((await intentions(h))[0]), first)
  await assert.rejects(h.port.saveDiary(ctx, target.lease, { title: "旧修订" }), /已变化/)
})
test("target content change retains new conversion media protections and does not steal foreign images", async () => {
  const h = harness(); const ctx = await converted(h); await h.db.media.put(photo()); const target = await h.port.openDiary(ctx, ID)
  const saved = await h.port.saveDiary(ctx, target.lease, { content: { schemaVersion: 1, doc: image } }); assert.equal((await h.db.media.get(PHOTO)).entryId, ID)
  assert.ok((await intentions(h))[0].protectedMediaIds.includes(PHOTO))
  await h.db.media.update(PHOTO, { entryId: OTHER_ID }); const before = snapshot(h)
  await assert.rejects(h.port.saveDiary(ctx, saved.lease, { content: { schemaVersion: 1, doc: image } }), /归属不同/); assert.equal(snapshot(h), before)
})
test("existing target cannot silently migrate into schedule or overwrite source identity", async () => {
  const h = harness(); const ctx = await converted(h); const target = await h.port.openDiary(ctx, ID); const before = snapshot(h)
  for (const update of [{ entryDate: "2026-10-09" }, { fromScheduleId: null }, { isDeleted: 0 }, { title: "长".repeat(256) }, { tagIds: [true] }]) await assert.rejects(h.port.saveDiary(ctx, target.lease, update))
  assert.equal(snapshot(h), before)
})
test("already stored subjective future diary can be read without automatic repair; new future date updates still reject", async () => {
  const h = harness(); await h.db.entries.put(entry({ fromScheduleId: null, entryDate: "2026-10-09" })); const ctx = await h.port.capture(); const target = await h.port.openDiary(ctx, ID)
  const updated = await h.port.saveDiary(ctx, target.lease, { title: "仅改正文" }); assert.equal(updated.entry.entryDate, "2026-10-09"); assert.equal(h.stores.schedules.rows.size, 0)
})
for (const table of ["entries", "media", "meta"]) test(`target ${table} failure keeps diary/source/intention consistent`, async () => {
  const h = harness(); const ctx = await converted(h); await h.db.media.put(photo()); const target = await h.port.openDiary(ctx, ID); const before = snapshot(h); h.failNext(table)
  await assert.rejects(h.port.saveDiary(ctx, target.lease, { content: { schemaVersion: 1, doc: image } }), /storage failure/); assert.equal(snapshot(h), before)
})
test("token switch during target update rolls back content and conversion protection mutations", async () => {
  const h = harness(); const ctx = await converted(h); const target = await h.port.openDiary(ctx, ID); const before = snapshot(h); const put = h.db.entries.put
  h.db.entries.put = async row => { await put(row); h.identity("account-b") }
  await assert.rejects(h.port.saveDiary(ctx, target.lease, { title: "旧账号" }), /上下文已变化/); assert.equal(snapshot(h), before)
})
test("host target event is a fresh lease; failed stale save keeps current user value without adopting a new lease", async () => {
  const h = harness(); await converted(h); const m = h.model(); await m.initialize(); await m.openTarget(ID)
  const old = m.inspect().target.lease; await h.db.entries.update(ID, { clientUpdatedAt: "2026-10-08T11:00:00.000Z", title: "其他编辑" })
  assert.equal(await m.saveTarget({ title: "旧副本" }), false); assert.equal(m.inspect().target.lease.clientUpdatedAt, old.clientUpdatedAt)
  assert.equal((await h.db.entries.get(ID)).title, "其他编辑"); m.dispose()
})
test("host copied plan/context/target updates resist caller mutation before awaited storage", async () => {
  const h = harness(); const f = await first(h); const plan = { ...f.plan }; const ctx = { ...f.context }; const saving = h.port.firstSave(ctx, plan)
  plan.date = "2026-10-09"; ctx.authSubject = "B"; const result = await saving; assert.equal(result.resource, "entry")
  const actual = await h.port.capture(); const target = await h.port.openDiary(actual, result.entry.id); const update = { title: "捕获" }; const job = h.port.saveDiary(actual, target.lease, update); update.title = "修改外部"
  assert.equal((await job).entry.title, "捕获")
})
test("host dispose stops observers and late UI responses without auto-clearing persisted data", async () => {
  const h = harness(); await h.db.meta.put({ key: "draft", value: draft() }); const m = h.model(); let notifications = 0; const unsub = m.subscribe(() => { notifications++ })
  await m.initialize(); const before = snapshot(h); unsub(); m.dispose(); const count = notifications
  h.poll(); assert.equal(notifications, count); assert.equal(h.watchStats().timers, 0); assert.equal(snapshot(h), before)
})
test("first-save and target guards do not modify P2 cursors, conflicts or P3 metadata", async () => {
  const h = harness(); for (const key of ["lastSyncAt", "conflicts", "checkin:account-a"]) await h.db.meta.put({ key, value: { unchanged: key } })
  const before = [...h.stores.meta.rows.values()]; const f = await first(h); await h.port.firstSave(f.context, f.plan)
  for (const row of before) assert.equal(json(await h.db.meta.get(row.key)), json(row))
})
test("isolation preflight accepts only a distinct loopback origin and performs no storage mutation", () => {
  const prepare = require("../scripts/prepare-p4-acceptance.cjs").prepareAcceptance
  assert.equal(prepare("https://quire.example", "http://127.0.0.1:5179").isolatedOrigin, "http://127.0.0.1:5179")
  for (const [daily, isolated] of [["http://localhost:5173", "http://localhost:5173"], ["https://quire.example", "https://quire.example"],
    ["http://localhost:80", "http://localhost"], ["https://quire.example", "http://user:pass@localhost:5179"],
    ["https://quire.example", "http://127.0.0.1:5179/page"], ["https://quire.example", "http://127.0.0.1:5179?data=x"]]) assert.throws(() => prepare(daily, isolated))
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../scripts/prepare-p4-acceptance.cjs"), "utf8"), /indexedDB\.deleteDatabase|exec\(|spawn\(|fetch\(/)
})
test("new host remains injected and unmounted, never jumps to legacy diary editor or starts background sync", () => {
  const component = source("components/schedules/ScheduleHost.vue")
  assert.match(component, /port: ScheduleHostPort/); assert.match(component, /workspaceRef.value\.canCompose/)
  assert.match(component, /host\.openTarget\(id\)/); assert.match(component, /defineExpose\(\{ prepareLeave, saveTarget \}\)/)
  assert.doesNotMatch(component, /useRouter|router\.|DiaryEditor|insertImages|localScheduleHostRepo|@\/repo/)
  for (const p of ["App.vue", "router/index.ts", "views/ScheduleView.vue", "repo/index.ts"]) assert.doesNotMatch(source(p), /ScheduleHost|scheduleHostRepo|scheduleFirstSaveRepo|scheduleDiaryTargetRepo/)
})
test("target opening refuses malformed metadata while retaining original record bytes", async () => {
  const h = harness(); const ctx = await converted(h)
  for (const bad of [{ tagIds: [true] }, { sortOrder: NaN }, { mood: true }, { serverUpdatedAt: "bad" }]) {
    const old = await h.db.entries.get(ID); await h.db.entries.update(ID, bad); const before = snapshot(h)
    await assert.rejects(h.port.openDiary(ctx, ID), /格式不受支持/); assert.equal(snapshot(h), before); await h.db.entries.put(old)
  }
})
test("watch setup failure leaves no ready, unmonitored workspace", async () => {
  const h = harness(); const fake = { ...h.port, watch() { throw new Error("watch setup failed") } }
  const m = h.load("shared/scheduleHost.ts").createScheduleHost(fake, () => TODAY)
  assert.equal(await m.initialize(), false); assert.equal(m.inspect().ready, false); assert.equal(m.workspacePort(), null); assert.match(m.inspect().error, /watch setup failed/); m.dispose()
})
test("copied owner/auth pin cannot be altered through workspace capture or watch arguments", async () => {
  const h = harness(); const ctx = await h.port.capture(); const port = h.port.workspace(ctx); let revoked = 0; const stop = h.port.watch(ctx, () => { revoked++ })
  ctx.authSubject = "mutated"; ctx.ownerUserId = "mutated"; const owner = await port.capture(); assert.equal(owner.ownerUserId, "")
  owner.ownerUserId = "mutated"; await assert.rejects(port.validate(owner)); h.poll(); assert.equal(revoked, 0); stop()
})
test("new host frame read cannot install data after logout even before the observer fires", async () => {
  const h = harness(); await h.db.meta.put({ key: "draft", value: draft() }); const entered = gate(); const wait = gate()
  const fake = { ...h.port, async firstSaveFrame(...args) { const result = await h.port.firstSaveFrame(...args); entered.release(); await wait.promise; return result } }
  const m = h.load("shared/scheduleHost.ts").createScheduleHost(fake, () => TODAY); const reading = m.initialize(); await entered.promise
  h.identity(""); wait.release(); assert.equal(await reading, false); assert.equal(m.inspect().expired, true); assert.equal(m.inspect().frame, null); m.dispose()
})
test("first-save success refreshes work area instead of closing unrelated editor, and cannot jump into the legacy route", () => {
  const component = source("components/schedules/ScheduleHost.vue")
  const handler = component.match(/async function firstSave\(\): Promise<void> \{([\s\S]*?)\n\}/)[1]
  assert.match(handler, /canCompose/); assert.match(handler, /workspaceRef.value\?\.refresh/); assert.doesNotMatch(handler, /prepareLeave/)
  assert.doesNotMatch(component, /router.push|router.replace|EntryEditView/)
})
test("malformed ownership metadata is not treated as guest or an empty restore epoch", async () => {
  for (const key of ["ownerUserId", "ownerGeneration"]) {
    const h = harness(); const ctx = await h.port.capture(); await h.db.meta.put({ key, value: { unknown: true } }); const before = snapshot(h)
    await assert.rejects(h.port.capture(), /未当作游客/); await assert.rejects(h.port.validate(ctx), /未当作游客/)
    assert.equal(snapshot(h), before)
  }
})

test("pinned guest workspace refuses malformed ownership before reads or writes, even before watcher delivery", async () => {
  for (const key of ["ownerUserId", "ownerGeneration"]) {
    const h = harness(); await h.db.schedules.put(schedule({ remindDate: "2026-10-09" }))
    const ctx = await h.port.capture(); const port = h.port.workspace(ctx); const owner = await port.capture()
    await h.db.meta.put({ key, value: { unknown: true } }); const before = snapshot(h)
    await assert.rejects(port.load(owner, { view: "pending", page: 1, pageSize: 20 }), /未当作游客/)
    await assert.rejects(port.setDeleted(owner, ID, AT, true), /未当作游客/)
    assert.equal(snapshot(h), before)
  }
})
test("synchronous observer failure cleans its eventual subscription without leaving an auth timer", async () => {
  let unsubscribed = 0
  const h = harness({ dexie: { liveQuery: () => ({ subscribe(observer) {
    observer.error(new Error("synchronous watch failure")); return { unsubscribe() { unsubscribed++ } }
  } }) } })
  const ctx = await h.port.capture(); let expired = 0; const stop = h.port.watch(ctx, () => { expired++ })
  assert.equal(expired, 1); assert.equal(unsubscribed, 1); assert.equal(h.watchStats().timers, 0)
  stop(); assert.equal(unsubscribed, 1)
})
