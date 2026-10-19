const { test } = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path")
const { ID, OTHER_ID, AT, terminal, entry, intent, setup } = require("./schedules-data-harness.cjs")
const TAG = "019a0300-1234-7000-8000-000000000003", SECOND = "019a0300-1234-7000-8000-000000000004"
const SERVER = "2026-10-08T10:00:02.000Z"
const png = tail => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, tail])
const localBytes = png(1), cloudBytes = png(2), localThumb = png(3), cloudThumb = png(4)
const sha = b => crypto.createHash("sha256").update(b).digest("hex")
const blob = b => new Blob([b], { type: "image/png" })
const content = id => ({ schemaVersion: 1, doc: { type: "doc", content: [{ type: "image", attrs: { src: `local://media/${id}` } }] } })
function sourceWire(r) { return { id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER } }
function entryWire(r) { return { id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:SERVER } }
const all = h => JSON.stringify(Object.fromEntries(Object.entries(h.stores).map(([key, value]) => [key, [...value.rows.values()]])))
function handle(options = {}) {
  let text = options.existing ?? "", closed = false, aborted = false
  return { get text() { return text }, get closed() { return closed }, get aborted() { return aborted },
    async getFile() { return { size: new Blob([text]).size, async text() { return options.corrupt && closed ? text + "!" : text } } },
    async createWritable(config) { assert.equal(config.mode, "exclusive"); assert.equal(config.keepExistingData, false); return {
      async write(value) { if (options.writeFail) throw Error("disk"); text = value },
      async close() { if (options.closeFail) throw Error("disk"); closed = true; await options.onClose?.() },
      async abort() { aborted = true },
    } },
  }
}
async function fixture(options = {}) {
  const h = setup({}, { crypto: crypto.webcrypto, AbortController }); h.mocks["@/api/tokenStore"] = h.tokens
  h.calls = []; h.imageCalls = []
  await h.db.meta.put({ key: "ownerUserId", value: "account-a" })
  await h.db.meta.put({ key: "ownerGeneration", value: "epoch" })
  const current = entry({ content: content(OTHER_ID), tagIds: [TAG] })
  const remote = entry({ content: content(OTHER_ID), tagIds: [TAG], title: "云端日记" })
  await h.db.schedules.put(terminal()); await h.db.entries.put(current)
  await h.db.tags.put({ id: TAG, name: "本机标签", color: "green", createdAt: AT, dirty: 0 })
  await h.db.media.put({ id: OTHER_ID, entryId: ID, blob: blob(localBytes), thumbBlob: options.noThumb ? null : blob(localThumb),
    mime: "image/png", width: 2, height: 1, size: localBytes.length, sortOrder: 0, createdAt: AT, dirty: 0,
    remoteUrl: "https://private/original", thumbRemoteUrl: options.noThumb ? "" : "https://private/thumb" })
  await h.db.meta.put({ key: "scheduleConversions", value: [intent({ ownerUserId: "account-a" })] })
  await h.db.meta.put({ key: "scheduleConflicts", value: [{ scheduleId: ID, kind: "conversion-entry", localEntry: current, serverEntry: remote }] })
  h.reply = { read_only:true,resolution_enabled:false,proof_scope:"current_entry_resources",resource_state:"verified",resources_complete:true,
    review:{read_only:true,reviewable:true,reason:"terminal_review",receipt_known:true,first_entry_date:"2026-10-07",first_entry_deleted:false,schedule:sourceWire(terminal()),entry:entryWire(remote),entry_state:"active"},media_ids:[OTHER_ID],tag_ids:[TAG],
    media:[{id:OTHER_ID,entry_id:ID,sort_order:0,width:2,height:1,size:cloudBytes.length,created_at:SERVER,original:{state:"verified",size:cloudBytes.length,sha256:sha(cloudBytes),mime:"image/png"},thumbnail:options.noThumb?{state:"not_present",size:null,sha256:null,mime:null}:{state:"verified",size:cloudThumb.length,sha256:sha(cloudThumb),mime:"image/png"}}],
    tags:[{id:TAG,name:"云端标签",color:"blue",created_at:SERVER}],missing_media_ids:[],missing_tag_ids:[] }
  h.transport = {
    async review(id, lease) { h.calls.push({ id, lease }); await options.onReview?.(h, h.calls.length); return h.reply },
    async image(id, mediaId, variant, proof, lease, signal) {
      h.imageCalls.push({ id, mediaId, variant, proof, lease, signal }); await options.onImage?.(h, h.imageCalls.length)
      const bytes = variant === "original" ? cloudBytes : cloudThumb
      const wire = { read_only: true, resolution_enabled: false, proof_scope: "current_entry_image_bytes",
        schedule_id: id, media_id: mediaId, variant, size: bytes.length, mime: "image/png", sha256: sha(bytes), data_base64: bytes.toString("base64") }
      options.mutateImage?.(wire); return wire
    },
  }
  h.exporter = h.load("db/scheduleDualResourceEvidenceRepo.ts").createInternalDualResourceEvidenceExporter(h.transport)
  h.io = h.load("io/scheduleDualResourceEvidenceFile.ts")
  h.codec = h.load("shared/scheduleDualResourceEvidence.ts")
  return h
}
test("constructing or declining download is inert; confirmation is explicit", async () => {
  const h = await fixture(), before = all(h)
  assert.equal((await h.exporter.prepare(ID, false)).reason, "explicit_download_required")
  assert.equal(h.calls.length, 0); assert.equal(h.imageCalls.length, 0); assert.equal(all(h), before)
})
test("different original, thumbnail and shared tag versions are saved and re-read without touching business data", async () => {
  const h = await fixture(), before = all(h), first = (await h.db.meta.get("scheduleConversions")).value
  const ready = await h.exporter.prepare(ID, true)
  assert.equal(ready.ready, true); assert.deepEqual([...ready.differentMediaIds], [OTHER_ID]); assert.deepEqual([...ready.differentTagIds], [TAG])
  assert.equal(ready.resolutionEnabled, false); assert.equal(h.calls.length, 2)
  assert.deepEqual(h.imageCalls.map(call => call.variant), ["original", "thumbnail"])
  for (const call of h.imageCalls) assert.equal(call.lease.ownerUserId, "account-a")
  const file = handle(), done = await h.exporter.save(ready.reviewId, true, file)
  assert.equal(done.saved, true); assert.equal(file.closed, true); assert.equal(h.calls.length, 4)
  const value = await h.io.readDualResourceEvidenceFile(await file.getFile())
  assert.equal(value.local.media[0].blobBase64, localBytes.toString("base64"))
  assert.equal(value.local.media[0].thumbBase64, localThumb.toString("base64"))
  assert.equal(value.cloudMedia[0].blobBase64, cloudBytes.toString("base64"))
  assert.equal(value.cloudMedia[0].thumbBase64, cloudThumb.toString("base64"))
  assert.equal(value.local.tags[0].name, "本机标签"); assert.equal(value.cloud.tags[0].name, "云端标签")
  for (const forbidden of ["ownerUserId", "tokenGeneration", '"generation"', "https://private"]) assert.equal(file.text.includes(forbidden), false)
  assert.equal(all(h), before); assert.deepEqual((await h.db.meta.get("scheduleConversions")).value, first)
  assert.deepEqual(Buffer.from(await (await h.db.media.get(OTHER_ID)).blob.arrayBuffer()), localBytes)
  assert.ok((await h.load("db/scheduleStateRepo.ts").protectedConversions()).entryIds.has(ID))
  assert.equal((await h.exporter.save(ready.reviewId, true, handle())).saved, false)
})
test("no thumbnail is downloaded or invented when absent in the current cloud proof", async () => {
  const h = await fixture({ noThumb: true }), r = await h.exporter.prepare(ID, true), file = handle()
  assert.equal(r.ready, true); assert.deepEqual(h.imageCalls.map(c => c.variant), ["original"])
  assert.equal((await h.exporter.save(r.reviewId, true, file)).saved, true)
  assert.equal((await h.io.readDualResourceEvidenceFile(await file.getFile())).cloudMedia[0].thumbBase64, null)
})
test("different resource IDs are both retained rather than remapped or overwritten", async () => {
  const h = await fixture(); h.reply.media_ids = [SECOND]; h.reply.media[0].id = SECOND
  h.reply.review.entry.content = content(SECOND)
  const r = await h.exporter.prepare(ID, true), file = handle()
  assert.equal(r.ready, true); assert.deepEqual([...r.differentMediaIds], [OTHER_ID, SECOND])
  assert.equal((await h.exporter.save(r.reviewId, true, file)).saved, true)
  const value = await h.io.readDualResourceEvidenceFile(await file.getFile())
  assert.equal(value.local.media[0].id, OTHER_ID); assert.equal(value.cloudMedia[0].id, SECOND)
  assert.equal(await h.db.media.get(SECOND), undefined)
})
for (const mode of ["unknown-receipt", "deleted-source", "deleted-entry", "purged-entry", "missing-local", "missing-cloud", "pending-purge", "draft"]) test(`unsupported ${mode} cannot start image downloads`, async () => {
  const h = await fixture()
  if (mode === "unknown-receipt") Object.assign(h.reply.review, { reviewable: false, receipt_known: false, reason: "receipt_unknown", first_entry_date: null, first_entry_deleted: null })
  if (mode === "deleted-source") { h.reply.review.schedule.deleted_at = AT }
  if (mode === "deleted-entry") { h.reply.review.entry.deleted_at = AT; h.reply.review.entry_state = "deleted" }
  if (mode === "purged-entry") { h.reply.review.entry = null; h.reply.review.entry_state = "purged"; h.reply.media_ids = []; h.reply.tag_ids = []; h.reply.media = []; h.reply.tags = []; h.reply.resource_state = "no_entry"; h.reply.resources_complete = false }
  if (mode === "missing-local") await h.db.media.delete(OTHER_ID)
  if (mode === "missing-cloud") { h.reply.media[0].original = { state: "missing", size: null, mime: null, sha256: null }; h.reply.resources_complete = false; h.reply.resource_state = "incomplete" }
  if (mode === "pending-purge") await h.db.meta.put({ key: "pendingPurges", value: [ID] })
  if (mode === "draft") await h.db.meta.put({ key: "draft", value: { text: "keep" } })
  const before = all(h)
  assert.equal((await h.exporter.prepare(ID, true)).ready, false); assert.equal(h.imageCalls.length, 0); assert.equal(all(h), before)
})
for (const field of ["schedule_id", "media_id", "variant", "mime", "sha256", "size", "data_base64", "extra"]) test(`malformed downloaded ${field} rejects the whole package`, async () => {
  const h = await fixture({ mutateImage: row => { row[field] = field === "data_base64" ? localBytes.toString("base64") : "wrong" } }), before = all(h)
  assert.equal((await h.exporter.prepare(ID, true)).ready, false); assert.equal(all(h), before)
  assert.equal((await h.exporter.save(1, true, handle())).saved, false)
})
for (const mode of ["account", "relogin", "epoch", "bytes", "tag", "candidate", "proof", "cancel"]) test(`download boundary ${mode} invalidates the complete capture`, async () => {
  const h = await fixture({ onImage: async (state, n) => {
    if (n !== 1) return
    if (mode === "account") state.user("account-b")
    if (mode === "relogin") { state.user("account-b"); state.user("account-a") }
    if (mode === "epoch") await state.db.meta.put({ key: "ownerGeneration", value: "new epoch" })
    if (mode === "bytes") await state.db.media.update(OTHER_ID, { blob: blob(png(9)) })
    if (mode === "tag") await state.db.tags.update(TAG, { name: "changed" })
    if (mode === "candidate") await state.db.meta.put({ key: "scheduleConflicts", value: [] })
    if (mode === "proof") state.reply.media[0].original.sha256 = sha(png(9))
    if (mode === "cancel") state.exporter.cancel()
  } })
  assert.equal((await h.exporter.prepare(ID, true)).ready, false)
  assert.equal((await h.db.meta.get("scheduleConversions")).value.length, 1)
  if (["account", "relogin", "epoch", "cancel"].includes(mode)) assert.equal(h.imageCalls.length, 1)
})
for (const mode of ["confirm", "review-id", "file"]) test(`saving requires explicit ${mode}`, async () => {
  const h = await fixture(), r = await h.exporter.prepare(ID, true), before = all(h), calls = h.calls.length
  assert.equal((await h.exporter.save(mode === "review-id" ? r.reviewId + 1 : r.reviewId, mode !== "confirm", mode === "file" ? undefined : handle())).saved, false)
  assert.equal(h.calls.length, calls); assert.equal(all(h), before)
})
for (const mode of ["existing", "writeFail", "closeFail", "corrupt"]) test(`file ${mode} never counts as preservation or releases protection`, async () => {
  const h = await fixture(), r = await h.exporter.prepare(ID, true), before = all(h)
  const file = handle(mode === "existing" ? { existing: "keep old file" } : { [mode]: true })
  assert.equal((await h.exporter.save(r.reviewId, true, file)).saved, false)
  assert.equal(all(h), before)
  if (mode === "existing") assert.equal(file.text, "keep old file")
})
for (const mode of ["account", "epoch", "bytes", "tag", "proof", "cancel"]) test(`change during file close (${mode}) retains the saved evidence but cannot report a current package`, async () => {
  const h = await fixture(), r = await h.exporter.prepare(ID, true)
  const file = handle({ onClose: async () => {
    if (mode === "account") h.user("account-b")
    if (mode === "epoch") await h.db.meta.put({ key: "ownerGeneration", value: "changed" })
    if (mode === "bytes") await h.db.media.update(OTHER_ID, { blob: blob(png(9)) })
    if (mode === "tag") await h.db.tags.update(TAG, { name: "changed" })
    if (mode === "proof") h.reply.tags[0].name = "changed"
    if (mode === "cancel") h.exporter.cancel()
  } })
  const result = await h.exporter.save(r.reviewId, true, file)
  assert.equal(result.saved, false); assert.equal(result.reason, ["account", "epoch"].includes(mode) ? "dual_resource_file_unconfirmed" : mode === "cancel" ? "cancelled_recheck" : "file_saved_but_state_changed_recheck")
  assert.equal(result.fileMayExist, true); assert.equal(file.closed, true)
  assert.equal((await h.io.readDualResourceEvidenceFile(await file.getFile())).resolutionEnabled, false)
  assert.equal((await h.db.meta.get("scheduleConversions")).value.length, 1)
})
for (const mode of ["cloud-original", "cloud-thumb", "unknown-field", "truncated-media", "duplicate-media", "wrong-source", "enable-resolution", "bad-meaning", "metadata"]) test(`offline read rejects ${mode} without downgrade to local evidence`, async () => {
  const h = await fixture(), r = await h.exporter.prepare(ID, true), file = handle()
  await h.exporter.save(r.reviewId, true, file)
  const value = JSON.parse(file.text)
  if (mode === "cloud-original") value.cloudMedia[0].blobBase64 = localBytes.toString("base64")
  if (mode === "cloud-thumb") value.cloudMedia[0].thumbBase64 = localThumb.toString("base64")
  if (mode === "unknown-field") value.token = "never accept"
  if (mode === "truncated-media") value.cloudMedia = []
  if (mode === "duplicate-media") value.cloudMedia.push(value.cloudMedia[0])
  if (mode === "wrong-source") value.scheduleId = SECOND
  if (mode === "enable-resolution") value.resolutionEnabled = true
  if (mode === "bad-meaning") value.meaning = "restore"
  if (mode === "metadata") value.cloudMedia[0].sortOrder = 99
  const text = JSON.stringify(value), read = { size: new Blob([text]).size, text: async () => text }
  await assert.rejects(h.io.readDualResourceEvidenceFile(read))
  await assert.rejects(h.load("io/scheduleResourceRepairFile.ts").readResourceRepairDocument(read, ID), /不支持/)
})
test("real temporary filesystem close/read round-trip preserves both image versions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quire-dual-evidence-"))
  try {
    const target = path.join(dir, "both.json"); await fs.writeFile(target, "")
    const file = { async getFile() { const data = await fs.readFile(target); return { size: data.length, text: async () => data.toString("utf8") } },
      async createWritable() { let pending = ""; return { async write(text) { pending = text }, async close() { await fs.writeFile(target, pending) }, async abort() {} } } }
    const h = await fixture(), r = await h.exporter.prepare(ID, true)
    assert.equal((await h.exporter.save(r.reviewId, true, file)).saved, true)
    const value = await h.io.readDualResourceEvidenceFile(await file.getFile())
    assert.equal(value.cloudMedia[0].blobBase64, cloudBytes.toString("base64"))
    assert.equal(value.local.media[0].blobBase64, localBytes.toString("base64"))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test("cancelling while file preflight awaits prevents later writer creation", async () => {
  const h = await fixture(), r = await h.exporter.prepare(ID, true)
  let writes = 0
  const file = { async getFile() { h.exporter.cancel(); return { size: 0, text: async () => "" } },
    async createWritable() { writes++; throw Error("must not create") } }
  const done = await h.exporter.save(r.reviewId, true, file)
  assert.equal(done.saved, false); assert.equal(writes, 0)
})
test("cancelling during a write aborts without proceeding to close", async () => {
  const h = await fixture(), r = await h.exporter.prepare(ID, true)
  let closed = 0, aborted = 0
  const file = { async getFile() { return { size: 0, text: async () => "" } },
    async createWritable() { return { async write() { h.exporter.cancel() },
      async close() { closed++ }, async abort() { aborted++ } } } }
  assert.equal((await h.exporter.save(r.reviewId, true, file)).saved, false)
  assert.equal(closed, 0); assert.equal(aborted, 1)
})
test("capture is single flight and cancellation cannot resurrect the ticket", async () => {
  let release, started
  const wait = new Promise(resolve => { release = resolve }), start = new Promise(resolve => { started = resolve })
  const h = await fixture({ onImage: async (_, n) => { if (n === 1) { started(); await wait } } })
  const pending = h.exporter.prepare(ID, true); await start
  assert.equal((await h.exporter.prepare(ID, true)).reason, "busy")
  assert.equal((await h.exporter.save(1, true, handle())).reason, "busy")
  h.exporter.cancel(); release()
  assert.equal((await pending).ready, false)
  assert.equal(h.imageCalls[0].signal.aborted, true)
  assert.equal((await h.exporter.save(1, true, handle())).saved, false)
})
test("identical bytes and label definitions produce no false difference", async () => {
  const h = await fixture({ mutateImage: row => {
    const bytes = row.variant === "original" ? localBytes : localThumb
    row.sha256 = sha(bytes); row.data_base64 = bytes.toString("base64")
  } })
  h.reply.media[0].original.sha256 = sha(localBytes); h.reply.media[0].thumbnail.sha256 = sha(localThumb)
  h.reply.tags[0].name = "本机标签"; h.reply.tags[0].color = "green"
  const r = await h.exporter.prepare(ID, true)
  assert.equal(r.ready, true); assert.equal(r.differentMediaIds.length, 0); assert.equal(r.differentTagIds.length, 0)
})
test("a text-only current cloud version does not remove historical local images or tags", async () => {
  const h = await fixture(); h.reply.review.entry.content = null; h.reply.review.entry.content_text = ""
  h.reply.review.entry.tag_ids = []; h.reply.media_ids = []; h.reply.tag_ids = []; h.reply.media = []; h.reply.tags = []
  const r = await h.exporter.prepare(ID, true), file = handle()
  assert.equal(r.ready, true); assert.equal(r.cloudMediaCount, 0); assert.equal(h.imageCalls.length, 0)
  assert.equal((await h.exporter.save(r.reviewId, true, file)).saved, true)
  const value = await h.io.readDualResourceEvidenceFile(await file.getFile())
  assert.equal(value.local.media.length, 1); assert.equal(value.cloudMedia.length, 0)
  assert.ok(await h.db.media.get(OTHER_ID)); assert.ok(await h.db.tags.get(TAG))
})
test("a cloud-absent thumbnail never erases an existing local thumbnail in the saved evidence", async () => {
  const h = await fixture(); h.reply.media[0].thumbnail = { state: "not_present", size: null, mime: null, sha256: null }
  const r = await h.exporter.prepare(ID, true), file = handle()
  assert.equal(r.ready, true); assert.equal(h.imageCalls.length, 1)
  assert.equal((await h.exporter.save(r.reviewId, true, file)).saved, true)
  const value = await h.io.readDualResourceEvidenceFile(await file.getFile())
  assert.equal(value.local.media[0].thumbBase64, localThumb.toString("base64")); assert.equal(value.cloudMedia[0].thumbBase64, null)
})
test("aggregate cloud binary budget is rejected before the first image GET", async () => {
  const h = await fixture(), proof = h.reply.media[0]
  h.reply.media_ids.push(SECOND)
  h.reply.review.entry.content.doc.content.push({ type: "image", attrs: { src: `local://media/${SECOND}` } })
  proof.size = proof.original.size = 10 * 1024 * 1024
  h.reply.media.push({ ...structuredClone(proof), id: SECOND })
  assert.equal((await h.exporter.prepare(ID, true)).ready, false); assert.equal(h.imageCalls.length, 0)
})
test("oversized evidence file is not physically read", async () => {
  const h = await fixture(); let reads = 0
  await assert.rejects(h.io.readDualResourceEvidenceFile({ size: 64 * 1024 * 1024 + 1,
    async text() { reads++; return "" } }))
  assert.equal(reads, 0)
})
test("changed cloud proof before file saving creates no writer", async () => {
  const h = await fixture(), r = await h.exporter.prepare(ID, true)
  h.reply.tags[0].name = "changed after prepare"
  let writes = 0
  assert.equal((await h.exporter.save(r.reviewId, true, { async getFile() { return { size: 0, text: async () => "" } },
    async createWritable() { writes++; throw Error("must not write") } })).saved, false)
  assert.equal(writes, 0)
})
