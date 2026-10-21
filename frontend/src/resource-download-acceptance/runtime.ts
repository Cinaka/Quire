import { db } from "@/db/schema"
import { createInternalScheduleCloudResourceRepairer, SCHEDULE_RESOURCE_REPAIRS } from "@/db/scheduleResourceRepairRepo"
import { assertScheduleLease } from "@/db/scheduleSyncStateRepo"
import { conversionCanonical, conversionUtc } from "@/shared/scheduleConversionSync"
import { inspectResourceRepairBlob } from "@/io/scheduleResourceRepairFile"
import type { ResourceDownloadPanelPort } from "@/shared/scheduleResourceDownloadPanel"
import { DOWNLOAD_ACCEPTANCE_DB_NAME, DOWNLOAD_ACCEPTANCE_MARKER, downloadAcceptanceMarker, isDownloadAcceptanceMarker } from "./guard"
import type { DownloadAcceptanceSpec } from "./guard"
import { assertDownloadIdentity, DOWNLOAD_DEMO_OWNER } from "./identity"
import { createDownloadAcceptanceBarrier } from "./barrier"
import type { DownloadAcceptancePause } from "./barrier"
import { RESOURCE_SOURCE_ID, RESOURCE_MEDIA_ID, RESOURCE_EPOCH, RESOURCE_FIXTURE_KEY, RESOURCE_PNG,
  resourceFixtureRows, resourceFixtureMaterial, resourceFixtureProof } from "../resource-acceptance/model"

const same = (a: unknown, b: unknown) => conversionCanonical(a) === conversionCanonical(b)
const fixtureMark = { kind: "quire-p4-resource-download-fixture/v1", sourceId: RESOURCE_SOURCE_ID, mediaId: RESOURCE_MEDIA_ID }
function guard(spec: DownloadAcceptanceSpec) {
  assertDownloadIdentity(spec)
  if (db.name !== DOWNLOAD_ACCEPTANCE_DB_NAME) throw new Error("非专用图片下载验收库，拒绝访问")
}
async function empty() {
  for (const table of [db.entries, db.schedules, db.media, db.tags]) if (await table.toCollection().count()) throw new Error("验收库已有数据，不追加/覆盖/清除")
  if ((await db.meta.toArray()).some(row => row.key !== DOWNLOAD_ACCEPTANCE_MARKER)) throw new Error("验收库已有其他元信息，未覆盖")
}
async function marker(spec: DownloadAcceptanceSpec) {
  if (!isDownloadAcceptanceMarker((await db.meta.get(DOWNLOAD_ACCEPTANCE_MARKER))?.value, spec)) throw new Error("验收标记不匹配，未接管")
}
export async function initializeDownloadAcceptance(spec: DownloadAcceptanceSpec) {
  spec = { ...spec }; guard(spec)
  await db.transaction("rw", db.entries, db.schedules, db.media, db.tags, db.meta, async () => {
    guard(spec)
    if (await db.meta.get(DOWNLOAD_ACCEPTANCE_MARKER)) await marker(spec)
    else { await empty(); await db.meta.add({ key: DOWNLOAD_ACCEPTANCE_MARKER, value: downloadAcceptanceMarker(spec) }) }
    guard(spec)
  })
}
/** Explicit empty-store seed, isolated from the prior file-repair and handoff database. */
export async function seedDownloadAcceptance(spec: DownloadAcceptanceSpec) {
  spec = { ...spec }; guard(spec); resourceFixtureMaterial(); await resourceFixtureProof(); guard(spec)
  const rows = resourceFixtureRows()
  await db.transaction("rw", db.entries, db.schedules, db.media, db.tags, db.meta, async () => {
    guard(spec); await marker(spec); await empty()
    await db.schedules.add(rows.source); await db.entries.add(rows.entry)
    for (const [key, value] of [["ownerUserId", DOWNLOAD_DEMO_OWNER], ["ownerGeneration", RESOURCE_EPOCH],
      ["scheduleConversions", [rows.intention]], ["scheduleConflicts", [rows.candidate]], [RESOURCE_FIXTURE_KEY, fixtureMark]] as const) await db.meta.add({ key, value })
    guard(spec)
  })
}
async function fixtureSnapshot(spec: DownloadAcceptanceSpec) {
  guard(spec)
  return db.transaction("r", db.entries, db.schedules, db.media, db.tags, db.meta, async () => {
    guard(spec); await marker(spec)
    const model = resourceFixtureRows(), expected = new Map<string, unknown>([["ownerUserId", DOWNLOAD_DEMO_OWNER], ["ownerGeneration", RESOURCE_EPOCH],
      ["scheduleConversions", [model.intention]], ["scheduleConflicts", [model.candidate]], [RESOURCE_FIXTURE_KEY, fixtureMark]])
    const metadata = await db.meta.toArray()
    if (metadata.some(row => ![DOWNLOAD_ACCEPTANCE_MARKER, SCHEDULE_RESOURCE_REPAIRS, ...expected.keys()].includes(row.key))) throw new Error("存在非验收元信息，未接管")
    for (const [key, value] of expected) if (!same((await db.meta.get(key))?.value ?? null, value)) throw new Error("验收归属或保护已变化，未接管")
    if (!same(await db.schedules.toArray(), [model.source]) || !same(await db.entries.toArray(), [model.entry]) || (await db.tags.toArray()).length) throw new Error("存在不同正文或标签，未接管")
    const media = await db.media.toArray(), archive = (await db.meta.get(SCHEDULE_RESOURCE_REPAIRS))?.value ?? []
    if (!Array.isArray(archive) || ![0, 1].includes(archive.length) || media.length !== archive.length) throw new Error("不是零次或一次明确补齐")
    const row = media[0]
    if (row) {
      const { blob: _original, thumbBlob: _thumbnail, ...meta } = row
      const expectedMedia = { id: RESOURCE_MEDIA_ID, entryId: RESOURCE_SOURCE_ID, mime: "image/png", width: 1, height: 1, size: 68,
        sortOrder: 0, createdAt: model.entry.createdAt, dirty: 1, remoteUrl: "", thumbRemoteUrl: "" }
      if (!same(meta, expectedMedia) || !(row.blob instanceof Blob) || !(row.thumbBlob instanceof Blob)) throw new Error("存在不同媒体，未接管")
    }
    guard(spec)
    return { media: row ?? null, archive, fingerprint: conversionCanonical({ metadata, source: model.source, entry: model.entry, media }) }
  })
}
async function validateArchive(archive: unknown[]) {
  if (!archive.length) return
  const repair = archive[0] as Record<string, unknown>, full = JSON.parse(resourceFixtureMaterial())
  const before = repair?.before as { exportedAt?: string } | undefined
  if (!before?.exportedAt || conversionUtc(before.exportedAt) !== before.exportedAt) throw new Error("留档时间无效")
  const expectedBefore = { ...full, exportedAt: before.exportedAt, media: [], missingMediaIds: [RESOURCE_MEDIA_ID], completeLocalResources: false }
  if (!repair || Object.keys(repair).sort().join() !== ["ownerUserId", "generation", "scheduleId", "kind", "at", "steps", "before", "cloud", "materialOrigin", "downloadedMediaIds", "meaning"].sort().join() ||
      repair.ownerUserId !== DOWNLOAD_DEMO_OWNER || repair.generation !== RESOURCE_EPOCH || repair.scheduleId !== RESOURCE_SOURCE_ID ||
      repair.kind !== "missing-resource-from-cloud" || repair.materialOrigin !== "authenticated_current_image_bytes" || repair.meaning !== "bytes_repaired_protection_unchanged" ||
      typeof repair.at !== "string" || conversionUtc(repair.at) !== repair.at || !same(repair.before, expectedBefore) || !same(repair.cloud, await resourceFixtureProof()) ||
      !same(repair.downloadedMediaIds, [RESOURCE_MEDIA_ID]) || !same(repair.steps, [{ mediaId: RESOURCE_MEDIA_ID, createRow: true, fillOriginal: true, fillThumbnail: true }])) throw new Error("下载留档与原夹具不同，未接管")
}
async function inspectOnce(spec: DownloadAcceptanceSpec) {
  const state = await fixtureSnapshot(spec)
  await validateArchive(state.archive)
  const original = state.media ? await inspectResourceRepairBlob(state.media.blob) : null
  const thumbnail = state.media?.thumbBlob ? await inspectResourceRepairBlob(state.media.thumbBlob) : null
  if (state.media && (original?.base64 !== RESOURCE_PNG || thumbnail?.base64 !== RESOURCE_PNG || original.mime !== "image/png" || thumbnail.mime !== "image/png")) throw new Error("下载后的实际字节不同，未接管")
  guard(spec)
  return { state, fingerprint: conversionCanonical({ state, original, thumbnail }) }
}
/** Read-only strict lifecycle: do not claim, repair or adopt unknown data on refresh. */
export async function inspectDownloadAcceptance(spec: DownloadAcceptanceSpec) {
  const pin = { ...spec }, first = await inspectOnce(pin), last = await inspectOnce(pin)
  if (first.fingerprint !== last.fingerprint) throw new Error("读取期间下载验收状态变化")
  guard(pin)
  return { sourceCount: 1, entryCount: 1, intentionCount: 1, candidateCount: 1, mediaRows: last.state.media ? 1 : 0,
    archiveCount: last.state.archive.length, originalMatches: Boolean(last.state.media), thumbnailMatches: Boolean(last.state.media),
    mode: "simulated_download_real_local_write" as const }
}
/** Dedicated in-process byte response only; never imports request.ts or creates a JWT. */
export function createDownloadAcceptanceSession(spec: DownloadAcceptanceSpec, changed: (point: DownloadAcceptancePause | null) => void) {
  const pin = { ...spec }; guard(pin)
  let closed = false, revision = 0, busy = false
  const barrier = createDownloadAcceptanceBarrier(changed)
  const check = (run: number) => { guard(pin); if (closed || run !== revision) throw new Error("下载验收会话已失效") }
  const identity = async (id: string, lease: Parameters<typeof assertScheduleLease>[0]) => {
    guard(pin)
    if (closed || id !== RESOURCE_SOURCE_ID || lease.ownerUserId !== DOWNLOAD_DEMO_OWNER || lease.generation !== RESOURCE_EPOCH) throw new Error("模拟下载身份不匹配")
    await assertScheduleLease(lease); guard(pin)
  }
  const repairer = createInternalScheduleCloudResourceRepairer({
    async review(id, lease) {
      await identity(id, lease); await barrier.wait("proof"); await identity(id, lease)
      return resourceFixtureProof()
    },
    async image(id, mediaId, variant, proof, lease, signal) {
      await identity(id, lease)
      if (mediaId !== RESOURCE_MEDIA_ID || !["original", "thumbnail"].includes(variant) || signal.aborted) throw new Error("模拟图片请求不匹配")
      const wire = await resourceFixtureProof() as { media: { original: unknown; thumbnail: unknown }[] }
      if (!same(proof, wire.media[0]![variant])) throw new Error("模拟图片证明不匹配")
      await barrier.wait("image"); await identity(id, lease)
      if (signal.aborted) throw new Error("模拟图片下载已取消")
      const verified = proof as { size: number; mime: string; sha256: string }
      return { read_only: true, resolution_enabled: false, proof_scope: "current_entry_image_bytes", schedule_id: id, media_id: mediaId,
        variant, size: verified.size, mime: verified.mime, sha256: verified.sha256, data_base64: RESOURCE_PNG }
    },
  })
  const cancel = () => { revision++; repairer.cancel(); barrier.cancel() }
  const port: ResourceDownloadPanelPort = {
    async prepare(id, ids) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0 }
      busy = true; const run = revision
      try {
        check(run); await inspectDownloadAcceptance(pin); check(run)
        if (id !== RESOURCE_SOURCE_ID || ids.length !== 1 || ids[0] !== RESOURCE_MEDIA_ID) throw new Error("仅允许明确选择专用图片")
        const result = await repairer.prepare(id, ids); check(run); return result
      } catch { return { ready: false, reason: "download_acceptance_unconfirmed", reviewId: 0 } }
      finally { busy = false; barrier.release() }
    },
    async repair(reviewId, confirmed) {
      if (busy) return { repaired: false, reason: "busy", resolutionEnabled: false }
      busy = true; const run = revision
      try { check(run); await inspectDownloadAcceptance(pin); check(run); const result = await repairer.repair(reviewId, confirmed); check(run); return result }
      catch { return { repaired: false, reason: "download_acceptance_recheck", resolutionEnabled: false } }
      finally { busy = false; barrier.release() }
    },
    cancel,
  }
  return { port, pauseNext(point: DownloadAcceptancePause) { return !closed && !busy && barrier.arm(point) }, release: barrier.release,
    close() { closed = true; cancel(); barrier.dispose() } }
}
