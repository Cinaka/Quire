const { test } = require("node:test")
const assert = require("node:assert/strict")
const { loadTS } = require("./schedules-harness.cjs")
const { ID, OTHER_ID, AT, content, schedule, terminal, backup, setup } = require("./schedules-data-harness.cjs")
let serial = 3000
const input = extra => ({ draftId: null, scheduleId: null, baseClientUpdatedAt: null,
  remindDate: "2026-10-09", title: "草稿", content: content("未保存文字"), ...extra })
function harness(extra = {}) {
  const time = { ...loadTS("shared/time.ts"), todayLocal: () => "2026-10-08", utcNow: () => AT }
  const h = setup({ "./time": time, "@/shared/time": time,
    "@/shared/ids": { newId: () => `019a0300-1234-7000-8000-${String(++serial).padStart(12, "0")}` }, ...extra })
  return { ...h, drafts: h.load("db/scheduleDraftRepo.ts").localScheduleDraftRepo,
    schedules: h.load("db/scheduleRepo.ts").localScheduleRepo,
    backups: h.load("db/backupRepo.ts").localBackupRepo }
}
async function save(h, extra = {}) {
  const current = await h.drafts.read()
  return h.drafts.save(current.lease, input({ draftId: current.draft?.draftId ?? null, ...extra }))
}
const again = (result, extra = {}) => {
  const { updatedAt, ...payload } = result.draft
  return { ...payload, ...extra }
}
const receipt = (result, row) => ({ draftId: result.draft.draftId, scheduleId: row.id, clientUpdatedAt: row.clientUpdatedAt })
const journal = async h => (await h.db.meta.get("scheduleDraft"))?.value
const snapshot = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([name, store]) => [name, [...store.rows.values()]])))
async function existing(h, extra = {}) {
  const row = schedule(extra); await h.db.schedules.put(row)
  return save(h, { scheduleId: row.id, baseClientUpdatedAt: row.clientUpdatedAt, ...extra })
}

test("empty draft read is side-effect free and cannot create a diary or schedule", async () => {
  const h = harness(); const result = await h.drafts.read()
  assert.equal(result.status, "empty"); assert.equal(result.lease.revision, 0)
  assert.equal(h.stores.meta.rows.size, 0); assert.equal(h.stores.entries.rows.size, 0); assert.equal(h.stores.schedules.rows.size, 0)
})
test("empty text and elapsed valid dates are safely recoverable drafts, not business records", async () => {
  const h = harness(); const result = await save(h, { title: "", content: null, remindDate: "2026-10-07" })
  assert.equal(result.status, "recoverable"); assert.equal(result.lease.revision, 1)
  assert.equal((await h.drafts.read()).draft.remindDate, "2026-10-07")
  assert.equal(h.stores.entries.rows.size, 0); assert.equal(h.stores.schedules.rows.size, 0)
})
test("same-session edits increment CAS and timestamp without storing derived or credential fields", async () => {
  const h = harness(); const first = await save(h)
  const next = await h.drafts.save(first.lease, again(first, { title: "更新" }))
  assert.equal(next.draft.draftId, first.draft.draftId); assert.equal(next.lease.revision, 2)
  assert.equal(next.draft.updatedAt, "2026-10-08T10:00:00.001Z")
  for (const key of ["ownerUserId", "generation", "contentText", "token"]) assert.equal(Object.hasOwn(await journal(h), key), false)
})
test("independent writer instances cannot overwrite a concurrent draft with the same stale lease", async () => {
  const h = harness(); const context = await h.drafts.read(); const other = h.load("db/scheduleDraftRepo.ts").localScheduleDraftRepo
  const results = await Promise.allSettled([h.drafts.save(context.lease, input({ title: "A" })), other.save(context.lease, input({ title: "B" }))])
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
  assert.equal(results.filter(result => result.status === "rejected").length, 1)
  assert.equal((await journal(h)).revision, 1)
})
test("clear leaves a monotonically increasing empty marker so late saves cannot resurrect text", async () => {
  const h = harness(); const first = await save(h); const cleared = await h.drafts.clear(first.lease)
  assert.equal(cleared.revision, 2); assert.equal((await journal(h)).draft, null)
  await assert.rejects(h.drafts.save(first.lease, again(first)), /已变化/)
  const next = await h.drafts.save(cleared, input())
  assert.notEqual(next.draft.draftId, first.draft.draftId)
  await assert.rejects(h.drafts.clear(cleared), /已变化/)
  assert.equal((await h.drafts.read()).draft.draftId, next.draft.draftId)
})
test("a different session or target cannot silently replace the occupied single draft slot", async () => {
  const h = harness(); const first = await save(h); const before = snapshot(h)
  await assert.rejects(h.drafts.save(first.lease, input()), /其他预简草稿/)
  await assert.rejects(h.drafts.save(first.lease, again(first, { scheduleId: ID, baseClientUpdatedAt: AT })), /其他预简草稿/)
  assert.equal(snapshot(h), before)
})
test("invalid dates, images, unknown versions, oversized titles and diary-only fields fail before writes", async () => {
  const h = harness(); const lease = (await h.drafts.read()).lease
  for (const extra of [{ remindDate: "2026-02-29" }, { title: "长".repeat(256) },
    { content: { schemaVersion: 1, doc: { type: "doc", content: [{ type: "image" }] } } },
    { content: { schemaVersion: 9, doc: { type: "doc", content: [] } } },
    { mood: "喜" }, { tagIds: ["tag"] }, { scheduleId: ID, baseClientUpdatedAt: null }, { baseClientUpdatedAt: AT }]) {
    await assert.rejects(h.drafts.save(lease, input(extra)))
  }
  assert.equal(h.stores.meta.rows.size, 0)
})
test("cyclic content, invalid IDs and invalid leases do not reach the draft journal", async () => {
  const h = harness(); const lease = (await h.drafts.read()).lease
  const cyclic = { schemaVersion: 1, doc: { type: "doc", content: [] } }; cyclic.doc.content.push(cyclic.doc)
  await assert.rejects(h.drafts.save(lease, input({ content: cyclic })))
  await assert.rejects(h.drafts.save(lease, input({ draftId: "bad" })))
  await assert.rejects(h.drafts.save({ ...lease, revision: NaN }, input()))
  assert.equal(h.stores.meta.rows.size, 0)
})
test("a pending source change reports conflict while preserving unsaved draft text", async () => {
  const h = harness(); await existing(h)
  await h.db.schedules.update(ID, { title: "其他修改", clientUpdatedAt: "2026-10-08T11:00:00.000Z" })
  const before = await journal(h); const result = await h.drafts.read()
  assert.equal(result.status, "conflict"); assert.equal(result.draft.content.doc.content[0].content[0].text, "未保存文字")
  assert.equal(JSON.stringify(await journal(h)), JSON.stringify(before))
})
test("matching stored body reports alreadySaved but read never automatically clears the journal", async () => {
  const h = harness(); const row = schedule(); await h.db.schedules.put(row)
  const result = await save(h, { scheduleId: ID, baseClientUpdatedAt: AT, title: row.title, content: row.content })
  assert.equal(result.status, "alreadySaved"); assert.ok((await journal(h)).draft)
  assert.equal((await h.drafts.read()).status, "alreadySaved"); assert.ok((await journal(h)).draft)
})
test("missing, deleted, converted and unsupported sources retain recoverable text as unavailable", async () => {
  for (const replacement of [null, schedule({ isDeleted: 1, deletedAt: AT }), terminal(),
    schedule({ content: { schemaVersion: 9, doc: { type: "doc", content: [] } } })]) {
    const h = harness(); await existing(h)
    if (replacement) await h.db.schedules.put(replacement); else await h.db.schedules.delete(ID)
    const result = await h.drafts.read()
    assert.equal(result.status, "sourceUnavailable"); assert.equal(result.draft.title, "草稿")
    const saved = await h.drafts.save(result.lease, again(result, { title: "保留失败时新文字" }))
    assert.equal(saved.status, "sourceUnavailable"); assert.ok((await journal(h)).draft)
  }
})
test("a late successful save receipt cannot clear a newer draft revision", async () => {
  const h = harness(); const row = schedule(); await h.db.schedules.put(row)
  const first = await save(h, { scheduleId: ID, baseClientUpdatedAt: AT, title: row.title, content: row.content })
  const next = await h.drafts.save(first.lease, again(first, { title: "保存期间的新文字" }))
  const result = await h.drafts.acknowledgeSaved(first.lease, receipt(first, row))
  assert.equal(result.cleared, false); assert.equal(result.reason, "changed")
  assert.equal((await h.drafts.read()).draft.title, next.draft.title)
})
test("wrong identities and stale source receipts cannot clear a current draft", async () => {
  const h = harness(); const row = schedule(); await h.db.schedules.put(row)
  const first = await save(h, { scheduleId: ID, baseClientUpdatedAt: AT, title: row.title, content: row.content })
  for (const extra of [{ draftId: OTHER_ID }, { scheduleId: OTHER_ID }, { clientUpdatedAt: "2026-10-08T11:00:00.000Z" }]) {
    const result = await h.drafts.acknowledgeSaved(first.lease, { ...receipt(first, row), ...extra })
    assert.equal(result.cleared, false); assert.ok((await journal(h)).draft)
  }
})
test("exact persisted revision and body clear only the bound draft, without changing source dirty state", async () => {
  const h = harness(); const row = schedule(); await h.db.schedules.put(row)
  const first = await save(h, { scheduleId: ID, baseClientUpdatedAt: AT, title: row.title, content: row.content })
  const result = await h.drafts.acknowledgeSaved(first.lease, receipt(first, row))
  assert.equal(result.cleared, true); assert.equal((await journal(h)).draft, null)
  assert.equal((await h.db.schedules.get(ID)).dirty, 1)
  await assert.rejects(h.drafts.save(first.lease, again(first)), /已变化/)
})
test("new source binding preserves edits made during creation and waits for their actual persisted body", async () => {
  const h = harness(); const first = await save(h)
  const row = await h.schedules.create({ remindDate: first.draft.remindDate, title: first.draft.title, content: first.draft.content })
  const proof = receipt(first, row)
  assert.equal((await h.drafts.acknowledgeSaved(first.lease, proof)).cleared, false)
  const edited = await h.drafts.save(first.lease, again(first, { title: "创建期间又改了" }))
  const bound = await h.drafts.bindCreated(edited.lease, proof)
  assert.equal(bound.draft.scheduleId, row.id); assert.equal(bound.draft.title, "创建期间又改了")
  assert.equal((await h.drafts.acknowledgeSaved(bound.lease, proof)).cleared, false)
  const updated = await h.schedules.update(row.id, { title: bound.draft.title, content: bound.draft.content })
  assert.equal((await h.drafts.acknowledgeSaved(bound.lease, receipt(bound, updated))).cleared, true)
  assert.equal(h.stores.schedules.rows.size, 1)
})
test("old creation receipt cannot bind a cleared and newly started draft even with a fresh lease", async () => {
  const h = harness(); const first = await save(h)
  const row = await h.schedules.create({ remindDate: first.draft.remindDate, title: first.draft.title, content: first.draft.content })
  const cleared = await h.drafts.clear(first.lease); const next = await h.drafts.save(cleared, input())
  const before = snapshot(h)
  await assert.rejects(h.drafts.bindCreated(next.lease, receipt(first, row)), /不属于/)
  assert.equal(snapshot(h), before)
})
test("bound creation receipt is idempotent and cannot rebase an existing draft over another revision", async () => {
  const h = harness(); const first = await save(h)
  const row = await h.schedules.create({ remindDate: first.draft.remindDate, title: first.draft.title, content: first.draft.content })
  const bound = await h.drafts.bindCreated(first.lease, receipt(first, row))
  const before = snapshot(h); const againBound = await h.drafts.bindCreated(bound.lease, receipt(bound, row))
  assert.equal(againBound.lease.revision, bound.lease.revision); assert.equal(snapshot(h), before)
  const newer = await h.schedules.update(row.id, { title: "其他修订" })
  await assert.rejects(h.drafts.bindCreated(bound.lease, receipt(bound, newer)), /不能.*重置/)
})
test("input payload is copied before waiting for a transaction, not read from a later mutated object", async () => {
  const h = harness(); const lease = (await h.drafts.read()).lease
  const value = input(); const pending = h.drafts.save(lease, value)
  value.content.doc.content[0].content[0].text = "调用方又修改了对象"; value.title = "外部新值"
  const result = await pending
  assert.equal(result.draft.title, "草稿"); assert.equal(result.draft.content.doc.content[0].content[0].text, "未保存文字")
})
test("mutating an old lease while a queued operation waits cannot authorize writing to a new owner", async () => {
  const h = harness(); await h.db.meta.put({ key: "ownerUserId", value: "A" })
  const lease = (await h.drafts.read()).lease
  let release; let started; const gate = new Promise(resolve => { release = resolve }); const ready = new Promise(resolve => { started = resolve })
  const blocking = h.db.transaction("rw", h.db.meta, async () => {
    started(); await gate
    await h.db.meta.put({ key: "ownerUserId", value: "B" }); await h.db.meta.put({ key: "ownerGeneration", value: "fresh" })
  })
  await ready; const pending = h.drafts.save(lease, input())
  lease.ownerUserId = "B"; lease.generation = "fresh"; release(); await blocking
  await assert.rejects(pending, /旧操作/); assert.equal(await journal(h), undefined)
})
test("same-owner restore epoch invalidates save, clear and acknowledgment leases", async () => {
  const h = harness(); const first = await save(h)
  await h.db.meta.put({ key: "ownerGeneration", value: "restored" }); const before = snapshot(h)
  await assert.rejects(h.drafts.save(first.lease, again(first)), /旧操作/)
  await assert.rejects(h.drafts.clear(first.lease), /旧操作/)
  await assert.rejects(h.drafts.acknowledgeSaved(first.lease, { draftId: first.draft.draftId, scheduleId: ID, clientUpdatedAt: AT }), /旧操作/)
  assert.equal(snapshot(h), before)
})
for (const operation of ["save", "clear", "acknowledgeSaved"]) {
  test(`journal storage failure during ${operation} leaves its previous state intact`, async () => {
    const h = harness(); const row = schedule(); await h.db.schedules.put(row)
    const first = await save(h, { scheduleId: ID, baseClientUpdatedAt: AT, title: row.title, content: row.content })
    const before = snapshot(h); h.failNext("meta")
    if (operation === "save") await assert.rejects(h.drafts.save(first.lease, again(first, { title: "失败写入" })), /injected/)
    else if (operation === "clear") await assert.rejects(h.drafts.clear(first.lease), /injected/)
    else await assert.rejects(h.drafts.acknowledgeSaved(first.lease, receipt(first, row)), /injected/)
    assert.equal(snapshot(h), before)
  })
}
test("corrupt or future journal formats are preserved and block reads, writes, clears and full export", async () => {
  for (const value of ["broken", { formatVersion: 2, revision: 1, draft: null }, { formatVersion: 1, revision: -1, draft: null }, { formatVersion: 1, revision: 1 }]) {
    const h = harness(); const lease = (await h.drafts.read()).lease
    await h.db.meta.put({ key: "scheduleDraft", value }); const before = snapshot(h)
    await assert.rejects(h.drafts.read(), /草稿损坏/)
    await assert.rejects(h.drafts.save(lease, input()), /草稿损坏/)
    await assert.rejects(h.drafts.clear(lease), /草稿损坏/)
    await assert.rejects(h.backups.exportAll(), /草稿损坏/)
    assert.equal(snapshot(h), before)
  }
})
test("revision saturation fails closed rather than wrapping a cleared journal back to zero", async () => {
  const h = harness(); await h.db.meta.put({ key: "scheduleDraft", value: { formatVersion: 1, revision: Number.MAX_SAFE_INTEGER, draft: null } })
  const lease = (await h.drafts.read()).lease; const before = snapshot(h)
  await assert.rejects(h.drafts.save(lease, input()), /耗尽/); await assert.rejects(h.drafts.clear(lease), /耗尽/)
  assert.equal(snapshot(h), before)
})
test("original diary draft and new schedule draft use independent slots and keep diary image data", async () => {
  const h = harness(); const diary = h.load("db/draftRepo.ts").localDraftRepo
  const original = { entryId: null, entryDate: "2026-10-08", title: "原日记草稿", mood: "喜", weather: null,
    tagIds: ["tag"], doc: { type: "doc", content: [{ type: "image", attrs: { src: "local://media/old" } }] }, updatedAt: AT }
  await diary.save(original); const first = await save(h)
  await h.drafts.clear(first.lease)
  assert.equal(JSON.stringify(await diary.get()), JSON.stringify(original))
  const next = await save(h); await diary.clear()
  assert.equal((await h.drafts.read()).draft.draftId, next.draft.draftId)
})
test("guest claim backs up and retains the draft while rebinding subsequent leases to the rightful owner", async () => {
  let exported; let h
  h = harness({ "@/capabilities/backupFile": { downloadFullBackup: async () => { exported = await h.backups.exportAll() } } })
  const first = await save(h); const original = JSON.stringify(await journal(h))
  assert.equal((await h.load("api/claim.ts").claimLocalData("account-a")).kind, "claimed")
  assert.equal(JSON.stringify(await journal(h)), original); assert.equal(exported.scheduleDraft.title, "草稿")
  assert.equal((await h.drafts.read()).lease.ownerUserId, "account-a")
  await assert.rejects(h.drafts.save(first.lease, again(first)), /旧操作/)
})
test("owner reset exports unsaved draft first and old callbacks cannot resurrect it in the new account", async () => {
  let exported; let h
  h = harness({ "@/capabilities/backupFile": { downloadFullBackup: async () => { exported = await h.backups.exportAll() } } })
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" }); const first = await save(h)
  h.user("account-b"); await h.load("api/claim.ts").resetLocalForNewOwner("account-b")
  assert.equal(exported.scheduleDraft.title, "草稿"); assert.equal((await h.drafts.read()).status, "empty")
  await assert.rejects(h.drafts.save(first.lease, again(first)), /旧操作/)
  assert.equal((await h.drafts.read()).lease.ownerUserId, "account-b")
})
test("backup contains only business draft fields, not CAS/owner leases, and restore creates a fresh session", async () => {
  const h = harness(); const first = await save(h); const file = await h.backups.exportAll()
  assert.equal(file.formatVersion, 3); assert.equal(file.scheduleDraft.title, "草稿")
  for (const key of ["revision", "ownerUserId", "generation", "lease", "formatVersion"]) assert.equal(Object.hasOwn(file.scheduleDraft, key), false)
  const restored = harness(); const report = await restored.backups.importAll(file)
  assert.equal(report.scheduleDraftRestored, 1)
  const read = await restored.drafts.read(); assert.equal(read.status, "recoverable")
  assert.notEqual(read.draft.draftId, first.draft.draftId); assert.equal(read.draft.content.doc.content[0].content[0].text, "未保存文字")
})
test("old v3 without draft and v1/v2 remain compatible; damaged drafts fail before all writes", async () => {
  const h = harness(); const first = await save(h); const file = await h.backups.exportAll()
  const contract = loadTS("shared/backup.ts")
  const oldV3 = structuredClone(file); delete oldV3.scheduleDraft
  assert.equal(contract.checkBackup(oldV3).ok, true)
  for (const version of [1, 2]) {
    const old = backup({ formatVersion: version }); delete old.schedules; delete old.scheduleConversions
    assert.equal(contract.checkBackup(old).ok, true)
    old.scheduleDraft = first.draft; assert.equal(contract.checkBackup(old).ok, false)
  }
  for (const extra of [{ content: { schemaVersion: 9, doc: { type: "doc", content: [] } } }, { updatedAt: "bad" }, { mood: "喜" }]) {
    const bad = structuredClone(file); Object.assign(bad.scheduleDraft, extra)
    const before = snapshot(h); await assert.rejects(h.backups.importAll(bad), /草稿/); assert.equal(snapshot(h), before)
  }
})
test("repeat import or any conflict policy keeps an occupied local draft rather than timestamp overwriting it", async () => {
  const source = harness(); await save(source, { title: "备份草稿" }); const file = await source.backups.exportAll()
  for (const policy of ["preferNewer", "keepLocal", "asCopy"]) {
    const h = harness(); await save(h, { title: "本机草稿" }); const old = JSON.stringify(await journal(h))
    const report = await h.backups.importAll(file, policy)
    assert.equal(report.scheduleDraftSkipped, 1); assert.equal(report.scheduleDraftRestored, 0)
    assert.equal(JSON.stringify(await journal(h)), old)
  }
})
test("asCopy remaps an existing source relationship but never invents one when the source is missing", async () => {
  const source = harness(); await existing(source)
  const file = await source.backups.exportAll()
  const restored = harness(); const report = await restored.backups.importAll(file, "asCopy")
  const read = await restored.drafts.read(); assert.equal(report.scheduleDraftDetached, 0)
  assert.notEqual(read.draft.scheduleId, ID); assert.ok(await restored.db.schedules.get(read.draft.scheduleId))
  const missing = structuredClone(file); missing.schedules = []; missing.counts.schedules = 0
  const detached = harness(); const detachedReport = await detached.backups.importAll(missing, "asCopy")
  assert.equal(detachedReport.scheduleDraftDetached, 1)
  const recovered = await detached.drafts.read(); assert.equal(recovered.draft.scheduleId, null)
  assert.equal(recovered.draft.baseClientUpdatedAt, null); assert.equal(recovered.draft.title, "草稿")
})
test("asCopy of a skipped too-new source detaches the supported draft for explicit review", async () => {
  const source = harness(); await existing(source); const file = await source.backups.exportAll()
  file.schedules[0].content = { schemaVersion: 9, doc: { type: "doc", content: [] } }
  const restored = harness(); const report = await restored.backups.importAll(file, "asCopy")
  assert.equal(report.schedulesTooNew, 1); assert.equal(report.scheduleDraftDetached, 1)
  assert.equal((await restored.drafts.read()).draft.scheduleId, null); assert.equal(restored.stores.schedules.rows.size, 0)
})
test("restore preserves an unknown local journal instead of replacing it with the backup draft", async () => {
  const source = harness(); await save(source); const file = await source.backups.exportAll()
  const h = harness(); const unknown = { formatVersion: 2, raw: "未来格式的重要文字" }
  await h.db.meta.put({ key: "scheduleDraft", value: unknown })
  assert.equal((await h.backups.importAll(file)).scheduleDraftSkipped, 1)
  assert.equal(JSON.stringify(await journal(h)), JSON.stringify(unknown))
})
test("failure writing restored draft rolls back schedules and the whole import transaction", async () => {
  const source = harness(); await existing(source); const file = await source.backups.exportAll()
  const h = harness(); const before = snapshot(h); const put = h.db.meta.put.bind(h.db.meta)
  h.db.meta.put = async row => { if (row.key === "scheduleDraft") throw new Error("draft quota failed"); return put(row) }
  await assert.rejects(h.backups.importAll(file), /draft quota/); assert.equal(snapshot(h), before)
})
test("a corrupt draft blocks the forced full backup, so account reset cannot clear its original text", async () => {
  let h; h = harness({ "@/capabilities/backupFile": { downloadFullBackup: async () => h.backups.exportAll() } })
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "scheduleDraft", value: { formatVersion: 2, text: "未识别的重要草稿" } })
  const before = snapshot(h); h.user("account-b")
  await assert.rejects(h.load("api/claim.ts").resetLocalForNewOwner("account-b"), /草稿损坏/)
  assert.equal(snapshot(h), before)
})
test("creation receipt is copied before waiting and cannot be retargeted by caller mutation", async () => {
  const h = harness(); const first = await save(h)
  const row = await h.schedules.create({ remindDate: first.draft.remindDate, title: first.draft.title, content: first.draft.content })
  const other = await h.schedules.create({ remindDate: "2026-10-10", title: "另一个来源" })
  const proof = receipt(first, row); const pending = h.drafts.bindCreated(first.lease, proof)
  proof.scheduleId = other.id; proof.clientUpdatedAt = other.clientUpdatedAt
  const bound = await pending; assert.equal(bound.draft.scheduleId, row.id)
})
test("actual restore with no backup draft preserves the local journal and invalidates late acknowledgments", async () => {
  const h = harness(); const row = schedule(); await h.db.schedules.put(row)
  const first = await save(h, { scheduleId: ID, baseClientUpdatedAt: AT, title: row.title, content: row.content })
  const before = JSON.stringify(await journal(h))
  const report = await h.backups.importAll(backup())
  assert.equal(report.scheduleDraftRestored, 0); assert.equal(JSON.stringify(await journal(h)), before)
  await assert.rejects(h.drafts.acknowledgeSaved(first.lease, receipt(first, row)), /旧操作/)
  assert.ok((await h.drafts.read()).draft)
})
test("full export refuses a stale draft snapshot if a journal save occurs while media is encoded", async () => {
  const h = harness(); const first = await save(h)
  await h.db.media.put({ id: "draft-export-photo", entryId: "", blob: new Blob([new Uint8Array([1])], { type: "image/png" }),
    thumbBlob: null, mime: "image/png", size: 1, width: 1, height: 1, sortOrder: 0, remoteUrl: "", createdAt: AT, dirty: 1 })
  let changed
  await assert.rejects(h.backups.exportAll(() => {
    changed = h.drafts.save(first.lease, again(first, { title: "编码时新增文字" }))
  }), /备份期间.*草稿已变化/)
  await changed; assert.equal((await h.drafts.read()).draft.title, "编码时新增文字")
})
for (const action of ["claim", "reset"]) {
  test(`draft changes after full backup stop ${action} before ownership or data are changed`, async () => {
    let h; let first
    h = harness({ "@/capabilities/backupFile": { downloadFullBackup: async () => {
      await h.backups.exportAll()
      await h.drafts.save(first.lease, again(first, { title: "下载后新增文字" }))
    } } })
    if (action === "reset") await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
    first = await save(h)
    if (action === "reset") h.user("account-b")
    const api = h.load("api/claim.ts")
    const task = action === "claim" ? api.claimLocalData("account-a") : api.resetLocalForNewOwner("account-b")
    await assert.rejects(task, /备份期间.*草稿已变化/)
    assert.equal((await h.drafts.read()).draft.title, "下载后新增文字")
    assert.equal((await h.db.meta.get("ownerUserId"))?.value ?? "", action === "reset" ? "account-a" : "")
  })
}
