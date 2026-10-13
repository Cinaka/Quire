import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceTransport } from "@/api/scheduleCloudResourceTransport"
import { parseScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { conversionCanonical, conversionCopy } from "@/shared/scheduleConversionSync"
import { scheduleEntryId } from "@/shared/schedules"
import type { ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"

import { createInternalScheduleResourceEvidenceExporter } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease } from "./scheduleSyncStateRepo"

function sameSnapshot(value: ScheduleResourceEvidence) {
  return conversionCanonical({ ...value, exportedAt: "" })
}
/** Current cloud resources + locally preserved snapshot, not a choice or protection release. */
export function createInternalScheduleCloudResourceReviewer(transport: ScheduleCloudResourceTransport) {
  let busy = false
  const exporter = createInternalScheduleResourceEvidenceExporter()
  return { async review(id: string) {
    if (busy) return { ready: false, reason: "busy", resolutionEnabled: false }
    busy = true
    try {
      if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
      const lease = await captureSyncContext(), local = await exporter.export(id)
      if (!local.ready || !local.evidence) throw new Error("本机资源未核对")
      await assertScheduleLease(lease)
      const server = parseScheduleCloudResourceReview(await transport.review(id, conversionCopy(lease)), id)
      await assertScheduleLease(lease)
      const latest = await exporter.export(id)
      if (!latest.ready || !latest.evidence || sameSnapshot(local.evidence) !== sameSnapshot(latest.evidence)) throw new Error("读取云端期间本机资源已变化")
      await assertScheduleLease(lease)
      return { ready: true, reason: "read_only_cloud_resources", resolutionEnabled: false,
        local: conversionCopy(local.evidence), server }
    } catch { return { ready: false, reason: "cloud_resources_unconfirmed", resolutionEnabled: false } }
    finally { busy = false }
  } }
}
