import { db } from "@/db/schema"
import { createInternalScheduleResourceConflictResolver } from "@/db/scheduleResourceConflictRepo"
import { SCHEDULE_RESOURCE_REPAIRS } from "@/db/scheduleResourceRepairRepo"
import { assertScheduleLease, SCHEDULE_SERVER_STATE_PREFIX } from "@/db/scheduleSyncStateRepo"
import { inspectResourceRepairBlob, readResourceRepairDocument } from "@/io/scheduleResourceRepairFile"
import { readScheduleResourceConflictFile } from "@/io/scheduleResourceConflictFile"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { parseScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { chosenResourceEntry } from "@/shared/scheduleResourceConflict"
import type { ScheduleResourceConflictEvidence } from "@/shared/scheduleResourceConflict"
import type { ResourceConflictPanelPort } from "@/shared/scheduleResourceConflictPanel"
import { conversionCanonical, conversionUtc } from "@/shared/scheduleConversionSync"
import { toPlainText } from "@/shared/text"
import { RESOURCE_ACCEPTANCE_DB_NAME, RESOURCE_ACCEPTANCE_MARKER, isResourceAcceptanceMarker } from "./guard"
import type { ResourceAcceptanceSpec } from "./guard"
import { assertResourceIdentity, RESOURCE_DEMO_OWNER } from "./identity"
import { inspectResourceAcceptance } from "./runtime"
import { createResourceAcceptanceBarrier } from "./barrier"
import type { ResourceAcceptancePause } from "./barrier"
import { RESOURCE_SOURCE_ID, RESOURCE_MEDIA_ID, RESOURCE_EPOCH, RESOURCE_FIXTURE_KEY, RESOURCE_PNG, resourceFixtureRows, resourceFixtureMaterial, resourceFixtureProof, resourceResolutionProof } from "./model"
const same = (a: unknown, b: unknown) => conversionCanonical(a) === conversionCanonical(b)
function guard(spec: ResourceAcceptanceSpec) {
  assertResourceIdentity(spec)
  if (db.name !== RESOURCE_ACCEPTANCE_DB_NAME) throw new Error("非专用资源验收库")
}
function memoryFile(value: unknown) { const text = JSON.stringify(value); return { size: new Blob([text]).size, text: async () => text } }
function fixtureEvidence(value: ScheduleResourceConflictEvidence, wire: unknown) {
  const expected = JSON.parse(resourceFixtureMaterial())
  if (value.scheduleId !== RESOURCE_SOURCE_ID || !same(value.cloud, wire) || !same({ ...value.local, exportedAt: expected.exportedAt }, expected)) throw new Error("不是本页当前双方夹具证据")
}
async function validateFixtureRepairArchive(repairs: unknown) {
  if (!Array.isArray(repairs) || repairs.length !== 1) throw new Error("补齐留档不完整")
  const repair = repairs[0], full = JSON.parse(resourceFixtureMaterial())
  const before = { ...full, exportedAt: repair?.before?.exportedAt, media: [], missingMediaIds: [RESOURCE_MEDIA_ID], completeLocalResources: false }
  const document = await readResourceRepairDocument(memoryFile(repair?.fileEvidence), RESOURCE_SOURCE_ID)
  if (!repair || Object.keys(repair).sort().join() !== ["ownerUserId", "generation", "scheduleId", "kind", "at", "steps", "before", "cloud", "fileFormat", "fileFingerprint", "fileEvidence", "meaning"].sort().join() ||
      repair.ownerUserId !== RESOURCE_DEMO_OWNER || repair.generation !== RESOURCE_EPOCH || repair.scheduleId !== RESOURCE_SOURCE_ID || repair.kind !== "missing-resource-from-evidence" || repair.meaning !== "bytes_repaired_protection_unchanged" ||
      conversionUtc(repair.at) !== repair.at || !same(repair.before, before) || !same(repair.cloud, await resourceFixtureProof()) || !same(repair.fileEvidence, full) || repair.fileFormat !== document.document.format || repair.fileFingerprint !== document.fingerprint ||
      !same(repair.steps, [{ mediaId: RESOURCE_MEDIA_ID, createRow: true, fillOriginal: true, fillThumbnail: true }])) throw new Error("补齐留档与原夹具不同")
}
async function resolvedSnapshot(spec: ResourceAcceptanceSpec) {
  guard(spec)
  const raw = await db.transaction("r", db.entries, db.schedules, db.media, db.tags, db.meta, async () => {
    guard(spec)
    return { entries: await db.entries.toArray(), sources: await db.schedules.toArray(), media: await db.media.toArray(), tags: await db.tags.toArray(), metadata: await db.meta.toArray() }
  })
  const metadata = new Map(raw.metadata.map(row => [row.key, row.value] as const)), baseKey = SCHEDULE_SERVER_STATE_PREFIX + RESOURCE_SOURCE_ID
  const allowed = [RESOURCE_ACCEPTANCE_MARKER, "ownerUserId", "ownerGeneration", "scheduleConversions", "scheduleConflicts", RESOURCE_FIXTURE_KEY, SCHEDULE_RESOURCE_REPAIRS, SCHEDULE_CONFLICT_ARCHIVE, baseKey]
  if (raw.metadata.length !== allowed.length || raw.metadata.some(row => !allowed.includes(row.key)) ||
      !isResourceAcceptanceMarker(metadata.get(RESOURCE_ACCEPTANCE_MARKER), spec) || metadata.get("ownerUserId") !== RESOURCE_DEMO_OWNER || metadata.get("ownerGeneration") !== RESOURCE_EPOCH ||
      !same(metadata.get("scheduleConversions"), []) || !same(metadata.get("scheduleConflicts"), []) || !same(metadata.get(RESOURCE_FIXTURE_KEY), { kind: "quire-p4-resource-fixture/v1", sourceId: RESOURCE_SOURCE_ID, mediaId: RESOURCE_MEDIA_ID })) throw new Error("交接后元信息不匹配，未接管")
  const archive = metadata.get(SCHEDULE_CONFLICT_ARCHIVE)
  if (!Array.isArray(archive) || archive.length !== 1) throw new Error("不是单次明确交接留档")
  const record = archive[0]
  if (!record || Object.keys(record).sort().join() !== ["ownerUserId", "generation", "scheduleId", "kind", "choice", "evidence", "result"].sort().join() ||
      record.ownerUserId !== RESOURCE_DEMO_OWNER || record.generation !== RESOURCE_EPOCH || record.scheduleId !== RESOURCE_SOURCE_ID || record.kind !== "terminal-matched-resource-resolution") throw new Error("未知交接留档")
  const evidence = await readScheduleResourceConflictFile(memoryFile(record.evidence)), wire = await resourceResolutionProof()
  fixtureEvidence(evidence, wire)
  const cloud = parseScheduleCloudResourceReview(wire, RESOURCE_SOURCE_ID), chosen = chosenResourceEntry(evidence.local, cloud, evidence.choice, evidence.exportedAt)
  if (record.choice !== evidence.choice || !same(record.result, chosen) || !same(raw.sources, [{ ...cloud.review.schedule!, contentText: toPlainText(cloud.review.schedule!.content), dirty: 0 }]) ||
      !same(raw.entries, [{ ...chosen, contentText: toPlainText(chosen.content) }]) || raw.tags.length || !same(metadata.get(baseKey), { ownerUserId: RESOURCE_DEMO_OWNER, generation: RESOURCE_EPOCH, source: cloud.review.schedule })) throw new Error("交接内容或基线不同")
  await validateFixtureRepairArchive(metadata.get(SCHEDULE_RESOURCE_REPAIRS))
  if (raw.media.length !== 1) throw new Error("媒体行不同")
  const row = raw.media[0]!, { blob, thumbBlob, ...meta } = row
  const expectedMedia = { id: RESOURCE_MEDIA_ID, entryId: RESOURCE_SOURCE_ID, mime: "image/png", width: 1, height: 1, size: 68, sortOrder: 0,
    createdAt: resourceFixtureRows().entry.createdAt, dirty: 1, remoteUrl: "", thumbRemoteUrl: "" }
  if (!same(meta, expectedMedia) || !(blob instanceof Blob) || !(thumbBlob instanceof Blob)) throw new Error("交接后媒体元数据不同")
  const original = await inspectResourceRepairBlob(blob), thumbnail = await inspectResourceRepairBlob(thumbBlob)
  if (original.base64 !== RESOURCE_PNG || thumbnail.base64 !== RESOURCE_PNG || original.mime !== "image/png" || thumbnail.mime !== "image/png") throw new Error("交接后图片不同")
  guard(spec)
  return { fingerprint: conversionCanonical({ raw, original, thumbnail }), evidence, choice: evidence.choice, title: chosen.title, dirty: chosen.dirty }
}
/** Reads only. Recognize the old protected fixture or exactly one validated handoff; never repair/adopt unknown state. */
export async function inspectResourceAcceptanceLifecycle(spec: ResourceAcceptanceSpec) {
  const pin = { ...spec }; guard(pin)
  try {
    const state = await inspectResourceAcceptance(pin); guard(pin)
    if (state.archiveCount) {
      const audit = (await db.meta.get(SCHEDULE_RESOURCE_REPAIRS))?.value
      await validateFixtureRepairArchive(audit); guard(pin)
      if (!same((await db.meta.get(SCHEDULE_RESOURCE_REPAIRS))?.value, audit)) throw new Error("补齐留档读取期间变化")
      guard(pin)
    }
    return { ...state, stage: "protected" as const, handoffArchiveCount: 0, choice: null, entryTitle: resourceFixtureRows().entry.title, entryDirty: 1 }
  } catch {
    const first = await resolvedSnapshot(pin), last = await resolvedSnapshot(pin)
    if (first.fingerprint !== last.fingerprint) throw new Error("读取期间验收状态变化")
    guard(pin)
    return { sourceCount: 1, entryCount: 1, intentionCount: 0, candidateCount: 0, mediaRows: 1, archiveCount: 1, originalMatches: true, thumbnailMatches: true,
      stage: "resolved" as const, handoffArchiveCount: 1, choice: last.choice, entryTitle: last.title, entryDirty: last.dirty }
  }
}
async function ready(spec: ResourceAcceptanceSpec) {
  const state = await inspectResourceAcceptanceLifecycle(spec)
  if (state.stage !== "protected" || state.mediaRows !== 1 || state.archiveCount !== 1 || !state.originalMatches || !state.thumbnailMatches) throw new Error("先完成图片补齐，或交接已经完成")
}
/** A dedicated, no-network composition. Construction does not read the DB or select a file. */
export function createResourceResolutionAcceptanceSession(spec: ResourceAcceptanceSpec, changed: (point: ResourceAcceptancePause | null) => void) {
  const pin = { ...spec }; guard(pin)
  let closed = false, revision = 0, busy = false
  const barrier = createResourceAcceptanceBarrier(changed)
  const check = (run: number) => { guard(pin); if (closed || run !== revision) throw new Error("旧交接验收会话已失效") }
  const resolver = createInternalScheduleResourceConflictResolver({ async review(id, lease) {
    guard(pin)
    if (closed || id !== RESOURCE_SOURCE_ID || lease.ownerUserId !== RESOURCE_DEMO_OWNER || lease.generation !== RESOURCE_EPOCH) throw new Error("模拟证明目标不同")
    await assertScheduleLease(lease); await barrier.wait("proof"); guard(pin); await assertScheduleLease(lease)
    return resourceResolutionProof()
  } })
  const cancel = () => { revision++; resolver.cancel(); barrier.cancel() }
  const port: ResourceConflictPanelPort = {
    async review(id) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0, choices: [] }
      busy = true; const run = revision
      try {
        check(run); await ready(pin); check(run); if (id !== RESOURCE_SOURCE_ID) throw new Error("非夹具来源")
        const result = await resolver.review(id); check(run)
        if (result.ready) {
          const expected = JSON.parse(resourceFixtureMaterial())
          if (!result.local || !same({ ...result.local, exportedAt: expected.exportedAt }, expected)) throw new Error("当前本机已不是固定夹具")
          await ready(pin); check(run)
        }
        return result
      }
      catch { return { ready: false, reason: "resource_acceptance_recheck", reviewId: 0, choices: [] } }
      finally { busy = false; barrier.release() }
    },
    async resolve(reviewId, choice, confirmed, preserve) {
      if (busy) return { applied: false, reason: "busy" }
      busy = true; const run = revision
      try { check(run); await ready(pin); check(run); const result = await resolver.resolve(reviewId, choice, confirmed, async value => {
        check(run); fixtureEvidence(value, await resourceResolutionProof()); check(run); await preserve(value); check(run)
      }); check(run); return result }
      catch { return { applied: false, reason: "resource_acceptance_recheck" } }
      finally { busy = false; barrier.release() }
    }, cancel,
  }
  return { port, pauseNext(point: ResourceAcceptancePause) { return !closed && !busy && barrier.arm(point) }, release: barrier.release,
    close() { closed = true; cancel(); barrier.dispose() } }
}
/** Explicit physical re-open, read-only: a saved file never replays its historical choice. */
export async function readResourceAcceptanceSavedFile(spec: ResourceAcceptanceSpec, file: ConflictEvidenceReadableFile) {
  const pin = { ...spec }; guard(pin)
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 64 * 1024) throw new Error("仅接受本页小型夹具证据")
  const evidence = await readScheduleResourceConflictFile(file); guard(pin); fixtureEvidence(evidence, await resourceResolutionProof()); guard(pin)
  const state = await inspectResourceAcceptanceLifecycle(pin)
  if (state.stage === "resolved") {
    const current = await resolvedSnapshot(pin)
    if (!same(current.evidence, evidence)) throw new Error("文件不是本次已交接留档")
  }
  guard(pin)
  return { verified: true, choice: evidence.choice, handoffConfirmed: state.stage === "resolved" }
}
