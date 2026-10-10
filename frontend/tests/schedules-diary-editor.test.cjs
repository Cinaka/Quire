const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, AT, content, entry, terminal, intent, setup } = require("./schedules-data-harness.cjs")
const create = loadTS("shared/scheduleDiaryEditor.ts").createScheduleDiaryEditor
const copy = value => structuredClone(value)
const LATER = "2026-10-08T10:00:00.001Z"
const TODAY = "2026-10-08"
function target(extra = {}) { const value = entry({ entryDate: TODAY, ...extra }); return { entry: value, lease: { id: ID, fromScheduleId: value.fromScheduleId, clientUpdatedAt: value.clientUpdatedAt } } }
function gate() { let release; const promise = new Promise(resolve => { release = resolve }); return { promise, release } }
function harness(initial = target()) {
  let stored = copy(initial); let validations = 0; let writes = 0; let error = null; const patches = []
  const port = { async validate() { validations++; if (error) throw error }, async save(lease, patch) {
    writes++; patches.push(copy(patch)); assert.deepEqual(copy(lease), stored.lease)
    stored = { entry: { ...stored.entry, ...copy(patch), clientUpdatedAt: LATER }, lease: { ...stored.lease, clientUpdatedAt: LATER } }; return copy(stored)
  } }
  return { port, session: create(initial, port, () => TODAY), stats: () => ({ validations, writes, patches }), stored: () => copy(stored), fail: value => { error = value } }
}
const expired = () => Object.assign(new Error("context expired"), { code: "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED" })

test("constructing/reading/changing a protected diary session writes neither business rows nor a safety draft", () => {
  const h = harness(); const original = h.stored(); assert.equal(h.session.inspect().dirty, false)
  assert.equal(h.session.change({ title: "仅内存" }), true); assert.equal(h.session.inspect().dirty, true)
  assert.deepEqual(h.stored(), original); assert.equal(h.stats().writes, 0); assert.match(h.session.inspect().notice, /尚未存/)
})
test("initial target and input are copied; inspected views cannot alter the fixed lease or pending content", () => {
  const initial = target(); const h = harness(initial); initial.entry.title = "external"; initial.lease.id = OTHER_ID
  const patch = { tagIds: ["a"], content: content("pending") }; h.session.change(patch); patch.tagIds.push("b"); patch.content.doc.content.length = 0
  const state = h.session.inspect(); state.body.tagIds.push("c"); assert.deepEqual(h.session.inspect().body.tagIds, ["a"])
  assert.equal(h.session.inspect().body.title, "日记")
})
test("save uses only changed fields and installs a strictly newer receipt, then accepts edits through that receipt", async () => {
  const h = harness(); h.session.change({ title: "改题" }); assert.equal(await h.session.save(), true)
  assert.deepEqual(h.stats().patches, [{ title: "改题" }]); assert.equal(h.session.inspect().dirty, false)
  h.port.save = async (lease, patch) => { assert.equal(lease.clientUpdatedAt, LATER); return target({ ...patch, title: "改题", clientUpdatedAt: "2026-10-08T10:00:00.002Z" }) }
  h.session.change({ weather: "晴" }); assert.equal(await h.session.save(), true)
})
test("unchanged save performs context validation but no revision churn or cloud claim", async () => {
  const h = harness(); assert.equal(await h.session.save(), true); assert.equal(h.stats().writes, 0); assert.equal(h.stats().validations, 1)
  assert.match(h.session.inspect().notice, /未写入/)
})
test("past or same-day explicit reschedule remains a diary, but a future reschedule refuses without losing pending input", async () => {
  const h = harness(); h.session.change({ entryDate: "2026-10-09", title: "保留" }); assert.equal(await h.session.save(), false)
  assert.equal(h.stats().writes, 0); assert.equal(h.session.inspect().body.title, "保留"); assert.equal(h.session.inspect().dirty, true)
  h.session.change({ entryDate: "2026-10-01" }); assert.equal(await h.session.save(), true)
})
test("an unchanged future-relative diary date is omitted from body-only updates instead of silently repaired", async () => {
  const h = harness(target({ entryDate: "2026-10-09" })); h.session.change({ title: "保留原日" }); assert.equal(await h.session.save(), true)
  assert.deepEqual(h.stats().patches, [{ title: "保留原日" }]); assert.equal(h.session.inspect().body.entryDate, "2026-10-09")
})
test("diary images and metadata survive title-only editing without media mutation or text-only downgrading", async () => {
  const image = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: "local://media/retained" } }] } }
  const h = harness(target({ content: image, mood: "喜", weather: "晴", tagIds: ["tag"] })); h.session.change({ title: "只改题" })
  assert.equal(await h.session.save(), true); assert.deepEqual(h.session.inspect().body.content, image); assert.deepEqual(h.stats().patches, [{ title: "只改题" }])
})
test("invalid representable input stays in the session, blocks save, and requires an explicit correction", async () => {
  const h = harness(); assert.equal(h.session.change({ title: "x".repeat(256), content: content("保留输入") }), false)
  assert.equal(h.session.inspect().body.title.length, 256); assert.equal(await h.session.save(), false); assert.equal(h.stats().writes, 0)
  assert.equal(h.session.change({ title: "修正" }), true); assert.equal(await h.session.save(), true)
})
test("unsupported version and image-bearing content are not discarded when validation fails", async () => {
  const h = harness(); const tooNew = { ...content("保留"), schemaVersion: 2 }; assert.equal(h.session.change({ content: tooNew }), false)
  assert.deepEqual(h.session.inspect().body.content, tooNew); assert.equal(await h.session.save(), false)
})
test("cyclic or uncloneable updates block stale submission, preserve the last accessible input, and can be explicitly replaced", async () => {
  for (const update of [{ title: () => "bad" }, (() => { const c = content("cycle"); c.doc.content.push(c.doc); return { content: c } })()]) {
    const h = harness(); h.session.change({ title: "之前输入" }); assert.equal(h.session.change(update), false)
    assert.equal(await h.session.save(), false); assert.equal(await h.session.prepareLeave(), false); assert.equal(h.stats().writes, 0)
    assert.equal(h.session.change({ title: "明确新输入", content: content("兼容") }), true); assert.equal(await h.session.save(), true)
  }
})
test("unknown/identity/deletion/undefined fields are refused rather than allowing caller-controlled source mutation", async () => {
  for (const update of [{ id: OTHER_ID }, { fromScheduleId: null }, { isDeleted: 1 }, { contentText: "forged" }, { title: undefined }, null, []]) {
    const h = harness(); assert.equal(h.session.change(update), false); assert.equal(await h.session.save(), false); assert.equal(h.stats().writes, 0)
  }
})
test("dirty leave is blocked until explicit save; clean leave closes the session without new writes", async () => {
  const h = harness(); h.session.change({ title: "编辑" }); assert.equal(await h.session.prepareLeave(), false)
  assert.equal(await h.session.save(), true); assert.equal(await h.session.prepareLeave(), true); assert.equal(await h.session.prepareLeave(), true)
  assert.equal(h.session.change({ title: "closed" }), false); assert.equal(await h.session.save(), false); assert.equal(h.stats().writes, 1)
})
test("confirmed discard clears only runtime edits, including after context expiry, not diary/safety draft storage", async () => {
  const h = harness(); const before = h.stored(); h.session.change({ title: "未存" }); h.session.invalidate("expired")
  assert.equal(await h.session.prepareLeave(), false); assert.equal(h.session.discardConfirmed(), true)
  assert.deepEqual(h.session.inspect().body.title, before.entry.title); assert.equal(h.session.inspect().closed, true)
  assert.deepEqual(h.stored(), before); assert.equal(h.stats().writes, 0)
})
test("ordinary save errors retain body and original lease; retry does not read a replacement target", async () => {
  const h = harness(); const original = h.port.save; const attempts = []
  h.port.save = async (lease, patch) => { attempts.push(copy(lease)); if (attempts.length === 1) throw new Error("conflict"); return original(lease, patch) }
  h.session.change({ title: "保留" }); assert.equal(await h.session.save(), false); assert.equal(h.session.inspect().body.title, "保留")
  assert.equal(await h.session.save(), true); assert.deepEqual(attempts[0], attempts[1])
})
test("context validation error invalidates writes without deleting the runtime copy", async () => {
  const h = harness(); h.session.change({ title: "复制我" }); h.fail(expired()); assert.equal(await h.session.save(), false)
  assert.equal(h.session.inspect().expired, true); assert.equal(h.session.inspect().body.title, "复制我"); assert.equal(h.stats().writes, 0)
  h.fail(null); assert.equal(await h.session.save(), false); assert.equal(h.session.change({ title: "replay" }), false)
})
test("single-flight locks edits, leave and discard during an in-progress confirmation", async () => {
  const h = harness(); const entered = gate(); const wait = gate(); const save = h.port.save
  h.port.save = async (...args) => { entered.release(); await wait.promise; return save(...args) }
  h.session.change({ title: "fixed" }); const task = h.session.save(); await entered.promise
  assert.equal(await h.session.save(), false); assert.equal(h.session.change({ title: "late" }), false)
  assert.equal(await h.session.prepareLeave(), false); assert.equal(h.session.discardConfirmed(), false)
  wait.release(); assert.equal(await task, true); assert.equal(h.session.inspect().body.title, "fixed")
})
test("invalidation suppresses a late legal save receipt but cannot undo the already committed transaction", async () => {
  const h = harness(); const entered = gate(); const wait = gate(); const save = h.port.save
  h.port.save = async (...args) => { const receipt = await save(...args); entered.release(); await wait.promise; return receipt }
  h.session.change({ title: "保存边界" }); const task = h.session.save(); await entered.promise; h.session.invalidate("stop"); wait.release()
  assert.equal(await task, false); assert.equal(h.stored().entry.title, "保存边界"); assert.equal(h.session.inspect().dirty, true)
  assert.equal(h.session.inspect().body.title, "保存边界"); assert.equal(h.session.inspect().expired, true)
})
test("dispose removes callbacks and keeps a copyable pending body without claiming durable persistence", () => {
  const h = harness(); let signals = 0; h.session.subscribe(() => { signals++ }); h.session.change({ title: "内存" }); h.session.dispose()
  const count = signals; h.session.invalidate(); h.session.change({ title: "ignored" }); assert.equal(signals, count)
  assert.equal(h.session.inspect().body.title, "内存"); assert.equal(h.stats().writes, 0)
})
test("changed identity, regressed lease or mismatching receipt can never mark runtime input saved", async () => {
  for (const receipt of [target({ id: OTHER_ID }), target({ clientUpdatedAt: AT }), target({ title: "not input", clientUpdatedAt: LATER })]) {
    const h = harness(); h.port.save = async () => receipt; h.session.change({ title: "confirmed" }); assert.equal(await h.session.save(), false)
    assert.equal(h.session.inspect().dirty, true); assert.equal(h.session.inspect().body.title, "confirmed")
  }
})
test("invalid initial identity/revision/terminal/body is not turned into a blank writable diary", () => {
  for (const value of [target({ isDeleted: 1 }), target({ clientUpdatedAt: "bad" }), target({ content: { ...content("bad"), schemaVersion: 2 } }), { ...target(), lease: { id: OTHER_ID, fromScheduleId: ID, clientUpdatedAt: AT } }]) assert.throws(() => create(value, harness().port))
})
function real() {
  let subject = "account-a"; let generation = 0
  const h = setup({ "@/api/tokenStore": { accessTokenSubject: () => subject, tokenGeneration: () => generation }, "@/capabilities/image": { resizeToBlob: async () => null } })
  const validate = h.load("db/scheduleHostContext.ts").assertHostContext
  const targets = h.load("db/scheduleDiaryTargetRepo.ts"); const context = { ownerUserId: "", generation: "", authSubject: subject, authGeneration: generation }
  const hostPort = { capture: async () => copy(context), validate: ctx => h.db.transaction("r", h.db.meta, () => validate(ctx)), workspace: () => ({}), watch: () => () => undefined,
    firstSaveFrame: async () => null, openDiary: targets.openDiaryTarget, saveDiary: targets.saveDiaryTarget }
  return { ...h, host: h.load("shared/scheduleHost.ts").createScheduleHost(hostPort, () => TODAY), switch() { subject = "account-b"; generation++ } }
}
test("host pins a diary session and refuses replacing it or bypassing it through the old saveTarget bridge", async () => {
  const h = real(); await h.db.entries.put(entry({ entryDate: TODAY, fromScheduleId: null })); await h.host.initialize()
  assert.equal(await h.host.openTargetEditor(ID), true); const s = h.host.diaryEditor(); s.change({ title: "保留" })
  assert.equal(await h.host.openTarget(OTHER_ID), false); assert.equal(await h.host.openTargetEditor(OTHER_ID), false)
  assert.equal(await h.host.saveTarget({ title: "bypass" }), false); assert.equal(await h.host.prepareTargetLeave(), false)
  assert.equal(await s.save(), true); assert.equal(await h.host.prepareTargetLeave(), true)
  assert.equal(await h.host.openTarget(ID), true); assert.equal(h.host.diaryEditor(), null); h.host.dispose()
})
test("real guarded save conflict never re-reads a new lease or overwrites a newer diary", async () => {
  const h = real(); await h.db.entries.put(entry({ entryDate: TODAY, fromScheduleId: null })); await h.host.initialize(); await h.host.openTargetEditor(ID)
  const s = h.host.diaryEditor(); s.change({ title: "pending" }); await h.db.entries.update(ID, { title: "other tab", clientUpdatedAt: LATER })
  assert.equal(await s.save(), false); assert.equal((await h.db.entries.get(ID)).title, "other tab"); assert.equal(s.inspect().body.title, "pending")
  assert.equal(await s.save(), false); assert.equal(await h.host.prepareTargetLeave(), false); s.discardConfirmed(); h.host.dispose()
})
test("real target deletion and auth switch stop the editor while preserving input", async () => {
  for (const action of [async h => h.db.entries.update(ID, { isDeleted: 1 }), async h => h.switch()]) {
    const h = real(); await h.db.entries.put(entry({ entryDate: TODAY, fromScheduleId: null })); await h.host.initialize(); await h.host.openTargetEditor(ID)
    const s = h.host.diaryEditor(); s.change({ title: "保留输入" }); await action(h); assert.equal(await s.save(), false)
    assert.equal(s.inspect().body.title, "保留输入"); assert.equal((await h.db.entries.get(ID)).title, "日记"); h.host.dispose()
  }
})
test("converted diary editing retains terminal identity and immutable first intent while leaving the old safety draft untouched", async () => {
  const h = real(); await h.db.schedules.put(terminal()); await h.db.entries.put(entry({ entryDate: TODAY })); await h.db.meta.put({ key: "scheduleConversions", value: [{ ...intent(), ownerUserId: "" }] })
  await h.db.meta.put({ key: "draft", value: { owner: "original safety draft" } }); const queue = await h.db.meta.get("scheduleConversions"); const draft = await h.db.meta.get("draft")
  await h.host.initialize(); assert.equal(await h.host.openTargetEditor(ID), true); const s = h.host.diaryEditor(); s.change({ title: "后续编辑" }); assert.equal(await s.save(), true)
  assert.equal((await h.db.entries.get(ID)).fromScheduleId, ID); assert.deepEqual(await h.db.meta.get("scheduleConversions"), queue); assert.deepEqual(await h.db.meta.get("draft"), draft); h.host.dispose()
})
test("host expiry propagates to the retained session, preserving unsaved runtime body for explicit copying", async () => {
  const h = real(); await h.db.entries.put(entry({ entryDate: TODAY, fromScheduleId: null })); await h.host.initialize(); await h.host.openTargetEditor(ID)
  const s = h.host.diaryEditor(); s.change({ title: "copy me" }); h.host.invalidate("restore")
  assert.equal(s.inspect().expired, true); assert.equal(s.inspect().body.title, "copy me"); assert.equal(await s.save(), false); assert.equal(await h.host.prepareTargetLeave(), false); h.host.dispose()
})
test("private session remains unmounted and does not import unsafe old editors, storage drafts, network or media upload", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/shared/scheduleDiaryEditor.ts"), "utf8")
  assert.doesNotMatch(source, /localStorage|draftRepo|fetch\(|router|upload|mediaRepo/)
  for (const file of ["App.vue", "router/index.ts", "views/ScheduleView.vue"]) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), /scheduleDiaryEditor|ScheduleHost/)
})

test("a late ordinary save error cannot overwrite an already revoked session's reason", async () => {
  const h = harness(); const entered = gate(); const wait = gate()
  h.port.save = async () => { entered.release(); await wait.promise; throw new Error("old ordinary error") }
  h.session.change({ title: "保留" }); const task = h.session.save(); await entered.promise
  h.session.invalidate("restore stopped session"); wait.release(); assert.equal(await task, false)
  assert.equal(h.session.inspect().error, "restore stopped session"); assert.equal(h.session.inspect().body.title, "保留")
})
