import { captureSyncContext } from "@/api/syncContext"
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
import type { ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import type { MediaItem } from "@/shared/types"
import { terminalVersionKey } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId } from "@/shared/schedules"

import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease, readScheduleServerState } from "./scheduleSyncStateRepo"
import { db, waitForScheduleResourceBytes } from "./schema"

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
  wire: unknown; selected: string[]; fileEvidence: ScheduleResourceEvidence; fileDocument: ResourceRepairDocument; fileFingerprint: string; steps: ScheduleResourceRepairStep[]; file: ConflictEvidenceReadableFile }
async function plan(current: Snapshot, cloud: ScheduleCloudResourceReview, selected: string[], file: ScheduleResourceEvidence): Promise<ScheduleResourceRepairStep[]> {
  assertResourceRepairTarget(current.local, cloud, selected)
  const steps: ScheduleResourceRepairStep[] = []
  for (const mediaId of selected) {
    const proof = cloud.media.find(row => row.id === mediaId)!, material = file.media.find(row => row.id === mediaId)
    if (!material) throw new Error("证据文件缺少明确选择的图片")
    await assertResourceRepairMaterial(material, proof, current.local.scheduleId)
    const existing = current.raw.media.find(row => row.id === mediaId), bytes = current.bytes.find(row => row.id === mediaId)
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
  return steps
}
async function verify(ticket: Ticket) {
  const current = await snapshot(ticket.id, ticket.lease)
  if (current.fingerprint !== ticket.fingerprint) throw new Error("本机内容、保护或图片字节已变化")
  return current
}
async function apply(ticket: Ticket, current: Snapshot) {
  await db.transaction("rw", db.schedules, db.entries, db.tags, db.media, db.meta, async () => {
    const latest = await snapshot(ticket.id, ticket.lease, true)
    if (latest.fingerprint !== current.fingerprint || latest.fingerprint !== ticket.fingerprint) throw new Error("事务内资源已变化")
    // Nothing from the file's source/entry/tag/intent metadata is restored.
    for (const step of ticket.steps) {
      const material = ticket.fileEvidence.media.find(row => row.id === step.mediaId)!, proof = ticket.cloud.media.find(row => row.id === step.mediaId)!
      const existing = latest.raw.media.find(row => row.id === step.mediaId)
      const row: MediaItem = existing ? { ...existing } : { id: step.mediaId, entryId: ticket.id, mime: proof.original.mime!, width: proof.width, height: proof.height,
        size: proof.size!, sortOrder: proof.sortOrder, createdAt: proof.createdAt, dirty: 1 as const, remoteUrl: "", thumbRemoteUrl: "", blob: new Blob([]), thumbBlob: null }
      if (step.fillOriginal) row.blob = resourceRepairBlob(material.blobBase64, material.mime)
      if (step.fillThumbnail) row.thumbBlob = resourceRepairBlob(material.thumbBase64!, material.thumbMime!)
      // Existing dirty, timestamps, URLs and other bytes remain exactly as they were.
      if (existing) await db.media.put(row); else await db.media.add(row)
    }
    const archive = await repairs()
    await db.meta.put({ key: SCHEDULE_RESOURCE_REPAIRS, value: [...archive, { ownerUserId: ticket.lease.ownerUserId, generation: ticket.lease.generation,
      scheduleId: ticket.id, kind: "missing-resource-from-evidence", at: conversionUtc(new Date().toISOString()), steps: ticket.steps,
      before: ticket.local, cloud: ticket.wire, fileFormat: ticket.fileDocument.format, fileFingerprint: ticket.fileFingerprint, fileEvidence: ticket.fileDocument, meaning: "bytes_repaired_protection_unchanged" }] })
    await assertScheduleLease(ticket.lease)
  })
}
/** Explicit missing-byte import only. Never imports diaries/tags, ACKs an intention or runs sync. */
export function createInternalScheduleResourceRepairer(transport: ScheduleCloudResourceTransport) {
  let ticket: Ticket | null = null, serial = 0, busy = false
  return {
    async prepare(id: string, selected: string[], file: ConflictEvidenceReadableFile) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0 }
      busy = true; ticket = null; const reviewId = ++serial
      try {
        if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
        const lease = await captureSyncContext(), current = await snapshot(id, lease)
        const chosen = [...selected].sort(), material = await readResourceRepairDocument(file, id), fileEvidence = material.local
        const wire = conversionCopy(await transport.review(id, conversionCopy(lease))), cloud = parseScheduleCloudResourceReview(wire, id)
        const steps = await plan(current, cloud, chosen, fileEvidence)
        const base = current.base
        if ((base && terminalVersionKey(base.serverUpdatedAt) > terminalVersionKey(cloud.review.schedule!.serverUpdatedAt)) ||
            (current.local.state.source!.serverUpdatedAt && terminalVersionKey(current.local.state.source!.serverUpdatedAt) > terminalVersionKey(cloud.review.schedule!.serverUpdatedAt)) ||
            (current.local.state.entry!.serverUpdatedAt && terminalVersionKey(current.local.state.entry!.serverUpdatedAt) > terminalVersionKey(cloud.review.entry!.serverUpdatedAt))) throw new Error("已知来源或日记水位领先本次云端证明")
        const active = { id, lease, fingerprint: current.fingerprint, local: current.local, cloud, wire, selected: chosen, fileEvidence, fileDocument: material.document, fileFingerprint: material.fingerprint, steps, file }
        await verify(active); ticket = active
        return { ready: true, reason: "explicit_missing_bytes_confirmation", reviewId, steps: conversionCopy(steps), resolutionEnabled: false,
          unusedFileMediaIds: fileEvidence.mediaIds.filter(key => !chosen.includes(key)), fileFormat: material.document.format,
          fileStatePolicy: "bytes_only_never_replay_archived_choice_or_business_state" }
      } catch { return { ready: false, reason: "resource_repair_unconfirmed", reviewId: 0 } }
      finally { busy = false }
    },
    async repair(reviewId: number, confirmed: boolean) {
      if (busy) return { repaired: false, reason: "busy", resolutionEnabled: false }
      if (!ticket || reviewId !== serial || confirmed !== true) return { repaired: false, reason: "explicit_confirmation_required", resolutionEnabled: false }
      busy = true; const active = ticket
      try {
        let current = await verify(active)
        for (const boundary of ["before_file", "after_file"] as const) {
          const cloud = parseScheduleCloudResourceReview(await transport.review(active.id, conversionCopy(active.lease)), active.id)
          if (conversionCanonical(cloud) !== conversionCanonical(active.cloud)) { ticket = null; return { repaired: false, reason: "server_changed_reopen", resolutionEnabled: false } }
          current = await verify(active)
          if (boundary === "before_file") {
            const material = await readResourceRepairDocument(active.file, active.id)
            if (material.fingerprint !== active.fileFingerprint || material.document.format !== active.fileDocument.format) throw new Error("完整证据文件已变化")
            const steps = await plan(current, cloud, active.selected, material.local)
            if (conversionCanonical(steps) !== conversionCanonical(active.steps)) throw new Error("待补齐项已变化")
            current = await verify(active)
          }
        }
        await apply(active, current); ticket = null
        return { repaired: true, reason: "local_missing_bytes_repaired", resolutionEnabled: false, intentStatus: "unchanged_protected" }
      } catch { ticket = null; return { repaired: false, reason: "resource_repair_unconfirmed", resolutionEnabled: false } }
      finally { busy = false }
    },
  }
}
