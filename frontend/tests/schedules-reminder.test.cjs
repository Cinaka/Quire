const { test } = require("node:test"), assert = require("node:assert/strict")
const fs = require("node:fs"), path = require("node:path"), { execFileSync } = require("node:child_process")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, schedule, terminal, setup } = require("./schedules-data-harness.cjs")
const TODAY = "2026-10-10", id = n => `019a0300-1234-7000-8000-${String(n).padStart(12, "0")}`
const row = (n, day, extra = {}) => schedule({ id: id(n), remindDate: day, ...extra })
const summary = (day = TODAY, dueToday = 1, overdue = 2) => ({ asOf: day, dueToday, overdue, dueTotal: dueToday + overdue })
const api = () => loadTS("shared/scheduleReminder.ts")
const json = value => JSON.stringify(value)
const snapshot = h => json(Object.fromEntries(Object.entries(h.stores).map(([key, store]) => [key, [...store.rows.values()]])))
const gate = () => { let release; const promise = new Promise(r => { release = r }); return { promise, release } }
const clockAt = day => new Date(`${day}T12:00:00`)

test("derived reminder counts include all local due/overdue sources, not future/converted/deleted", () => {
  const rows = [row(1, TODAY), row(2, "2026-10-09"), row(3, "2026-10-11"), terminal({ id: id(4), convertedEntryId: id(4), remindDate: TODAY }),
    row(5, TODAY, { isDeleted: 1, deletedAt: "2026-10-09T00:00:00.000Z" })]
  const before = json(rows), result = api().summarizeScheduleReminders(rows, TODAY)
  assert.deepEqual(JSON.parse(json(result)), summary(TODAY, 1, 1)); assert.equal(json(rows), before)
  assert.deepEqual(Object.keys(result).sort(), ["asOf", "dueToday", "dueTotal", "overdue"])
})
test("counts cover more than one list page and preserve dirty/revisions", () => {
  const rows = Array.from({ length: 235 }, (_, i) => row(i + 1, i % 2 ? TODAY : "2026-10-09")), before = json(rows)
  const result = api().summarizeScheduleReminders(rows, TODAY)
  assert.equal(result.dueTotal, 235); assert.equal(result.dueToday, 117); assert.equal(result.overdue, 118); assert.equal(json(rows), before)
})
for (const day of ["2028-02-29", "2026-12-31", "2027-01-01"]) test(`valid natural date ${day} without writes`, () => {
  assert.equal(api().summarizeScheduleReminders([row(1, day)], day).dueToday, 1)
})
for (const change of [{ remindDate: "2026-02-29" }, { status: "bad" }, { isDeleted: 4 }, { id: "bad" }, { dirty: 4 }, { convertedEntryId: OTHER_ID }, { content: { schemaVersion: 1, doc: { type: "image" } } }])
  test(`invalid source ${Object.keys(change)[0]} cannot become a false zero`, () => assert.throws(() => api().summarizeScheduleReminders([row(1, TODAY, change)], TODAY)))
for (const day of ["", "2026-02-29", "2026/10/10"]) test(`invalid reminder reference day ${day} refused`, () => assert.throws(() => api().summarizeScheduleReminders([], day)))
test("duplicate identities refuse partial counts", () => assert.throws(() => api().summarizeScheduleReminders([row(1, TODAY), row(1, TODAY)], TODAY)))
test("no sources is a confirmed local zero, not a loading/error state", () => assert.equal(api().summarizeScheduleReminders([], TODAY).dueTotal, 0))

test("controller construction is inert; refresh publishes a detached count-only summary", async () => {
  let reads = 0; const raw = summary(), model = api().createScheduleReminder({ read: async day => { reads++; assert.equal(day, TODAY); return raw } }, () => clockAt(TODAY))
  assert.equal(reads, 0); assert.equal(model.inspect().status, "idle"); await model.refresh()
  assert.equal(model.inspect().status, "ready"); raw.dueTotal = 99
  assert.equal(model.inspect().summary.dueTotal, 3); const inspected = model.inspect(); inspected.summary.dueToday = 88
  assert.equal(model.inspect().summary.dueToday, 1)
})
test("concurrent refreshes share one flight and coalesce a changed source signal", async () => {
  const waiting = gate(); let reads = 0
  const model = api().createScheduleReminder({ read: async () => { reads++; if (reads === 1) await waiting.promise; return summary(TODAY, reads, 0) } }, () => clockAt(TODAY))
  const first = model.refresh(); await Promise.resolve(); const second = model.refresh(); assert.equal(first, second)
  waiting.release(); await first; assert.equal(reads, 2); assert.equal(model.inspect().summary.dueToday, 2)
})
test("cross-midnight response is discarded and reread for the new local day", async () => {
  const waiting = gate(); let day = TODAY; const calls = []
  const model = api().createScheduleReminder({ read: async date => { calls.push(date); if (calls.length === 1) await waiting.promise; return summary(date, 1, 0) } }, () => clockAt(day))
  const pending = model.refresh(); await Promise.resolve(); day = "2026-10-11"; waiting.release(); await pending
  assert.equal(calls.join(","), "2026-10-10,2026-10-11"); assert.equal(model.inspect().summary.asOf, day)
})
for (const mode of ["error", "expired", "disposed"]) test(`${mode} never publishes stale counts or private error text`, async () => {
  const waiting = gate(); let reads = 0, fail = false
  const model = api().createScheduleReminder({ read: async () => { reads++; if (reads > 1) await waiting.promise; if (fail) throw Error("private diary/token"); return summary() } }, () => clockAt(TODAY))
  await model.refresh(); const pending = model.refresh(); await Promise.resolve()
  if (mode === "error") fail = true; if (mode === "expired") model.invalidate(); if (mode === "disposed") model.dispose()
  waiting.release(); await pending; assert.equal(model.inspect().status, mode); assert.equal(model.inspect().summary, null)
  assert.equal(json(model.inspect()).includes("private"), false)
  if (mode !== "error") { await model.refresh(); assert.equal(reads, 2) }
})
test("transient read failure can be explicitly retried, context expiry cannot", async () => {
  let attempts = 0
  const port = { read: async () => { attempts++; if (attempts === 1) throw Error("read failed"); return summary() } }
  const model = api().createScheduleReminder(port, () => clockAt(TODAY)); await model.refresh(); assert.equal(model.inspect().status, "error")
  await model.refresh(); assert.equal(model.inspect().status, "ready")
  port.read = async () => { throw { code: "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED", message: "private" } }
  await model.refresh(); assert.equal(model.inspect().status, "expired"); const before = attempts; await model.refresh(); assert.equal(attempts, before)
})
for (const raw of [null, {}, [], { ...summary(), extra: "private" }, summary(TODAY, -1, 2), { ...summary(), dueTotal: 4 }, summary("2026-10-09"), { ...summary(), dueToday: 1.5 }, { ...summary(), dueTotal: NaN }])
  test(`invalid summary ${json(raw)} fails closed`, async () => {
    const model = api().createScheduleReminder({ read: async () => raw }, () => clockAt(TODAY)); await model.refresh()
    assert.equal(model.inspect().status, "error"); assert.equal(model.inspect().summary, null)
  })
test("invalid clock fails before reading and observers cannot corrupt read results", async () => {
  let reads = 0
  const invalid = api().createScheduleReminder({ read: async () => { reads++; return summary() } }, () => new Date(NaN))
  await invalid.refresh(); assert.equal(reads, 0); assert.equal(invalid.inspect().status, "error")
  const model = api().createScheduleReminder({ read: async () => summary() }, () => clockAt(TODAY))
  let events = 0; const stop = model.subscribe(() => { events++; throw Error("observer") }); await model.refresh()
  assert.equal(model.inspect().status, "ready"); assert.equal(events, 2); stop(); await model.refresh(); assert.equal(events, 2)
})

function readerFixture() {
  let next, revoked, ownerContext, stoppedOwner = 0, stoppedRows = 0, query
  const h = setup({ dexie: { liveQuery: fn => { query = fn; return { subscribe(observer) { next = observer.next; return { unsubscribe() { stoppedRows++ } } } } } },
    "./scheduleHostRepo": { localScheduleHostRepo: { watch(context, expire) { ownerContext = context; revoked = expire; return () => { stoppedOwner++ } } } } })
  h.mocks["@/api/tokenStore"] = h.tokens
  const reader = h.load("db/scheduleReminderRepo.ts").createLocalScheduleReminderPort()
  return { ...h, reader, next: () => next(), revoke: () => revoked(), query: () => query(), stats: () => ({ stoppedOwner, stoppedRows, ownerContext }) }
}
test("local reader reads all sources transactionally without touching any table", async () => {
  const h = readerFixture(); await h.db.meta.put({ key: "ownerUserId", value: "account-a" }); await h.db.meta.put({ key: "ownerGeneration", value: "epoch" })
  await h.db.schedules.put(schedule({ remindDate: TODAY })); const before = snapshot(h)
  assert.equal((await h.reader.read(TODAY)).dueTotal, 1); assert.equal(snapshot(h), before)
})
for (const mode of ["login", "logout", "epoch", "owner", "same-owner-restore"]) test(`pinned reader refuses ${mode} change without taking over`, async () => {
  const h = readerFixture(); await h.db.meta.put({ key: "ownerUserId", value: "account-a" }); await h.db.meta.put({ key: "ownerGeneration", value: "epoch" })
  await h.db.schedules.put(schedule({ remindDate: TODAY })); await h.reader.read(TODAY)
  if (mode === "login") h.user("account-b"); if (mode === "logout") h.user("")
  if (mode === "epoch" || mode === "same-owner-restore") await h.db.meta.put({ key: "ownerGeneration", value: "next-epoch" })
  if (mode === "owner") await h.db.meta.put({ key: "ownerUserId", value: "account-b" })
  const before = snapshot(h); await assert.rejects(h.reader.read(TODAY)); assert.equal(snapshot(h), before)
})
test("auth changed while reading cannot return another context's count", async () => {
  const h = readerFixture(), original = h.db.schedules.toArray
  h.db.schedules.toArray = async () => { const rows = await original(); h.user("account-b"); return rows }
  await assert.rejects(h.reader.read(TODAY))
})
test("watch is only available after context capture; disposal removes both watchers", async () => {
  const h = readerFixture(); assert.throws(() => h.reader.watch(() => {}, () => {})); await h.reader.read(TODAY)
  let events = 0, expired = 0; const stop = h.reader.watch(() => events++, () => expired++)
  assert.ok(Array.isArray(await h.query())); h.next(); assert.equal(events, 1); h.revoke(); assert.equal(expired, 1)
  h.next(); h.revoke(); stop(); assert.equal(events, 1); assert.equal(expired, 1)
  assert.equal(h.stats().stoppedOwner, 1); assert.equal(h.stats().stoppedRows, 1)
})
test("guest and logged-out retained local data remain local-only and do not claim an owner", async () => {
  const h = readerFixture(); h.user(""); await h.db.schedules.put(schedule({ remindDate: TODAY })); const before = snapshot(h)
  assert.equal((await h.reader.read(TODAY)).dueTotal, 1); assert.equal(snapshot(h), before)
})
for (const [zone, instant, expected] of [["Asia/Shanghai", "2026-10-09T16:30:00Z", "2026-10-10"], ["America/New_York", "2026-10-10T00:30:00Z", "2026-10-09"], ["America/New_York", "2026-03-08T07:01:00Z", "2026-03-08"]])
  test(`reminder uses ${zone} local calendar at ${instant}`, () => {
    const script = `const {loadTS}=require('./frontend/tests/schedules-harness.cjs');let day;const m=loadTS('shared/scheduleReminder.ts').createScheduleReminder({read:async d=>{day=d;return {asOf:d,dueToday:0,overdue:0,dueTotal:0}}},()=>new Date('${instant}'));m.refresh().then(()=>process.stdout.write(day))`
    assert.equal(execFileSync(process.execPath, ["-e", script], { cwd: path.join(__dirname, "../.."), env: { ...process.env, TZ: zone }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), expected)
  })
test("panel refresh/cleanup is wired only in existing isolated guest acceptance, not formal routes", () => {
  const read = p => fs.readFileSync(path.join(__dirname, "../src", p), "utf8"), panel = read("components/schedules/ScheduleReminderPanel.vue")
  for (const text of ["visibilitychange", '"focus"', "60_000", "clearInterval", "removeEventListener", "controller.dispose()", "controller.invalidate()", "props.port.watch", "不是云端全部数据", "关闭浏览器后不保证提醒"]) assert.ok(panel.includes(text))
  const page = read("acceptance/AcceptancePage.vue"); assert.ok(page.includes("ScheduleReminderPanel")); assert.ok(page.includes("createLocalScheduleReminderPort")); assert.ok(page.includes("workspaceArea.value?.focus()"))
  for (const file of ["router/index.ts", "views/ScheduleView.vue", "api/sync.ts"]) assert.equal(read(file).includes("ScheduleReminder"), false)
  const repo = read("db/scheduleReminderRepo.ts"); assert.ok(repo.includes('db.transaction("r", db.schedules, db.meta')); assert.equal(repo.includes(".put("), false)
})
