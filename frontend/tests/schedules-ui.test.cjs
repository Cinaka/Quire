const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, AT, content, schedule, terminal, setup } = require("./schedules-data-harness.cjs")
const { presentSchedule, draftRecoveryMessage } = loadTS("shared/schedulePresentation.ts")
const TODAY = "2026-10-08"
const body = extra => ({ remindDate: "2026-10-09", title: "新计划", content: content("正文"), ...extra })
const read = relative => fs.readFileSync(path.join(__dirname, "../src", relative), "utf8")
const journal = async h => (await h.db.meta.get("scheduleDraft"))?.value
function harness() {
  const time = { ...loadTS("shared/time.ts"), utcNow: () => AT, todayLocal: () => TODAY }
  const h = setup({ "./time": time, "@/shared/time": time })
  return { ...h, editors: h.load("db/scheduleEditorRepo.ts").localScheduleEditorRepo,
    panels: h.load("shared/scheduleEditorPanel.ts").createScheduleEditorPanel,
    drafts: h.load("db/scheduleDraftRepo.ts").localScheduleDraftRepo }
}
async function create(h) { return h.panels(await h.editors.openNew("2026-10-09")) }

for (const [date, phase, convert] of [["2026-10-09", "future", false], [TODAY, "due", true], ["2026-10-01", "overdue", true]]) {
  test(`list renders ${phase} without mutation and gates conversion by local day`, () => {
    const row = schedule({ remindDate: date, contentText: "派生字段不能信任" }); const before = JSON.stringify(row)
    const view = presentSchedule(row, TODAY)
    assert.equal(view.phase, phase); assert.equal(view.canConvert, convert); assert.equal(view.canEdit, true)
    assert.equal(view.preview, "计划"); assert.equal(JSON.stringify(row), before)
  })
}
test("terminal and deleted presentation never unlock conversion; only deleted sources can restore", () => {
  const converted = presentSchedule(terminal(), TODAY)
  assert.equal(converted.canEdit, false); assert.equal(converted.canConvert, false); assert.equal(converted.canInspect, true)
  const deleted = presentSchedule(terminal({ isDeleted: 1, deletedAt: AT }), TODAY)
  assert.equal(deleted.phase, "deleted"); assert.equal(deleted.canRestore, true); assert.equal(deleted.canInspect, false)
  assert.equal(deleted.canRemove, false); assert.equal(deleted.canConvert, false)
})
test("malformed/unsupported rows are quarantined with no write or inspect actions", () => {
  for (const row of [schedule({ id: "bad" }), schedule({ title: "长".repeat(256) }),
    schedule({ content: { schemaVersion: 9, doc: { type: "doc", content: [] } } })]) {
    const view = presentSchedule(row, TODAY); assert.equal(view.usable, false)
    for (const key of ["canEdit", "canConvert", "canRemove", "canRestore", "canInspect"]) assert.equal(view[key], false)
  }
})
test("preview is plain textual output, bounded and not trusted HTML", () => {
  const view = presentSchedule(schedule({ content: content("<script>" + "字".repeat(200)) }), TODAY)
  assert.equal(view.preview.length, 180); assert.ok(view.preview.startsWith("<script>"))
  assert.doesNotMatch(read("components/schedules/ScheduleList.vue"), /v-html/)
})
test("day boundary recomputes display status without persisting a due/overdue flag", () => {
  const row = schedule(); assert.equal(presentSchedule(row, TODAY).phase, "future")
  assert.equal(presentSchedule(row, "2026-10-09").phase, "due")
  assert.equal(presentSchedule(row, "2026-10-10").phase, "overdue")
  assert.throws(() => presentSchedule(row, "2026-02-29"))
})
test("recovery text distinguishes safe, identical, conflicting and unavailable states without cloud claims", () => {
  assert.equal(draftRecoveryMessage("empty"), "")
  assert.match(draftRecoveryMessage("recoverable"), /不会自动保存|不会上传/)
  assert.match(draftRecoveryMessage("alreadySaved"), /核对/)
  assert.match(draftRecoveryMessage("conflict"), /不能直接覆盖/)
  assert.match(draftRecoveryMessage("sourceUnavailable"), /不能保存回原来源/)
})
test("panel construction is read-only and never restores or writes on its own", async () => {
  const h = harness(); const p = await create(h)
  assert.equal(p.inspect().body.title, ""); assert.equal(h.stores.meta.rows.size, 0)
  assert.equal(h.stores.schedules.rows.size, 0); assert.match(p.inspect().notice, /尚未确认云端/)
})
test("each change persists a safety draft but does not implicitly submit a Schedule", async () => {
  const h = harness(); const p = await create(h)
  assert.equal(await p.change(body()), true)
  assert.equal((await journal(h)).draft.title, "新计划"); assert.equal(h.stores.schedules.rows.size, 0)
  assert.equal(p.inspect().pending, 0); assert.match(p.inspect().notice, /尚未保存为预简/)
})
test("rapid changes retain latest UI snapshot and ignore old result notices", async () => {
  const h = harness(); const p = await create(h); const jobs = ["A", "B", "C"].map(title => p.change(body({ title })))
  assert.equal(p.inspect().pending, 3); assert.equal(p.inspect().body.title, "C")
  assert.deepEqual(await Promise.all(jobs), [true, true, true])
  assert.equal(p.inspect().pending, 0); assert.equal((await journal(h)).draft.title, "C")
})
test("input and inspect copies cannot mutate pending UI snapshots or stored body", async () => {
  const h = harness(); const p = await create(h); const b = body(); const job = p.change(b)
  b.title = "外部修改"; b.content.doc.content[0].content[0].text = "外部修改"
  const state = p.inspect(); state.body.title = "外部修改"
  await job; assert.equal((await journal(h)).draft.title, "新计划")
  assert.equal((await journal(h)).draft.content.doc.content[0].content[0].text, "正文")
})
test("submit disables new edits and repeated submits while persisting the visible snapshot once", async () => {
  const h = harness(); const p = await create(h); await p.change(body())
  const saving = p.submit(); assert.equal(p.inspect().busy, true)
  assert.equal(await p.change(body({ title: "不允许覆盖" })), false); assert.equal(await p.submit(), false)
  assert.equal(await saving, true); assert.equal(h.stores.schedules.rows.size, 1)
  assert.equal((await journal(h)).draft, null); assert.match(p.inspect().notice, /已保存本机.*尚未开放/)
})
test("edits after save use the same returned source identity", async () => {
  const h = harness(); const p = await create(h); await p.change(body()); await p.submit()
  const id = [...h.stores.schedules.rows.keys()][0]
  await p.change(body({ title: "再改" })); assert.equal((await journal(h)).draft.scheduleId, id)
  await p.submit(); assert.equal(h.stores.schedules.rows.size, 1); assert.equal((await h.db.schedules.get(id)).title, "再改")
})
test("invalid/empty business save remains visible and retained as a safety draft", async () => {
  const h = harness(); const p = await create(h); await p.change(body({ title: "", content: null }))
  assert.equal(await p.submit(), false); assert.match(p.inspect().error, /请填写/)
  assert.ok((await journal(h)).draft); assert.equal(h.stores.schedules.rows.size, 0)
  assert.equal(await p.change(body()), true); assert.equal(await p.submit(), true)
})
test("invalid date failure prevents silent navigation and allows correction", async () => {
  const h = harness(); const p = await create(h); await p.change(body())
  assert.equal(await p.change(body({ remindDate: "" })), false)
  assert.equal(p.inspect().body.remindDate, ""); assert.equal(await p.prepareLeave(), false)
  assert.equal(p.inspect().closed, false); assert.ok((await journal(h)).draft)
  await p.change(body({ remindDate: "2026-10-10" })); assert.equal(await p.prepareLeave(), true)
})
test("storage failure is surfaced; leave guard blocks rather than claiming latest text was saved", async () => {
  const h = harness(); const p = await create(h); h.failNext("meta")
  assert.equal(await p.change(body()), false); assert.match(p.inspect().error, /storage failure/)
  assert.match(p.inspect().notice, /不能.*确认/); assert.equal(await p.prepareLeave(), false)
  assert.equal(p.inspect().closed, false)
  await p.change(body()); assert.equal(await p.prepareLeave(), true)
})
test("leave guard waits for pending drafts, closes once, and never implicitly creates a Schedule", async () => {
  const h = harness(); const p = await create(h); const writing = p.change(body()); const leaving = p.prepareLeave()
  assert.equal(p.inspect().busy, true); assert.equal(await p.change(body({ title: "旧输入" })), false)
  await writing; assert.equal(await leaving, true); assert.equal(p.inspect().closed, true)
  assert.ok((await journal(h)).draft); assert.equal(h.stores.schedules.rows.size, 0)
  assert.equal(await p.change(body()), false)
})
test("leaving an untouched new editor does not manufacture an empty draft", async () => {
  const h = harness(); const p = await create(h); assert.equal(await p.prepareLeave(), true)
  assert.equal(h.stores.meta.rows.size, 0)
})
test("explicit confirmed discard clears only safety text; saved schedule remains", async () => {
  const h = harness(); const p = await create(h); await p.change(body()); await p.submit(); await p.change(body({ title: "未正式保存" }))
  const source = [...h.stores.schedules.rows.values()][0]
  assert.equal(await p.discardConfirmed(), true); assert.equal((await journal(h)).draft, null)
  assert.equal((await h.db.schedules.get(source.id)).title, "新计划"); assert.equal(p.inspect().closed, true)
})
test("discard failure keeps the editor open and existing journal intact", async () => {
  const h = harness(); const p = await create(h); await p.change(body()); h.failNext("meta")
  assert.equal(await p.discardConfirmed(), false); assert.equal(p.inspect().closed, false)
  assert.ok((await journal(h)).draft); assert.match(p.inspect().error, /storage failure/)
})
test("conflict restoration surfaces source state and never silently rebases it", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const session = await h.editors.openExisting(ID)
  await session.persist(body()); await h.db.schedules.update(ID, { title: "其他修改", clientUpdatedAt: "2026-10-08T11:00:00.000Z" })
  const p = h.panels(await h.editors.resume()); assert.equal(p.inspect().sourceStatus, "conflict")
  await p.change(body({ title: "保留新文字" })); assert.equal(await p.submit(), false)
  assert.equal((await h.db.schedules.get(ID)).title, "其他修改"); assert.equal((await journal(h)).draft.title, "保留新文字")
})
test("source deletion keeps restored text editable as a draft but blocks formal save", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const s = await h.editors.openExisting(ID)
  await s.persist(body()); await h.db.schedules.delete(ID)
  const p = h.panels(await h.editors.resume()); assert.equal(p.inspect().sourceStatus, "sourceUnavailable")
  await p.change(body({ title: "保留" })); assert.equal(await p.submit(), false)
  assert.ok((await journal(h)).draft); assert.equal(h.stores.schedules.rows.size, 0)
})
test("owner/restore changes invalidate existing UI session without fetching a new lease to replay text", async () => {
  for (const key of ["ownerUserId", "ownerGeneration"]) {
    const h = harness(); const p = await create(h); await h.db.meta.put({ key, value: "changed" })
    assert.equal(await p.change(body()), false); assert.match(p.inspect().error, /账号或恢复批次/)
    assert.equal(await p.prepareLeave(), false); assert.equal((await journal(h)), undefined)
  }
})
test("disposing suppresses late callbacks and notifications, without pretending to cancel an active storage write", async () => {
  const h = harness(); const factory = h.load("shared/scheduleEditor.ts").createScheduleEditorSession
  const initial = await h.drafts.read(); let entered, release
  const started = new Promise(resolve => { entered = resolve }); const gate = new Promise(resolve => { release = resolve })
  const port = { ...h.drafts, async save(...args) { entered(); await gate; return h.drafts.save(...args) } }
  const s = factory(port, initial, { scheduleId: null, baseClientUpdatedAt: null, ...body() }); const p = h.panels(s)
  let notices = 0; p.subscribe(() => { notices++ })
  const pending = p.change(body()); await started; p.dispose(); const count = notices; release()
  assert.equal(await pending, false); assert.equal(notices, count); assert.equal(p.inspect().closed, true)
  assert.ok((await journal(h)).draft); assert.equal(await p.submit(), false)
})
test("unsubscribe stops UI notifications and observers receive copies through inspect", async () => {
  const h = harness(); const p = await create(h); let count = 0
  const unsubscribe = p.subscribe(() => { count++; const state = p.inspect(); state.body.title = "修改副本" })
  await p.change(body()); assert.ok(count >= 2); unsubscribe(); const before = count
  await p.change(body({ title: "下一次" })); assert.equal(count, before); assert.equal(p.inspect().body.title, "下一次")
})
test("text editor schema has only existing StarterKit and placeholder, no images or diary reuse", () => {
  const schema = read("editor/scheduleSchema.ts")
  assert.match(schema, /levels: \[1, 2, 3\]/); assert.match(schema, /StarterKit.configure/); assert.match(schema, /Placeholder.configure/)
  assert.doesNotMatch(schema, /LocalImage|insertImages|buildExtensions|extension-image|taskList/)
  const editor = read("components/schedules/ScheduleTextEditor.vue")
  assert.match(editor, /assertScheduleEditorContent\(props.initialContent\)/)
  assert.match(editor, /handlePaste/); assert.match(editor, /handleDrop/); assert.match(editor, /data\?\.files.length/)
  assert.doesNotMatch(editor, /mediaRepo|insertImages|type="file"|EntryMetaFields/)
})
test("editor panel exposes guarded leave and explicit discard confirmation, no DB or cloud side effects in template", () => {
  const panel = read("components/schedules/ScheduleEditorPanel.vue")
  assert.match(panel, /defineExpose\(\{ prepareLeave \}\)/); assert.match(panel, /window.confirm/)
  assert.match(panel, /panel\.change/); assert.match(panel, /panel\.submit/)
  assert.doesNotMatch(panel, /v-html|@\/repo|localScheduleRepo|syncNow|onBeforeUnload|beforeunload/)
})
test("draft notice is explicit events only; errors expose no discard or resume actions", () => {
  const notice = read("components/schedules/ScheduleDraftNotice.vue")
  assert.match(notice, /v-if="error"/); assert.match(notice, /v-else-if="recovery\?\.draft"/)
  assert.match(notice, /emit\('resume'\)/); assert.match(notice, /discard-request/)
  assert.doesNotMatch(notice, /localScheduleDraftRepo|\.clear\(|onMounted|\.save\(/)
})
test("list conversion is only an explicit version-pinned request, not an automatic write", () => {
  const list = read("components/schedules/ScheduleList.vue")
  assert.match(list, /item\.view\.canConvert/); assert.match(list, /expectedClientUpdatedAt: item\.row\.clientUpdatedAt/)
  assert.doesNotMatch(list, /localScheduleRepo|@\/repo|onMounted|setInterval|\.convert\(/)
})
test("new components remain unmounted by router, placeholder and app; public repository gate stays closed", () => {
  const publicRepo = read("repo/index.ts"); assert.doesNotMatch(publicRepo, /scheduleRepo|scheduleEditorRepo|scheduleDraftRepo/)
  const app = read("App.vue"); assert.match(app, /aria-disabled="true".*预简/)
  assert.doesNotMatch(read("views/ScheduleView.vue"), /ScheduleList|ScheduleEditorPanel|ScheduleDraftNotice/)
  assert.doesNotMatch(read("router/index.ts"), /components\/schedules|ScheduleEditorPanel|ScheduleTextEditor/)
})
test("a newer unserializable input error cannot be erased by an older successful draft response", async () => {
  const h = harness(); const p = await create(h); const old = p.change(body())
  const cyclic = body(); cyclic.content.doc.content.push(cyclic.content.doc)
  assert.equal(await p.change(cyclic), false); await old
  assert.notEqual(p.inspect().error, ""); assert.equal(await p.prepareLeave(), false)
  assert.equal(await p.submit(), false); assert.equal(h.stores.schedules.rows.size, 0)
  assert.equal(await p.change(body({ title: "已纠正" })), true); assert.equal(await p.submit(), true)
})
test("failed formal save can be followed by explicit safety retry and leave without business creation", async () => {
  const h = harness(); const p = await create(h); const b = body({ remindDate: TODAY })
  await p.change(b); assert.equal(await p.submit(), false); assert.match(p.inspect().error, /未来日期/)
  assert.equal(await p.prepareLeave(), false)
  // 对应“重试保存安全草稿”，只调用change；安全草稿允许已到期日期。
  assert.equal(await p.change(b), true); assert.equal(await p.prepareLeave(), true)
  assert.ok((await journal(h)).draft); assert.equal(h.stores.schedules.rows.size, 0)
})
