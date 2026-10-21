import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceImageTransport } from "@/api/scheduleCloudResourceImageTransport"
import { downloadScheduleResourceImages } from "@/io/scheduleResourceImageDownload"
import type { ScheduleCloudResourceTransport } from "@/api/scheduleCloudResourceTransport"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { assertResourceRepairImage, assertResourceRepairMaterial, inspectResourceRepairBlob, readResourceRepairDocument, resourceRepairBlob } from "@/io/scheduleResourceRepairFile"
import type { ResourceRepairDocument } from "@/io/scheduleResourceRepairFile"
import { parseScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import type { ScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { assertResourceRepairTarget } from "@/shared/scheduleResourceRepair"
import type { ScheduleResourceRepairStep } from "@/shared/scheduleResourceRepair"
import type { ResourceEvidenceMedia, ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import type { MediaItem } from "@/shared/types"
import { terminalVersionKey } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId } from "@/shared/schedules"

import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease, readScheduleServerState } from "./scheduleSyncStateRepo"
import { db, scheduleResourceTransactionAborter, waitForScheduleResourceBytes } from "./schema"

export const SCHEDULE_RESOURCE_REPAIRS = "scheduleResourceRepairs"
async function repairs(): Promise<unknown[]> {
  const row = await db.meta.get(SCHEDULE_RESOURCE_REPAIRS)
  if (row && !Array.isArray(row.value)) throw new Error("资源补齐留档损坏")
  return row?.value as unknown[] ?? []
}
async function snapshot(id: string, lease: ConversionLease, insideWrite = false) {
  const raw = await captureScheduleResourceSnapshot(id, lease)
  const read = async () => {
    const value = await encodeScheduleResourceSnapshot(raw, id, lease), bytes = []
    // A remote placeholder may already hold a thumbnail: include these bytes even when original is empty.
    for (const row of raw.media) bytes.push({ id: row.id, original: await inspectResourceRepairBlob(row.blob),
      thumbnail: row.thumbBlob === null ? null : await inspectResourceRepairBlob(row.thumbBlob) })
    return { value, bytes }
  }
  const pending = read(), data = insideWrite ? await waitForScheduleResourceBytes(pending) : await pending
  const base = await readScheduleServerState(lease, id) ?? null
  await repairs(); await assertScheduleLease(lease)
  return { raw, ...data, base, local: scheduleResourceSnapshotEvidence(data.value, id), fingerprint: conversionCanonical({ raw, ...data, base }) }
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>
interface Ticket { id: string; lease: ConversionLease; fingerprint: string; local: ScheduleResourceEvidence; cloud: ScheduleCloudResourceReview
  wire: unknown; selected: string[]; material: ResourceEvidenceMedia[]; steps: ScheduleResourceRepairStep[]
  origin: "evidence_file" | "cloud_download"; fileEvidence?: ScheduleResourceEvidence; fileDocument?: ResourceRepairDocument; fileFingerprint?: string; file?: ConflictEvidenceReadableFile }
async function targetPlan(current: Snapshot, cloud: ScheduleCloudResourceReview, selected: string[]): Promise<ScheduleResourceRepairStep[]> {
  assertResourceRepairTarget(current.local, cloud, selected)
  const steps: ScheduleResourceRepairStep[] = []
  for (const mediaId of selected) {
    const proof = cloud.media.find(row => row.id === mediaId)!
    const existing = current.raw.media.find((row: MediaItem) => row.id === mediaId), bytes = current.bytes.find(row => row.id === mediaId)
    if (existing) {
      if (existing.entryId !== current.local.scheduleId || existing.orphanedAt != null || existing.mime !== proof.original.mime ||
          existing.width !== proof.width || existing.height !== proof.height || existing.size !== proof.size || existing.sortOrder !== proof.sortOrder ||
          ![0, 1].includes(existing.dirty)) throw new Error("已有媒体归属或元数据不同，不能覆盖")
      terminalVersionKey(existing.createdAt)
      if (bytes!.original.size) await assertResourceRepairImage(bytes!.original.base64, bytes!.original.mime, proof.original)
      if (bytes!.thumbnail?.size) await assertResourceRepairImage(bytes!.thumbnail.base64, bytes!.thumbnail.mime, proof.thumbnail)
    }
    const fillOriginal = !bytes?.original.size, fillThumbnail = proof.thumbnail.state === "verified" && !bytes?.thumbnail?.size
    if (!fillOriginal && !fillThumbnail) throw new Error("选择包含无需补齐的媒体，未执行空操作")
    steps.push({ mediaId, createRow: !existing, fillOriginal, fillThumbnail })
  }
  const base = current.base
  if ((base && terminalVersionKey(base.serverUpdatedAt) > terminalVersionKey(cloud.review.schedule!.serverUpdatedAt)) ||
      (current.local.state.source!.serverUpdatedAt && terminalVersionKey(current.local.state.source!.serverUpdatedAt) > terminalVersionKey(cloud.review.schedule!.serverUpdatedAt)) ||
      (current.local.state.entry!.serverUpdatedAt && terminalVersionKey(current.local.state.entry!.serverUpdatedAt) > terminalVersionKey(cloud.review.entry!.serverUpdatedAt))) throw new Error("已知来源或日记水位领先本次云端证明")
  return steps
}
async function plan(current: Snapshot, cloud: ScheduleCloudResourceReview, selected: string[], material: ResourceEvidenceMedia[]): Promise<ScheduleResourceRepairStep[]> {
  const steps = await targetPlan(current, cloud, selected)
  for (const mediaId of selected) {
    const row = material.find(item => item.id === mediaId)
    if (!row) throw new Error("补齐材料缺少明确选择的图片")
    await assertResourceRepairMaterial(row, cloud.media.find(item => item.id === mediaId)!, current.local.scheduleId)
  }
  return steps
}
async function verify(ticket: Ticket) {
  const current = await snapshot(ticket.id, ticket.lease)
  if (current.fingerprint !== ticket.fingerprint) throw new Error("本机内容、保护或图片字节已变化")
  return current
}
async function apply(ticket: Ticket, current: Snapshot, check: () => void, registerAbort: (abort: () => void) => void) {
  check()
  await db.transaction("rw", db.schedules, db.entries, db.tags, db.media, db.meta, async () => {
    registerAbort(scheduleResourceTransactionAborter()); check()
    const latest = await snapshot(ticket.id, ticket.lease, true)
    check()
    if (latest.fingerprint !== current.fingerprint || latest.fingerprint !== ticket.fingerprint) throw new Error("事务内资源已变化")
    // Nothing from the file's source/entry/tag/intent metadata is restored.
    for (const step of ticket.steps) {
      const material = ticket.material.find(row => row.id === step.mediaId)!, proof = ticket.cloud.media.find(row => row.id === step.mediaId)!
      const existing = latest.raw.media.find((row: MediaItem) => row.id === step.mediaId)
      const row: MediaItem = existing ? { ...existing } : { id: step.mediaId, entryId: ticket.id, mime: proof.original.mime!, width: proof.width, height: proof.height,
        size: proof.size!, sortOrder: proof.sortOrder, createdAt: proof.createdAt, dirty: 1 as const, remoteUrl: "", thumbRemoteUrl: "", blob: new Blob([]), thumbBlob: null }
      if (step.fillOriginal) row.blob = resourceRepairBlob(material.blobBase64, material.mime)
      if (step.fillThumbnail) row.thumbBlob = resourceRepairBlob(material.thumbBase64!, material.thumbMime!)
      // Existing dirty, timestamps, URLs and other bytes remain exactly as they were.
      if (existing) await db.media.put(row); else await db.media.add(row)
      check()
    }
    const archive = await repairs()
    check()
    await db.meta.put({ key: SCHEDULE_RESOURCE_REPAIRS, value: [...archive, { ownerUserId: ticket.lease.ownerUserId, generation: ticket.lease.generation,
      scheduleId: ticket.id, kind: ticket.origin === "cloud_download" ? "missing-resource-from-cloud" : "missing-resource-from-evidence", at: conversionUtc(new Date().toISOString()), steps: ticket.steps,
      before: ticket.local, cloud: ticket.wire, ...(ticket.origin === "evidence_file" ? { fileFormat: ticket.fileDocument!.format, fileFingerprint: ticket.fileFingerprint, fileEvidence: ticket.fileDocument } : { materialOrigin: "authenticated_current_image_bytes", downloadedMediaIds: ticket.selected }), meaning: "bytes_repaired_protection_unchanged" }] })
    check()
    await assertScheduleLease(ticket.lease)
    check()
  })
}
/** Explicit missing-byte import only. Cancellation never undoes an already committed write. */
export function createInternalScheduleResourceRepairer(transport: ScheduleCloudResourceTransport, images?: ScheduleCloudResourceImageTransport) {
  let ticket: Ticket | null = null, serial = 0, busy = false, operation = 0
  let abortWrite: (() => void) | null = null, abortDownload: AbortController | null = null
  const guard = (run: number) => { if (run !== operation) throw new Error("资源补齐操作已取消") }
  return {
    cancel() {
      operation++; ticket = null; abortDownload?.abort()
      // Keep busy until all old asynchronous work settles. A committed transaction cannot be undone.
      try { abortWrite?.() } catch { /* Already committed/aborted: the caller must recheck. */ }
    },
    async prepare(id: string, selected: string[], file: ConflictEvidenceReadableFile) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0 }
      busy = true; ticket = null; const reviewId = ++serial, run = ++operation, check = () => guard(run)
      try {
        if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
        const lease = await captureSyncContext(); check()
        const current = await snapshot(id, lease); check()
        const chosen = [...selected].sort(), material = await readResourceRepairDocument(file, id); check()
        const fileEvidence = material.local
        const wire = conversionCopy(await transport.review(id, conversionCopy(lease))); check()
        const cloud = parseScheduleCloudResourceReview(wire, id)
        const steps = await plan(current, cloud, chosen, fileEvidence.media); check()
        const active: Ticket = { id, lease, fingerprint: current.fingerprint, local: current.local, cloud, wire, selected: chosen,
          material: fileEvidence.media, origin: "evidence_file", fileEvidence, fileDocument: material.document, fileFingerprint: material.fingerprint, steps, file }
        await verify(active); check(); ticket = active
        return { ready: true, reason: "explicit_missing_bytes_confirmation", reviewId, steps: conversionCopy(steps), resolutionEnabled: false,
          unusedFileMediaIds: fileEvidence.mediaIds.filter(key => !chosen.includes(key)), fileFormat: material.document.format,
          fileStatePolicy: "bytes_only_never_replay_archived_choice_or_business_state" }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "resource_repair_unconfirmed", reviewId: 0 } }
      finally { busy = false }
    },
    async prepareDownload(id: string, selected: string[]) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0 }
      busy = true; ticket = null; const reviewId = ++serial, run = ++operation, check = () => guard(run)
      const controller = new AbortController(); abortDownload = controller
      try {
        if (!images || scheduleEntryId(id) !== id || !Array.isArray(selected)) throw new Error("下载来源或传输未配置")
        const chosen = [...selected].sort() // Pin explicit selection before the first asynchronous boundary.
        const lease = await captureSyncContext(); check()
        const current = await snapshot(id, lease); check()
        const wire = conversionCopy(await transport.review(id, conversionCopy(lease))); check()
        const cloud = parseScheduleCloudResourceReview(wire, id)
        const steps = await targetPlan(current, cloud, chosen); check()
        const active: Ticket = { id, lease, fingerprint: current.fingerprint, local: current.local, cloud, wire,
          selected: chosen, material: [], steps, origin: "cloud_download" }
        await verify(active); check()
        const retained = current.bytes.map(row => ({ id: row.id, original: row.original.size ? row.original.base64 : null,
          thumbnail: row.thumbnail?.size ? row.thumbnail.base64 : null }))
        active.material = await downloadScheduleResourceImages(id, cloud, steps, retained, images, lease, controller.signal,
          async () => { check(); await assertScheduleLease(lease); check() }); check()
        const latest = parseScheduleCloudResourceReview(await transport.review(id, conversionCopy(lease)), id); check()
        if (conversionCanonical(latest) !== conversionCanonical(cloud)) throw new Error("下载期间云端完整证明已变化")
        await verify(active); check()
        if (conversionCanonical(await plan(current, cloud, chosen, active.material)) !== conversionCanonical(steps)) throw new Error("下载计划已变化")
        check(); ticket = active
        return { ready: true, reason: "explicit_cloud_missing_bytes_confirmation", reviewId, steps: conversionCopy(steps),
          resolutionEnabled: false, materialOrigin: "authenticated_current_image_bytes", downloaded: true }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "cloud_resource_download_unconfirmed", reviewId: 0 } }
      finally { abortDownload = null; busy = false }
    },
    async repair(reviewId: number, confirmed: boolean) {
      if (busy) return { repaired: false, reason: "busy", resolutionEnabled: false }
      if (!ticket || reviewId !== serial || confirmed !== true) return { repaired: false, reason: "explicit_confirmation_required", resolutionEnabled: false }
      busy = true; const active = ticket, run = ++operation, check = () => guard(run)
      try {
        let current = await verify(active); check()
        for (const boundary of ["before_file", "after_file"] as const) {
          const wire = await transport.review(active.id, conversionCopy(active.lease)); check()
          const cloud = parseScheduleCloudResourceReview(wire, active.id)
          if (conversionCanonical(cloud) !== conversionCanonical(active.cloud)) { ticket = null; return { repaired: false, reason: "server_changed_reopen", resolutionEnabled: false } }
          current = await verify(active); check()
          if (boundary === "before_file") {
            if (active.origin === "evidence_file") {
              const material = await readResourceRepairDocument(active.file!, active.id); check()
              if (material.fingerprint !== active.fileFingerprint || material.document.format !== active.fileDocument!.format) throw new Error("完整证据文件已变化")
              active.material = material.local.media
            }
            const steps = await plan(current, cloud, active.selected, active.material); check()
            if (conversionCanonical(steps) !== conversionCanonical(active.steps)) throw new Error("待补齐项已变化")
            current = await verify(active); check()
          }
        }
        // The abort handle remains registered until the transaction promise has settled, including commit.
        await apply(active, current, check, abort => { abortWrite = abort }); check(); ticket = null
        return { repaired: true, reason: "local_missing_bytes_repaired", resolutionEnabled: false, intentStatus: "unchanged_protected" }
      } catch { ticket = null; return { repaired: false, reason: run !== operation ? "cancelled_recheck" : "resource_repair_unconfirmed", resolutionEnabled: false } }
      finally { abortWrite = null; busy = false }
    },
  }
}

/** Separate internal capability: no default UI/router/repo registration and no evidence-file replay. */
export function createInternalScheduleCloudResourceRepairer(transport: ScheduleCloudResourceImageTransport) {
  const engine = createInternalScheduleResourceRepairer(transport, transport)
  return { prepare: engine.prepareDownload, repair: engine.repair, cancel: engine.cancel }
}
