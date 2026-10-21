import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceImageTransport } from "@/api/scheduleCloudResourceImageTransport"
import { createDualResourceEvidenceFilePreserver, verifyDualResourceEvidence } from "@/io/scheduleDualResourceEvidenceFile"
import type { ConflictEvidenceFileHandle } from "@/io/scheduleConflictEvidenceFile"
import { downloadScheduleResourceImages } from "@/io/scheduleResourceImageDownload"
import { digestScheduleResourceBytes } from "@/io/scheduleResourceConflictFile"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { assertDualResourceTarget } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "@/shared/scheduleDualResourceEvidence"
import { scheduleEntryId } from "@/shared/schedules"

import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease } from "./scheduleSyncStateRepo"

interface Ticket { id: string; lease: ConversionLease; fingerprint: string; evidence: ScheduleDualResourceEvidence }
async function snapshot(id: string, lease: ConversionLease) {
  const raw = await captureScheduleResourceSnapshot(id, lease)
  const encoded = await encodeScheduleResourceSnapshot(raw, id, lease)
  await assertScheduleLease(lease)
  return { fingerprint: conversionCanonical({ raw, encoded }), local: scheduleResourceSnapshotEvidence(encoded, id) }
}
async function differences(evidence: ScheduleDualResourceEvidence) {
  const cloud = assertDualResourceTarget(evidence.local, evidence.cloud)
  const differentMediaIds: string[] = [], differentTagIds: string[] = []
  for (const id of [...new Set([...evidence.local.mediaIds, ...cloud.mediaIds])].sort()) {
    const local = evidence.local.media.find(row => row.id === id), remote = cloud.media.find(row => row.id === id)
    if (!local || !remote) { differentMediaIds.push(id); continue }
    const original = await digestScheduleResourceBytes(local.blobBase64)
    const thumbnail = local.thumbBase64 === null ? null : await digestScheduleResourceBytes(local.thumbBase64)
    if (local.entryId !== remote.entryId || local.mime !== remote.original.mime || local.width !== remote.width ||
        local.height !== remote.height || local.size !== remote.size || local.sortOrder !== remote.sortOrder ||
        original.sha256 !== remote.original.sha256 || original.size !== remote.original.size ||
        (thumbnail === null ? remote.thumbnail.state !== "not_present" :
          thumbnail.sha256 !== remote.thumbnail.sha256 || thumbnail.size !== remote.thumbnail.size || local.thumbMime !== remote.thumbnail.mime)) {
      differentMediaIds.push(id)
    }
  }
  for (const id of [...new Set([...evidence.local.tagIds, ...cloud.tagIds])].sort()) {
    const local = evidence.local.tags.find(row => row.id === id), remote = cloud.tags.find(row => row.id === id)
    if (!local || !remote || local.name !== remote.name || local.color !== remote.color) differentTagIds.push(id)
  }
  return { differentMediaIds, differentTagIds }
}
/** Explicit internal evidence capture only. It has no write transaction, repair, resolution or release API. */
export function createInternalDualResourceEvidenceExporter(transport: ScheduleCloudResourceImageTransport) {
  let busy = false, serial = 0, operation = 0, ticket: Ticket | null = null
  let controller: AbortController | null = null
  const guard = (run: number) => { if (run !== operation) throw new Error("双方资源保全已取消") }
  const verify = async (active: Ticket) => {
    if ((await snapshot(active.id, active.lease)).fingerprint !== active.fingerprint) throw new Error("本机资源或保护已变化")
  }
  return {
    cancel() { operation++; ticket = null; controller?.abort() },
    async prepare(id: string, confirmedDownload: boolean) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0, resolutionEnabled: false }
      if (confirmedDownload !== true) return { ready: false, reason: "explicit_download_required", reviewId: 0, resolutionEnabled: false }
      busy = true; ticket = null; const run = ++operation, reviewId = ++serial
      controller = new AbortController(); const signal = controller.signal
      try {
        if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
        const lease = await captureSyncContext(); guard(run)
        const check = async () => { guard(run); await assertScheduleLease(lease); guard(run) }
        const first = await snapshot(id, lease); await check()
        const wire = conversionCopy(await transport.review(id, conversionCopy(lease))); await check()
        const cloud = assertDualResourceTarget(first.local, wire)
        const cloudMedia = cloud.media.length ? await downloadScheduleResourceImages(id, cloud,
          cloud.media.map(row => ({ mediaId: row.id, createRow: false, fillOriginal: true, fillThumbnail: row.thumbnail.state === "verified" })),
          [], transport, lease, signal, check) : []
        await check()
        const evidence = await verifyDualResourceEvidence({ app: "quire", format: "terminal-dual-resource-evidence", formatVersion: 1,
          scheduleId: id, exportedAt: conversionUtc(new Date().toISOString()), local: first.local, cloud: wire, cloudMedia,
          resolutionEnabled: false, meaning: "both_versions_not_confirmation_or_restore" })
        await check()
        const active: Ticket = { id, lease, fingerprint: first.fingerprint, evidence }
        await verify(active); await check()
        const latest = await transport.review(id, conversionCopy(lease)); await check()
        if (conversionCanonical(assertDualResourceTarget(first.local, latest)) !== conversionCanonical(cloud)) throw new Error("云端资源证明已变化")
        const delta = await differences(evidence); await check()
        await verify(active); await check()
        ticket = active
        return { ready: true, reason: "both_resource_versions_prepared", reviewId, resolutionEnabled: false,
          ...delta, localMediaCount: evidence.local.media.length, cloudMediaCount: cloudMedia.length }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "dual_resource_capture_unconfirmed", reviewId: 0, resolutionEnabled: false } }
      finally { controller = null; busy = false }
    },
    async save(reviewId: number, confirmed: boolean, handle?: ConflictEvidenceFileHandle) {
      if (busy) return { saved: false, reason: "busy", resolutionEnabled: false }
      if (!ticket || reviewId !== serial || confirmed !== true || !handle) {
        return { saved: false, reason: "explicit_file_save_required", resolutionEnabled: false }
      }
      busy = true; const active = ticket, run = ++operation
      let fileAttempted = false, fileVerified = false
      const check = async () => { guard(run); await assertScheduleLease(active.lease); guard(run) }
      const cloudUnchanged = async () => {
        const wire = await transport.review(active.id, conversionCopy(active.lease)); await check()
        if (conversionCanonical(assertDualResourceTarget(active.evidence.local, wire)) !==
            conversionCanonical(assertDualResourceTarget(active.evidence.local, active.evidence.cloud))) throw new Error("云端证据已变化")
      }
      try {
        await check(); await verify(active); await check(); await cloudUnchanged(); await verify(active); await check()
        const preserve = createDualResourceEvidenceFilePreserver(handle, check)
        fileAttempted = true; await preserve(conversionCopy(active.evidence)); fileVerified = true
        await check(); await verify(active); await check(); await cloudUnchanged(); await verify(active); await check()
        ticket = null
        return { saved: true, reason: "both_versions_file_verified_protection_retained", resolutionEnabled: false }
      } catch {
        ticket = null
        return { saved: false, reason: fileVerified ? "file_saved_but_state_changed_recheck" :
          run !== operation ? "cancelled_recheck" : "dual_resource_file_unconfirmed", fileMayExist: fileAttempted, resolutionEnabled: false }
      } finally { busy = false }
    },
  }
}
