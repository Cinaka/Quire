const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, AT, content, schedule, terminal, setup } = require("./schedules-data-harness.cjs")
function harness(extra = {}) {
  let today = "2026-10-08"
  const time = { ...loadTS("shared/time.ts"), utcNow: () => AT, todayLocal: () => today }
  const h = setup({ "./time": time, "@/shared/time": time, ...extra })
  return { ...h, drafts: h.load("db/scheduleDraftRepo.ts").localScheduleDraftRepo,
    editors: h.load("db/scheduleEditorRepo.ts").localScheduleEditorRepo,
    schedules: h.load("db/scheduleRepo.ts").localScheduleRepo,
    today: value => { today = value } }
}
const body = extra => ({ remindDate: "2026-10-09", title: "文字", content: content("新计划"), ...extra })
const snapshot = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([name, store]) => [name, [...store.rows.values()]])))
const journal = async h => (await h.db.meta.get("scheduleDraft"))?.value
async function newDraft(h, extra) {
  const s = await h.editors.openNew("2026-10-09")
  return s.persist(body(extra))
}
const owner = h => h.db.meta.put({ key: "ownerUserId", value: "B" })
const epoch = h => h.db.meta.put({ key: "ownerGeneration", value: "restored" })

test("opening new/existing editors is read-only; no implicit draft or business writes", async () => {
  const h = harness(); const a = await h.editors.openNew("2026-10-09")
  assert.equal(a.inspect().payload.title, ""); assert.equal(h.stores.meta.rows.size, 0)
  await h.db.schedules.put(schedule()); const before = snapshot(h)
  const b = await h.editors.openExisting(ID)
  assert.equal(b.inspect().payload.scheduleId, ID); assert.equal(snapshot(h), before)
  assert.equal(h.stores.entries.rows.size, 0)
})
test("occupied journal is never implicitly replaced by opening a new or different existing editor", async () => {
  const h = harness(); await newDraft(h); await h.db.schedules.put(schedule()); const before = snapshot(h)
  await assert.rejects(h.editors.openNew("2026-10-10"), /已有预简草稿/)
  await assert.rejects(h.editors.openExisting(ID), /已有预简草稿/)
  assert.equal(snapshot(h), before)
})
test("resume requires an existing valid journal and preserves unavailable source text", async () => {
  const h = harness(); await assert.rejects(h.editors.resume(), /没有可恢复/)
  await h.db.schedules.put(schedule()); const s = await h.editors.openExisting(ID)
  await s.persist(body()); await h.db.schedules.delete(ID)
  const recovered = await h.editors.resume()
  assert.equal(recovered.inspect().status, "sourceUnavailable"); assert.equal(recovered.inspect().payload.title, "文字")
  await recovered.persist(body({ title: "保留更多文字" }))
  await assert.rejects(recovered.submit(body()), /来源不可编辑/)
  assert.ok((await journal(h)).draft); assert.equal(h.stores.schedules.rows.size, 0)
})
test("existing deleted, converted, missing and unsupported sources cannot open for editing", async () => {
  const h = harness(); await assert.rejects(h.editors.openExisting(ID), /不可编辑/)
  await assert.rejects(h.editors.openExisting("bad"), /UUID v7/)
  for (const row of [schedule({ isDeleted: 1, deletedAt: AT }), terminal(),
    schedule({ content: { schemaVersion: 9, doc: { type: "doc", content: [] } } })]) {
    await h.db.schedules.put(row); await assert.rejects(h.editors.openExisting(ID), /不可编辑/)
  }
  assert.equal(h.stores.meta.rows.size, 0)
})
test("rapid autosave calls serialize with returned leases and retain the last body", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09")
  const jobs = ["A", "B", "C"].map(title => s.persist(body({ title })))
  const results = await Promise.all(jobs); await s.flush()
  assert.deepEqual(results.map(result => result.lease.revision), [1, 2, 3])
  assert.equal((await journal(h)).draft.title, "C"); assert.equal(h.stores.schedules.rows.size, 0)
})
test("queued snapshots and inspect results do not share mutable content or leases", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); const b = body()
  const pending = s.persist(b); b.title = "篡改"; b.content.doc.content[0].content[0].text = "篡改"
  const result = await pending; result.lease.revision = 999; result.draft.title = "篡改"
  const view = s.inspect(); view.payload.title = "篡改"; view.lease.revision = 999
  await s.persist(body({ title: "下一次" }))
  assert.equal((await journal(h)).draft.content.doc.content[0].content[0].text, "新计划")
  assert.equal((await journal(h)).revision, 2)
})
test("explicit submit atomically creates one pending schedule and consumes the stored journal", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09")
  const result = await s.submit(body())
  assert.equal(result.created, true); assert.equal(result.schedule.contentText, "新计划")
  assert.equal(result.schedule.dirty, 1); assert.equal(result.schedule.status, "pending")
  assert.equal((await journal(h)).draft, null); assert.equal((await journal(h)).revision, 2)
  assert.equal(s.inspect().payload.scheduleId, result.schedule.id)
  assert.equal(s.inspect().payload.baseClientUpdatedAt, result.schedule.clientUpdatedAt)
  assert.equal(h.stores.schedules.rows.size, 1); assert.equal(h.stores.entries.rows.size, 0)
})
test("two rapid submit clicks create once; unchanged saved body does not bump dirty or revision", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09")
  const [a, b] = await Promise.all([s.submit(body()), s.submit(body())])
  assert.equal(a.created, true); assert.equal(b.created, false)
  assert.equal(a.schedule.id, b.schedule.id); assert.equal(a.schedule.clientUpdatedAt, b.schedule.clientUpdatedAt)
  assert.equal(h.stores.schedules.rows.size, 1); assert.equal((await journal(h)).draft, null)
})
test("edits queued after creation bind to the returned source instead of creating an orphan draft", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09")
  const created = s.submit(body({ title: "第一次" }))
  const edited = s.persist(body({ title: "保存后的新文字" }))
  const [a, b] = await Promise.all([created, edited])
  assert.equal(b.draft.scheduleId, a.schedule.id); assert.equal(b.draft.baseClientUpdatedAt, a.schedule.clientUpdatedAt)
  assert.equal(b.draft.title, "保存后的新文字"); assert.equal((await h.db.schedules.get(a.schedule.id)).title, "第一次")
  const updated = await s.submit(body({ title: "保存后的新文字" }))
  assert.equal(updated.schedule.id, a.schedule.id); assert.equal(updated.created, false)
  assert.equal(h.stores.schedules.rows.size, 1)
})
test("submit waits for prior persistence and snapshots its own current body", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09")
  const a = s.persist(body({ title: "旧稿" })); const b = body({ title: "点击时正文" })
  const saved = s.submit(b); b.title = "之后修改对象"
  await a; const result = await saved
  assert.equal(result.schedule.title, "点击时正文"); assert.equal((await journal(h)).revision, 3)
})
test("existing edit commits preserve server and creation metadata and accept elapsed rescheduling", async () => {
  const h = harness(); await h.db.schedules.put(schedule({ dirty: 0, serverUpdatedAt: AT }))
  const s = await h.editors.openExisting(ID)
  const result = await s.submit(body({ remindDate: "2026-10-01", title: "修改" }))
  assert.equal(result.created, false); assert.equal(result.schedule.id, ID)
  assert.equal(result.schedule.createdAt, AT); assert.equal(result.schedule.serverUpdatedAt, AT)
  assert.equal(result.schedule.clientUpdatedAt, "2026-10-08T10:00:00.001Z")
  assert.equal(result.schedule.dirty, 1); assert.equal(result.schedule.remindDate, "2026-10-01")
})
test("already-saved recovery consumes only the identical draft without rewriting a newer row", async () => {
  const h = harness(); await h.db.schedules.put(schedule({ dirty: 0 }))
  const s = await h.editors.openExisting(ID); const b = body()
  await s.persist(b)
  await h.db.schedules.update(ID, { ...b, contentText: "新计划", dirty: 0, clientUpdatedAt: "2026-10-08T11:00:00.000Z" })
  const before = await h.db.schedules.get(ID)
  const r = await h.editors.resume(); assert.equal(r.inspect().status, "alreadySaved")
  const result = await r.submit(b)
  assert.deepEqual(result.schedule, before); assert.equal((await journal(h)).draft, null)
})
test("source revision conflict cannot overwrite a concurrent business edit; draft remains", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const s = await h.editors.openExisting(ID)
  await s.persist(body()); await h.schedules.update(ID, { title: "另一标签修改" })
  const row = await h.db.schedules.get(ID)
  await assert.rejects(s.submit(body()), /来源已变化/)
  assert.deepEqual(await h.db.schedules.get(ID), row); assert.equal((await journal(h)).draft.title, "文字")
  assert.equal(s.inspect().payload.baseClientUpdatedAt, AT)
})
for (const [label, replace] of [
  ["missing", h => h.db.schedules.delete(ID)],
  ["deleted", h => h.db.schedules.put(schedule({ isDeleted: 1, deletedAt: AT }))],
  ["converted", h => h.db.schedules.put(terminal())],
  ["unsupported", h => h.db.schedules.put(schedule({ content: { schemaVersion: 9, doc: { type: "doc", content: [] } } }))],
]) test(`commit refuses ${label} source and preserves draft without regenerating a schedule`, async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const s = await h.editors.openExisting(ID)
  await s.persist(body()); await replace(h); const before = snapshot(h)
  const current = await h.drafts.read(); await assert.rejects(h.drafts.commit(current.lease, current.draft.draftId), /不可编辑/)
  assert.equal(snapshot(h), before); assert.equal(h.stores.entries.rows.size, 0)
})
for (const [label, change] of [["different owner", owner], ["same-owner restore epoch", epoch]]) {
  test(`captured editor lease blocks ${label} before autosave`, async () => {
    const h = harness(); const s = await h.editors.openNew("2026-10-09"); await change(h)
    const before = snapshot(h); await assert.rejects(s.persist(body()), /账号或恢复批次/)
    assert.equal(snapshot(h), before)
  })
  test(`atomic commit blocks ${label} after journal save without consuming text`, async () => {
    const h = harness(); const saved = await newDraft(h); await change(h); const before = snapshot(h)
    await assert.rejects(h.drafts.commit(saved.lease, saved.draft.draftId), /账号或恢复批次/)
    assert.equal(snapshot(h), before)
  })
}
test("two independent tabs with an empty initial lease cannot silently take each other's slot", async () => {
  const h = harness(); const a = await h.editors.openNew("2026-10-09"); const b = await h.editors.openNew("2026-10-10")
  await a.persist(body({ title: "A" })); const before = snapshot(h)
  await assert.rejects(b.submit(body({ title: "B" })), /已变化/)
  assert.equal(snapshot(h), before); assert.equal(h.stores.schedules.rows.size, 0)
})
test("two independent resumed tabs commit one journal once, not duplicate records", async () => {
  const h = harness(); const saved = await newDraft(h)
  const results = await Promise.allSettled([h.drafts.commit(saved.lease, saved.draft.draftId), h.drafts.commit(saved.lease, saved.draft.draftId)])
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1)
  assert.equal(results.filter(r => r.status === "rejected").length, 1)
  assert.equal(h.stores.schedules.rows.size, 1); assert.equal((await journal(h)).draft, null)
})
test("expired new date after midnight stays a draft; it never silently becomes a diary", async () => {
  const h = harness(); const saved = await newDraft(h); h.today("2026-10-09")
  const before = snapshot(h); await assert.rejects(h.drafts.commit(saved.lease, saved.draft.draftId), /未来日期/)
  assert.equal(snapshot(h), before); assert.equal(h.stores.entries.rows.size, 0)
  const r = await h.editors.resume(); const result = await r.submit(body({ remindDate: "2026-10-10" }))
  assert.equal(result.schedule.remindDate, "2026-10-10")
})
test("blank safety draft fails business save without deletion and can be edited then saved", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09")
  await assert.rejects(s.submit(body({ title: " ", content: null })), /请填写/)
  assert.ok((await journal(h)).draft); assert.equal(h.stores.schedules.rows.size, 0)
  await s.submit(body()); assert.equal(h.stores.schedules.rows.size, 1)
})
test("malformed editor body fails before queueing or replacing an existing safety draft", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body()); const before = snapshot(h)
  for (const b of [body({ title: "长".repeat(256) }), body({ remindDate: "2026-02-29" }),
    body({ content: { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image" }] } } }), body({ mood: "好" }), body({ scheduleId: ID }), body({ baseClientUpdatedAt: AT })]) {
    await assert.rejects(s.persist(b)); await assert.rejects(s.submit(b))
  }
  assert.equal(snapshot(h), before)
})
for (const [table, existing] of [["schedules", false], ["meta", false], ["schedules", true], ["meta", true]]) {
  test(`atomic ${existing ? "update" : "create"} rolls back both tables when ${table} write fails`, async () => {
    const h = harness(); if (existing) await h.db.schedules.put(schedule())
    const s = existing ? await h.editors.openExisting(ID) : await h.editors.openNew("2026-10-09")
    const saved = await s.persist(body()); const before = snapshot(h)
    h.failNext(table); await assert.rejects(h.drafts.commit(saved.lease, saved.draft.draftId), /storage failure/)
    assert.equal(snapshot(h), before); assert.ok((await journal(h)).draft)
    const result = await h.drafts.commit(saved.lease, saved.draft.draftId)
    assert.equal(result.created, !existing); assert.equal((await journal(h)).draft, null)
  })
}
test("generated ID collision cannot overwrite an old schedule or consume draft", async () => {
  const h = harness({ "@/shared/ids": { newId: () => ID } }); await h.db.schedules.put(schedule())
  const saved = await newDraft(h); const before = snapshot(h)
  await assert.rejects(h.drafts.commit(saved.lease, saved.draft.draftId), /duplicate ID/)
  assert.equal(snapshot(h), before)
})
test("commit rejects wrong identity, stale or mutated lease and saturated journal", async () => {
  const h = harness(); const saved = await newDraft(h); const before = snapshot(h)
  await assert.rejects(h.drafts.commit(saved.lease, "bad"));
  await assert.rejects(h.drafts.commit(saved.lease, ID), /会话/)
  await assert.rejects(h.drafts.commit({ ...saved.lease, revision: 0 }, saved.draft.draftId), /已变化/)
  assert.equal(snapshot(h), before)
  const lease = { ...saved.lease }; const pending = h.drafts.commit(lease, saved.draft.draftId); lease.ownerUserId = "changed"
  await pending; assert.equal(h.stores.schedules.rows.size, 1)
  const next = await newDraft(h); const value = await journal(h)
  await h.db.meta.put({ key: "scheduleDraft", value: { ...value, revision: Number.MAX_SAFE_INTEGER } })
  const saturated = await h.drafts.read(); const original = snapshot(h)
  await assert.rejects(h.drafts.commit(saturated.lease, next.draft.draftId), /耗尽/)
  assert.equal(snapshot(h), original)
})
test("unknown journal cannot open or commit and is not disguised as an empty slot", async () => {
  const h = harness(); await h.db.meta.put({ key: "scheduleDraft", value: { formatVersion: 99 } }); const before = snapshot(h)
  await assert.rejects(h.editors.openNew("2026-10-09"), /损坏/)
  await assert.rejects(h.editors.resume(), /损坏/)
  await assert.rejects(h.drafts.commit({ ownerUserId: "", generation: "", revision: 0 }, ID), /损坏/)
  assert.equal(snapshot(h), before)
})
test("discard closes session and cancels queued edits without resurrecting a cleared journal", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body())
  const discarded = s.discard(); const pending = s.persist(body({ title: "旧任务" }))
  await discarded; await assert.rejects(pending, /已关闭/)
  assert.equal((await journal(h)).draft, null); assert.equal(s.inspect().closed, true)
  await assert.rejects(s.submit(body()), /已关闭/); assert.equal(h.stores.schedules.rows.size, 0)
})
test("close cancels not-started writes but keeps existing safety text for explicit resume", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body())
  const pending = s.persist(body({ title: "未执行" })); s.close()
  await assert.rejects(pending, /已关闭/); assert.equal((await journal(h)).draft.title, "文字")
  const resumed = await h.editors.resume(); assert.equal(resumed.inspect().draft.title, "文字")
})
test("flush propagates storage failure and does not report a failed autosave as successful", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); h.failNext("meta")
  await assert.rejects(s.persist(body()), /storage failure/)
  await assert.rejects(s.flush(), /storage failure/)
  await s.persist(body({ title: "重试" })); await s.flush()
  assert.equal((await journal(h)).draft.title, "重试")
})
test("closing while a persistence call is already running never revives the controller", async () => {
  const h = harness(); const factory = h.load("shared/scheduleEditor.ts").createScheduleEditorSession
  const initial = await h.drafts.read(); let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const port = { ...h.drafts, async save(...args) { entered(); await gate; return h.drafts.save(...args) } }
  const s = factory(port, initial, { scheduleId: null, baseClientUpdatedAt: null, ...body() })
  const pending = s.persist(body()); await started; s.close(); release()
  await assert.rejects(pending, /已关闭/)
  assert.equal(s.inspect().closed, true); assert.equal(s.inspect().draft, null)
  assert.equal((await journal(h)).draft.title, "文字") // 已开始的存储操作可以完成，文档不得称为取消事务。
})
test("saving and discarding preplans leave ordinary diary draft and P2 metadata byte-for-byte unchanged", async () => {
  const h = harness(); for (const key of ["draft", "lastSyncAt", "conflicts", "pendingPurges"]) await h.db.meta.put({ key, value: { unchanged: key } })
  const before = [...h.stores.meta.rows.values()]
  const s = await h.editors.openNew("2026-10-09"); await s.submit(body()); await s.persist(body()); await s.discard()
  for (const row of before) assert.deepEqual(await h.db.meta.get(row.key), row)
  assert.equal(h.stores.entries.rows.size, 0); assert.equal(h.stores.media.rows.size, 0)
})
test("delete winning the shared write transaction race blocks editor commit without deleting safety text", async () => {
  const h = harness(); await h.db.schedules.put(schedule()); const s = await h.editors.openExisting(ID)
  const saved = await s.persist(body())
  await Promise.all([h.schedules.remove(ID), assert.rejects(h.drafts.commit(saved.lease, saved.draft.draftId), /不可编辑/)])
  assert.equal((await h.db.schedules.get(ID)).isDeleted, 1); assert.ok((await journal(h)).draft)
})
test("conversion winning the shared transaction race keeps one diary and blocks editor overwrite", async () => {
  const h = harness(); await h.db.schedules.put(schedule({ remindDate: "2026-10-08" }))
  const s = await h.editors.openExisting(ID); const saved = await s.persist(body({ remindDate: "2026-10-08" }))
  // 转换有前置owner读事务，不能用Promise调用顺序假装其写事务已先入队。
  await h.schedules.convert(ID, { expectedClientUpdatedAt: AT })
  await assert.rejects(h.drafts.commit(saved.lease, saved.draft.draftId), /不可编辑/)
  assert.equal(h.stores.entries.rows.size, 1); assert.equal((await h.db.schedules.get(ID)).status, "converted")
  assert.ok((await journal(h)).draft)
})
test("updated editor revision stops an older conversion request without discarding the updated schedule", async () => {
  const h = harness(); await h.db.schedules.put(schedule({ remindDate: "2026-10-08" }))
  const s = await h.editors.openExisting(ID); const saved = await s.persist(body({ remindDate: "2026-10-08" }))
  const result = await h.drafts.commit(saved.lease, saved.draft.draftId)
  await assert.rejects(h.schedules.convert(ID, { expectedClientUpdatedAt: AT }), /重新读取/)
  assert.equal(JSON.stringify(await h.db.schedules.get(ID)), JSON.stringify(result.schedule)); assert.equal(h.stores.entries.rows.size, 0)
})
test("backup contains unsaved editor text before commit and saved schedule without stale draft after commit", async () => {
  const h = harness(); const s = await h.editors.openNew("2026-10-09"); await s.persist(body())
  const backups = h.load("db/backupRepo.ts").localBackupRepo
  const before = await backups.exportAll()
  assert.equal(before.scheduleDraft.title, "文字"); assert.equal(before.schedules.length, 0)
  await s.submit(body()); const after = await backups.exportAll()
  assert.equal(after.scheduleDraft, null); assert.equal(after.schedules.length, 1)
  assert.equal(after.schedules[0].title, "文字")
})
test("close during already-started commit may finish atomically but does not install its result into closed session", async () => {
  const h = harness(); const factory = h.load("shared/scheduleEditor.ts").createScheduleEditorSession
  const initial = await h.drafts.read(); let entered, release
  const started = new Promise(resolve => { entered = resolve }); const gate = new Promise(resolve => { release = resolve })
  const port = { ...h.drafts, async commit(...args) { entered(); await gate; return h.drafts.commit(...args) } }
  const s = factory(port, initial, { scheduleId: null, baseClientUpdatedAt: null, ...body() })
  const pending = s.submit(body()); await started; s.close(); release()
  await assert.rejects(pending, /已关闭/)
  assert.equal((await journal(h)).draft, null); assert.equal(h.stores.schedules.rows.size, 1)
  assert.equal(s.inspect().closed, true); assert.equal(s.inspect().payload.scheduleId, null)
  // UI未来须按明确列表/来源重新读取，不把失效回调当作未保存来重发新建。
})
