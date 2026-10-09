const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, AT, content, schedule, terminal, entry, setup } = require("./schedules-data-harness.cjs")
const TODAY = "2026-10-08"
const query = extra => ({ view: "pending", page: 1, pageSize: 20, ...extra })
const due = extra => schedule({ remindDate: TODAY, ...extra })
const body = extra => ({ remindDate: "2026-10-09", title: "安全草稿", content: content("未正式保存"), ...extra })
const json = value => JSON.stringify(value)
const snapshot = h => json(Object.fromEntries(Object.entries(h.stores).map(([name, store]) => [name, [...store.rows.values()]])))
const journal = async h => (await h.db.meta.get("scheduleDraft"))?.value
const intentions = async h => (await h.db.meta.get("scheduleConversions"))?.value ?? []
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
function harness() {
  let today = TODAY
  const time = { ...loadTS("shared/time.ts"), utcNow: () => AT, todayLocal: () => today }
  const h = setup({ "./time": time, "@/shared/time": time })
  const port = h.load("db/scheduleWorkspaceRepo.ts").localScheduleWorkspaceRepo
  const factory = h.load("shared/scheduleWorkspace.ts").createScheduleWorkspace
  const model = (override = {}) => factory({ ...port, ...override }, () => today)
  return { ...h, port, model, today: value => { today = value },
    drafts: h.load("db/scheduleDraftRepo.ts").localScheduleDraftRepo,
    editors: h.load("db/scheduleEditorRepo.ts").localScheduleEditorRepo,
    schedules: h.load("db/scheduleRepo.ts").localScheduleRepo }
}
async function start(h) { const m = h.model(); assert.equal(await m.initialize(), true); return m }
function prompt(m, kind = "convert", id = ID) {
  const row = m.inspect().items.find(row => row.id === id)
  assert.ok(row)
  return m.requestAction(kind, id, kind === "convert" ? row.clientUpdatedAt : undefined, kind === "convert" ? row.remindDate : undefined)
}
async function bindDraft(h, extra = {}) {
  await h.db.schedules.put(schedule(extra)); const s = await h.editors.openExisting(ID)
  await s.persist(body({ remindDate: extra.remindDate ?? "2026-10-09" })); return s
}
const source = name => fs.readFileSync(path.join(__dirname, "../src", name), "utf8")

test("query validation rejects invalid filters, extra fields, pages and impossible dates without storage", () => {
  const parse = loadTS("shared/scheduleWorkspace.ts").parseWorkspaceQuery
  for (const q of [query({ view: "all" }), query({ page: 0 }), query({ page: NaN }), query({ pageSize: 101 }),
    query({ dateFrom: "" }), query({ dateTo: "2026-02-29" }), query({ dateFrom: "2026-10-10", dateTo: TODAY }), query({ owner: "B" })]) assert.throws(() => parse(q))
  const q = query({ dateFrom: TODAY }); const parsed = parse(q); q.page = 99; assert.equal(parsed.page, 1)
})
test("initialization is read-only and default list includes only active pending sources", async () => {
  const h = harness(); await h.db.schedules.put(due()); await h.db.schedules.put(terminal({ id: OTHER_ID, convertedEntryId: OTHER_ID }))
  const before = snapshot(h); const m = await start(h)
  assert.equal(m.inspect().items.length, 1); assert.equal(m.inspect().items[0].id, ID)
  assert.equal(m.inspect().recovery.status, "empty"); assert.equal(snapshot(h), before)
  assert.equal(await m.initialize(), false)
})
test("pending/converted/deleted and date filters are explicit, sorted and paged", async () => {
  const h = harness()
  for (let i = 1; i <= 5; i++) await h.db.schedules.put(schedule({ id: `019a0300-1234-7000-8000-${String(i).padStart(12, "0")}`, remindDate: `2026-10-${String(i + 7).padStart(2, "0")}` }))
  await h.db.schedules.put(terminal({ id: "019a0300-1234-7000-8000-000000000010", convertedEntryId: "019a0300-1234-7000-8000-000000000010" }))
  await h.db.schedules.put(schedule({ id: "019a0300-1234-7000-8000-000000000011", isDeleted: 1, deletedAt: AT }))
  const m = await start(h); await m.setQuery(query({ pageSize: 2, page: 2, dateFrom: TODAY, dateTo: "2026-10-11" }))
  assert.equal(m.inspect().total, 4); assert.equal(m.inspect().items[0].remindDate, "2026-10-10")
  await m.setQuery(query({ view: "converted" })); assert.equal(m.inspect().total, 1)
  await m.setQuery(query({ view: "deleted" })); assert.equal(m.inspect().total, 1); assert.equal(m.inspect().items[0].isDeleted, 1)
})
test("out-of-range page clamps in the same read snapshot, including an empty list", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const owner = await h.port.capture()
  const data = await h.port.load(owner, query({ page: 99, pageSize: 2 })); assert.equal(data.records.page, 1); assert.equal(data.records.items.length, 1)
  await h.db.schedules.delete(ID); const empty = await h.port.load(owner, query({ page: 99 })); assert.equal(empty.records.page, 1); assert.equal(empty.records.total, 0)
})
test("older delayed query response cannot replace a newer filter result", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); await h.db.schedules.put(terminal({ id: OTHER_ID, convertedEntryId: OTHER_ID }))
  const entered = gate(); const wait = gate(); let hold = false
  const m = h.model({ async load(...args) { const data = await h.port.load(...args); if (hold && args[1].view === "pending") { entered.release(); await wait.promise }; return data } })
  await m.initialize(); hold = true
  const old = m.setQuery(query({ view: "pending" })); await entered.promise
  assert.equal(await m.setQuery(query({ view: "converted" })), true); wait.release(); assert.equal(await old, false)
  assert.equal(m.inspect().query.view, "converted"); assert.equal(m.inspect().items[0].id, OTHER_ID)
})
test("older delayed query failure cannot overwrite a successful newer query", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const entered = gate(); const wait = gate(); let hold = false
  const m = h.model({ async load(...args) { if (hold && args[1].view === "pending") { entered.release(); await wait.promise; throw new Error("old failure") }; return h.port.load(...args) } })
  await m.initialize(); hold = true; const old = m.refresh(); await entered.promise
  await m.setQuery(query({ view: "deleted" })); wait.release(); await old
  assert.equal(m.inspect().error, ""); assert.equal(m.inspect().query.view, "deleted")
})
test("query validation failure does not adopt the invalid filter and refresh can recover", async () => {
  const h = harness(); const m = await start(h)
  assert.equal(await m.setQuery(query({ pageSize: 0 })), false); assert.equal(m.inspect().query.pageSize, 20)
  assert.notEqual(m.inspect().error, ""); await m.refresh(); assert.equal(m.inspect().error, "")
})
test("failed list read clears old rows and recovery rather than exposing stale discard controls", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body()); const m = await start(h)
  assert.ok(m.inspect().recovery.draft)
  await h.db.meta.put({ key: "scheduleDraft", value: { formatVersion: 99 } }); assert.equal(await m.refresh(), false)
  assert.equal(m.inspect().recovery, null); assert.equal(m.inspect().items.length, 0); assert.match(m.inspect().error, /损坏/)
})
for (const key of ["ownerUserId", "ownerGeneration"]) {
  test(`${key} change expires the captured workspace without adopting a new owner`, async () => {
    const h = harness(); await h.db.schedules.put(schedule()); const m = await start(h)
    await h.db.meta.put({ key, value: "changed" }); assert.equal(await m.refresh(), false)
    assert.equal(m.inspect().expired, true); assert.equal(m.inspect().items.length, 0); assert.equal(m.inspect().recovery, null)
    assert.equal(await m.openNew("2026-10-10"), false); assert.equal(await m.initialize(), false)
  })
  test(`late list response after ${key} change is rejected before installation`, async () => {
    const h = harness(); await h.db.schedules.put(schedule()); const entered = gate(); const wait = gate()
    const m = h.model({ async load(...args) { const data = await h.port.load(...args); entered.release(); await wait.promise; return data } })
    const job = m.initialize(); await entered.promise; await h.db.meta.put({ key, value: "changed" }); wait.release()
    assert.equal(await job, false); assert.equal(m.inspect().expired, true); assert.equal(m.inspect().items.length, 0)
  })
}
test("clock tick derives due/overdue without writes or automatic conversion", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const m = await start(h); const before = snapshot(h)
  h.today("2026-10-09"); m.tick(); assert.equal(m.inspect().today, "2026-10-09"); assert.equal(snapshot(h), before)
  h.today("2026-10-10"); m.tick(); assert.equal(m.inspect().today, "2026-10-10"); assert.equal(h.stores.entries.rows.size, 0)
})
test("new editor requires a future day, opening remains read-only, and the session key stays fixed through save", async () => {
  const h = harness(); const m = await start(h); assert.equal(await m.openNew(TODAY), false)
  assert.equal(await m.openNew("2026-10-09"), true); const key = m.inspect().editorKey
  const s = m.editorSession(); assert.equal(h.stores.meta.rows.size, 0); assert.equal(await m.editorFinished(), false)
  await s.submit(body()); await m.refresh(); assert.equal(m.inspect().editorKey, key)
  await s.flush(); s.close(); assert.equal(await m.editorFinished(), true)
  assert.equal(m.inspect().editing, false); assert.equal(m.inspect().total, 1)
})
test("opening an edit pins the listed source revision and refuses a newer external edit", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const m = await start(h)
  await h.schedules.update(ID, { title: "其他修改" }); assert.equal(await m.edit(ID), false)
  assert.match(m.inspect().error, /已变化/); assert.equal(m.editorSession(), null)
  await m.refresh(); assert.equal(await m.edit(ID), true)
})
test("occupied draft requires explicit resume and cannot be replaced by another new editor", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body()); const m = await start(h)
  assert.equal(await m.openNew("2026-10-10"), false); assert.equal(await m.resume(), true)
  assert.equal(m.editorSession().inspect().draft.title, "安全草稿")
})
test("resume and discard both refuse stale recovery leases after another writer changes text", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body()); const m = await start(h)
  await s.persist(body({ title: "另一编辑" })); assert.equal(await m.resume(), false)
  assert.equal(await m.discardRecoveryConfirmed(), false); assert.equal((await journal(h)).draft.title, "另一编辑")
  await m.refresh(); assert.equal(await m.discardRecoveryConfirmed(), true); assert.equal((await journal(h)).draft, null)
})
test("uninstalled late editor result is closed if context validation fails", async () => {
  const h = harness(); const entered = gate(); const wait = gate(); let returned
  const m = h.model({ async open(...args) { returned = await h.port.open(...args); entered.release(); await wait.promise; return returned } })
  await m.initialize(); const opening = m.openNew("2026-10-09"); await entered.promise
  await h.db.meta.put({ key: "ownerGeneration", value: "restored" }); wait.release()
  assert.equal(await opening, false); assert.equal(returned.inspect().closed, true); assert.equal(m.editorSession(), null)
})
test("explicit invalidation stops reads and closes mounted editor without clearing persisted text", async () => {
  const h = harness(); const m = await start(h); await m.openNew("2026-10-09"); const s = m.editorSession(); await s.persist(body())
  m.invalidate(); assert.equal(s.inspect().closed, true); assert.equal(m.inspect().editing, false)
  assert.ok((await journal(h)).draft); assert.equal(await m.resume(), false)
})
test("soft-delete confirmation pins revision, retains linked draft, and restore does not reset a terminal identity", async () => {
  const h = harness(); await bindDraft(h); const m = await start(h); assert.equal(prompt(m, "remove"), true)
  assert.equal(await m.confirm(), true); assert.equal((await h.db.schedules.get(ID)).isDeleted, 1); assert.ok((await journal(h)).draft)
  await m.setQuery(query({ view: "deleted" })); assert.equal(prompt(m, "restore"), true); await m.confirm()
  assert.equal((await h.db.schedules.get(ID)).isDeleted, 0)
  await h.db.schedules.put(terminal({ isDeleted: 1, deletedAt: AT })); await m.refresh(); prompt(m, "restore"); await m.confirm()
  const row = await h.db.schedules.get(ID); assert.equal(row.status, "converted"); assert.equal(row.convertedEntryId, ID)
})
test("source change after opening delete prompt is not adopted by refresh or confirmation", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const m = await start(h); prompt(m, "remove")
  await h.schedules.update(ID, { title: "新来源" }); await m.refresh(); assert.equal(await m.confirm(), false)
  assert.equal((await h.db.schedules.get(ID)).isDeleted, 0); assert.match(m.inspect().error, /已变化/)
})
test("delete storage failure rolls back and preserves source revision", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const m = await start(h); prompt(m, "remove"); const before = snapshot(h)
  h.failNext("schedules"); assert.equal(await m.confirm(), false); assert.equal(snapshot(h), before)
})
test("cancelling a prompt performs no writes and future/deleted/terminal sources cannot request conversion", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); const before = snapshot(h)
  prompt(m); m.cancelPrompt(); assert.equal(snapshot(h), before)
  await h.db.schedules.put(schedule()); await m.refresh(); assert.equal(prompt(m), false)
  await h.db.schedules.put(terminal()); await m.setQuery(query({ view: "converted" })); assert.equal(prompt(m), false)
  await h.db.schedules.put(due({ isDeleted: 1, deletedAt: AT })); await m.setQuery(query({ view: "deleted" })); assert.equal(prompt(m), false)
})
test("list conversion request must exactly match listed ID, revision and original date", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h)
  assert.equal(m.requestAction("convert", ID, "2026-10-08T11:00:00.000Z", TODAY), false)
  assert.equal(m.requestAction("convert", ID, AT, "2026-10-07"), false)
  assert.equal(m.requestAction("convert", OTHER_ID, AT, TODAY), false); assert.equal(h.stores.entries.rows.size, 0)
})
test("due conversion requires explicit confirmation and defaults to original natural date", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); assert.equal(prompt(m), true)
  assert.equal(h.stores.entries.rows.size, 0); assert.equal(await m.confirm(), true)
  const result = m.inspect().result; assert.equal(result.entryDate, TODAY); assert.equal(result.pendingConfirmation, true)
  assert.equal(result.canOpen, true); assert.equal(result.entryId, ID); assert.equal((await intentions(h)).length, 1)
  assert.equal(m.inspect().total, 0)
})
test("overdue conversion supports explicit elapsed target; future/invalid dates write nothing", async () => {
  const h = harness(); await h.db.schedules.put(due({ remindDate: "2026-10-01" })); const m = await start(h); prompt(m); const before = snapshot(h)
  for (const date of ["", "2026-02-29", "2026-10-09"]) { assert.equal(await m.confirm(date), false); assert.equal(snapshot(h), before) }
  assert.equal(await m.confirm("2026-10-06"), true); assert.equal((await h.db.entries.get(ID)).entryDate, "2026-10-06")
})
test("due source cannot select another date and overdue default still preserves original date", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m)
  assert.equal(await m.confirm("2026-10-07"), false); assert.equal(h.stores.entries.rows.size, 0)
  h.today("2026-10-10"); assert.equal(await m.confirm(), true); assert.equal((await h.db.entries.get(ID)).entryDate, TODAY)
})
test("source edit after opening conversion prompt refuses stale revision and leaves all tables unchanged", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m)
  await h.schedules.update(ID, { title: "改后正文", remindDate: "2026-10-07" }); const before = snapshot(h)
  assert.equal(await m.confirm(), false); assert.equal(snapshot(h), before); assert.equal(h.stores.entries.rows.size, 0)
})
test("same-source safe draft, including one written after the modal opens, blocks conversion without consuming text", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m)
  const s = await h.editors.openExisting(ID); await s.persist(body({ remindDate: TODAY })); const before = snapshot(h)
  assert.equal(await m.confirm(), false); assert.equal(snapshot(h), before); assert.match(m.inspect().error, /安全草稿/)
})
test("a draft belonging to a different resource does not prevent explicit conversion of a saved source", async () => {
  const h = harness(); await h.db.schedules.put(due()); const s = await h.editors.openNew("2026-10-09"); await s.persist(body())
  const m = await start(h); prompt(m); assert.equal(await m.confirm(), true); assert.ok((await journal(h)).draft)
})
test("double confirmation is single flight, and explicit idempotent replay never constructs a second entry", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m)
  const first = m.confirm(); assert.equal(await m.confirm(), false); assert.equal(await first, true)
  const owner = await h.port.capture(); const repeated = await h.port.convert(owner, ID, AT)
  assert.equal(repeated.created, false); assert.equal(h.stores.entries.rows.size, 1); assert.equal((await intentions(h)).length, 1)
})
for (const table of ["entries", "schedules", "meta"]) test(`conversion ${table} failure rolls back source, entry and first intent`, async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m); const before = snapshot(h)
  h.failNext(table); assert.equal(await m.confirm(), false); assert.equal(snapshot(h), before); assert.equal(h.stores.entries.rows.size, 0)
})
for (const key of ["ownerUserId", "ownerGeneration"]) test(`conversion prompt captured before ${key} change cannot write under the new context`, async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m)
  await h.db.meta.put({ key, value: "changed" }); const before = snapshot(h)
  assert.equal(await m.confirm(), false); assert.equal(snapshot(h), before); assert.equal(m.inspect().expired, true)
})
test("conversion committed before a later restore epoch cannot install a stale result into the new workspace", async () => {
  const h = harness(); await h.db.schedules.put(due()); const entered = gate(); const wait = gate()
  const m = h.model({ async convert(...args) { const result = await h.port.convert(...args); entered.release(); await wait.promise; return result } })
  await m.initialize(); prompt(m); const saving = m.confirm(); await entered.promise
  await h.db.meta.put({ key: "ownerGeneration", value: "restored" }); wait.release()
  assert.equal(await saving, false); assert.equal(m.inspect().result, null); assert.equal(m.inspect().expired, true)
  assert.equal(h.stores.entries.rows.size, 1) // 先前合法事务已提交，不宣称后来invalidate撤销它。
})
test("inspection of a pending source never creates an entry or intent", async () => {
  const h = harness(); await h.db.schedules.put(due()); const owner = await h.port.capture(); const before = snapshot(h)
  await assert.rejects(h.port.inspectConversion(owner, ID), /尚未转简/); assert.equal(snapshot(h), before)
})
test("terminal inspection returns currently edited diary, not immutable first snapshot", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m); await m.confirm()
  const first = json((await intentions(h))[0]); await h.db.entries.update(ID, { title: "后来编辑", content: content("当前正文") })
  await m.setQuery(query({ view: "converted" })); const before = snapshot(h); assert.equal(await m.inspectConversion(ID), true)
  assert.equal(m.inspect().result.entryTitle, "后来编辑"); assert.equal(await m.openResultEntry(), ID)
  assert.equal(snapshot(h), before); assert.equal(json((await intentions(h))[0]), first)
})
for (const [label, modify] of [
  ["deleted", h => h.db.entries.update(ID, { isDeleted: 1, deletedAt: AT })],
  ["purged", h => h.db.entries.delete(ID)],
  ["pending purge", h => h.db.meta.put({ key: "pendingPurges", value: [ID] })],
]) test(`${label} diary is not openable or recreated after a stale active result`, async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m); await m.confirm(); const first = json((await intentions(h))[0])
  await modify(h); assert.equal(await m.openResultEntry(), null)
  assert.equal(m.inspect().result.entryState, label === "deleted" ? "deleted" : "purged")
  assert.equal(json((await intentions(h))[0]), first); assert.equal((await h.db.schedules.get(ID)).status, "converted")
})
test("too-new active diary is reported without opening an incompatible editor", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m); await m.confirm()
  await h.db.entries.update(ID, { content: { schemaVersion: 9, doc: { type: "doc", content: [] } } })
  assert.equal(await m.openResultEntry(), null); assert.equal(m.inspect().result.entryState, "active"); assert.equal(m.inspect().result.canOpen, false)
})
test("malformed conversion relation or queue causes inspection failure, not repair or regeneration", async () => {
  const h = harness(); await h.db.schedules.put(terminal()); await h.db.entries.put(entry({ fromScheduleId: null }))
  const owner = await h.port.capture(); const before = snapshot(h)
  await assert.rejects(h.port.inspectConversion(owner, ID), /主键冲突/); assert.equal(snapshot(h), before)
  await h.db.entries.update(ID, { fromScheduleId: ID }); await h.db.meta.put({ key: "scheduleConversions", value: {} })
  const corrupt = snapshot(h); await assert.rejects(h.port.inspectConversion(owner, ID), /队列损坏/); assert.equal(snapshot(h), corrupt)
})
test("confirmed terminal receipt changes result text but does not clear or regenerate business records", async () => {
  const h = harness(); await h.db.schedules.put(terminal({ dirty: 0, serverUpdatedAt: AT })); await h.db.entries.put(entry())
  const m = await start(h); const before = snapshot(h); assert.equal(await m.inspectConversion(ID), true)
  assert.equal(m.inspect().result.pendingConfirmation, false); assert.equal(snapshot(h), before)
})
test("guarded port copies caller owner and query before awaiting storage", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const owner = await h.port.capture(); const q = query()
  const reading = h.port.load(owner, q); owner.ownerUserId = "mutated"; q.view = "deleted"
  const result = await reading; assert.equal(result.records.items.length, 1)
})
test("operations during editor or prompt do not switch filters or bypass safe return", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m)
  assert.equal(await m.setQuery(query({ view: "converted" })), false); assert.equal(await m.openNew("2026-10-09"), false)
  m.cancelPrompt(); await m.openNew("2026-10-09"); assert.equal(m.canLeave(), false); assert.equal(m.requestAction("remove", ID), false)
  assert.equal(await m.editorFinished(), false)
})
test("disposal rejects uninstalled delayed reads and observers can unsubscribe", async () => {
  const h = harness(); const entered = gate(); const wait = gate()
  const m = h.model({ async load(...args) { const data = await h.port.load(...args); entered.release(); await wait.promise; return data } })
  let count = 0; const unsub = m.subscribe(() => { count++ }); const reading = m.initialize(); await entered.promise
  unsub(); m.dispose(); const before = count; wait.release(); assert.equal(await reading, false); assert.equal(count, before)
  assert.equal(m.inspect().items.length, 0)
})
test("work area writes leave P2 metadata, ordinary diary draft, schema and backup formats unchanged", async () => {
  const h = harness(); for (const key of ["draft", "lastSyncAt", "conflicts", "pendingPurges"]) await h.db.meta.put({ key, value: key === "pendingPurges" ? [] : { unchanged: key } })
  const before = [...h.stores.meta.rows.values()]; await h.db.schedules.put(due()); const m = await start(h); prompt(m); await m.confirm()
  for (const row of before) assert.equal(json(await h.db.meta.get(row.key)), json(row))
  assert.equal(h.stores.media.rows.size, 0)
})
test("workspace component explicitly injects a port/context key, guards leave and never navigates on conversion automatically", () => {
  const component = source("components/schedules/ScheduleWorkspace.vue")
  assert.match(component, /port: ScheduleWorkspacePort; contextKey: string/); assert.match(component, /flush: "sync"/)
  assert.match(component, /editorRef\.value\.prepareLeave/); assert.match(component, /defineExpose\(\{ prepareLeave \}\)/)
  assert.match(component, /workspace\.openResultEntry/); assert.match(component, /value="original"/); assert.match(component, /:max="state.today"/)
  assert.doesNotMatch(component, /@\/repo|scheduleWorkspaceRepo|useRouter|router\.|syncNow|beforeunload/)
})
test("natural-day timer only calls tick; real conversion is a confirmed version-pinned action", () => {
  const component = source("components/schedules/ScheduleWorkspace.vue")
  assert.match(component, /setInterval\(\(\) => workspace.tick\(\), 60_000\)/)
  assert.match(component, /expectedClientUpdatedAt, request.remindDate/)
  const facade = source("db/scheduleWorkspaceRepo.ts"); assert.match(facade, /db.schedules, db.entries, db.meta/)
  assert.match(facade, /current.draft\?\.scheduleId === id/)
})
test("hidden workspace is not reachable from public repo, router, app or placeholder", () => {
  assert.doesNotMatch(source("repo/index.ts"), /scheduleWorkspaceRepo|scheduleRepo|scheduleDraftRepo|scheduleEditorRepo/)
  for (const p of ["App.vue", "router/index.ts", "views/ScheduleView.vue"]) assert.doesNotMatch(source(p), /ScheduleWorkspace|scheduleWorkspaceRepo/)
  assert.match(source("App.vue"), /aria-disabled="true".*预简/)
})
test("UI text schema matches diary heading/horizontal-rule boundary without changing stored backup rules", () => {
  const helpers = loadTS("shared/scheduleEditorContent.ts")
  const rules = loadTS("shared/schedules.ts")
  for (const node of [{ type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "标题" }] }, { type: "horizontalRule" }]) {
    const value = { schemaVersion: 1, doc: { type: "doc", content: [node] } }
    assert.doesNotThrow(() => rules.assertScheduleContent(value))
    assert.throws(() => helpers.assertScheduleEditorContent(value))
    assert.equal(helpers.canOpenScheduleDiaryContent(value), false)
  }
  assert.match(source("editor/scheduleSchema.ts"), /horizontalRule: false/)
})
test("incompatible stored schedule cannot be edited or converted through the workspace and remains unchanged", async () => {
  const h = harness(); const incompatible = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "保留" }] }] } }
  await h.db.schedules.put(due({ content: incompatible })); const m = await start(h); const before = snapshot(h)
  assert.equal(await m.edit(ID), false); prompt(m); assert.equal(await m.confirm(), false)
  assert.equal(snapshot(h), before); assert.equal(h.stores.entries.rows.size, 0)
})
test("actual diary image nodes remain openable after conversion, but corrupt/unknown trees do not", () => {
  const { canOpenScheduleDiaryContent: compatible } = loadTS("shared/scheduleEditorContent.ts")
  const image = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { mediaId: "image-1" } }] } }
  assert.equal(compatible(image), true); assert.equal(compatible(null), true)
  for (const doc of [{ type: "doc", content: {} }, { type: "doc", content: [{ type: "unknown" }] },
    { type: "doc", content: [{ type: "text" }] }, { type: "doc", content: [{ type: "text", text: "a", marks: [{ type: "unknown" }] }] }]) {
    assert.equal(compatible({ schemaVersion: 1, doc }), false)
  }
  const cyclic = { type: "doc", content: [] }; cyclic.content.push(cyclic)
  assert.equal(compatible({ schemaVersion: 1, doc: cyclic }), false)
})
test("corrupt actual Entry JSON is reported without navigating into an editor that could drop it", async () => {
  const h = harness(); await h.db.schedules.put(due()); const m = await start(h); prompt(m); await m.confirm()
  await h.db.entries.update(ID, { content: { schemaVersion: 1, doc: { type: "doc", content: {} } } })
  const before = snapshot(h); assert.equal(await m.openResultEntry(), null); assert.equal(snapshot(h), before)
  assert.equal(m.inspect().result.canOpen, false)
})
test("invalid heading attrs and nested leaf text fail closed, while ordinary headings keep current diary compatibility", () => {
  const helpers = loadTS("shared/scheduleEditorContent.ts")
  for (const node of [{ type: "heading", attrs: { level: true } }, { type: "heading", attrs: { level: "2" } },
    { type: "paragraph", attrs: "bad" }, { type: "text", text: "a", content: [{ type: "text", text: "b" }] }]) {
    assert.equal(helpers.canOpenScheduleDiaryContent({ schemaVersion: 1, doc: { type: "doc", content: [node] } }), false)
  }
  for (const level of [1, 2, 3]) assert.doesNotThrow(() => helpers.assertScheduleEditorContent({ schemaVersion: 1,
    doc: { type: "doc", content: [{ type: "heading", attrs: { level }, content: [{ type: "text", text: "标题" }] }] } }))
})
test("invalid and foreign recovery leases, IDs or revisions cannot reach workspace writes", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body()); const owner = await h.port.capture(); const current = await h.drafts.read(); const before = snapshot(h)
  await assert.rejects(h.port.discard(owner, { ...current.lease, ownerUserId: "foreign" }), /不属于/)
  await assert.rejects(h.port.setDeleted(owner, "bad", AT, true))
  await assert.rejects(h.port.setDeleted(owner, ID, "bad", true))
  await assert.rejects(h.port.convert(owner, ID, "bad"))
  assert.equal(snapshot(h), before)
})
test("incompatible recovered draft can return read-only without writes or being forced to discard", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09")
  const incompatible = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "horizontalRule" }] } }
  await s.persist(body({ content: incompatible })); const m = await start(h); assert.equal(await m.resume(), true)
  const panel = h.load("shared/scheduleEditorPanel.ts").createScheduleEditorPanel(m.editorSession())
  const before = snapshot(h); assert.equal(await panel.prepareLeave(), true); assert.equal(await m.editorFinished(), true)
  assert.equal(snapshot(h), before); assert.ok((await journal(h)).draft)
})
test("editor panel initial compatibility failure locks fields but permits guarded read-only return", () => {
  const panel = source("components/schedules/ScheduleEditorPanel.vue")
  assert.match(panel, /assertScheduleEditorContent\(initialContent\)/)
  assert.match(panel, /actionLocked\.value \|\| readOnlyContent/)
  assert.match(panel, /readOnlyContent \|\| !editorError\.value/)
  assert.match(panel, /:disabled="actionLocked" @click="leave"/)
})
test("a stale query's current owner check still expires context even after a newer successful filter", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const entered = gate(); const wait = gate(); let hold = false
  const m = h.model({ async load(...args) { const data = await h.port.load(...args); if (hold && args[1].view === "pending") { entered.release(); await wait.promise }; return data } })
  await m.initialize(); hold = true; const old = m.refresh(); await entered.promise
  await m.setQuery(query({ view: "converted" })); await h.db.meta.put({ key: "ownerGeneration", value: "restored" }); wait.release()
  await old; assert.equal(m.inspect().expired, true); assert.equal(m.inspect().items.length, 0)
})
