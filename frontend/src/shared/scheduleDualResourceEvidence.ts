import { parseScheduleCloudResourceReview } from "./scheduleCloudResources"
import { conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { checkScheduleResourceEvidence, RESOURCE_EVIDENCE_MAX_BYTES } from "./scheduleResourceEvidence"
import type { ResourceEvidenceMedia, ScheduleResourceEvidence } from "./scheduleResourceEvidence"
import { scheduleEntryId } from "./schedules"

/** Both physical versions, not an instruction to restore, overwrite, confirm or release protection. */
export interface ScheduleDualResourceEvidence {
  app: "quire"; format: "terminal-dual-resource-evidence"; formatVersion: 1
  scheduleId: string; exportedAt: string; local: ScheduleResourceEvidence
  cloud: unknown; cloudMedia: ResourceEvidenceMedia[]
  resolutionEnabled: false; meaning: "both_versions_not_confirmation_or_restore"
}
export function assertDualResourceTarget(local: ScheduleResourceEvidence, wire: unknown) {
  const value = checkScheduleResourceEvidence(local)
  const cloud = parseScheduleCloudResourceReview(wire, value.scheduleId)
  const review = cloud.review
  if (!value.completeLocalResources || value.entryPendingPurge || !value.state.source || !value.state.entry ||
      value.state.source.status !== "converted" || value.state.source.isDeleted !== 0 || value.state.entry.isDeleted !== 0 ||
      !review.receiptKnown || !review.reviewable || review.reason !== "terminal_review" || review.entryState !== "active" ||
      !review.schedule || review.schedule.status !== "converted" || review.schedule.isDeleted !== 0 || !review.entry ||
      !cloud.resourcesComplete || cloud.resourceState !== "verified") {
    throw new Error("双方资源尚不完整或属于终态异常，未下载或取舍")
  }
  return cloud
}
export function checkDualResourceEvidence(raw: unknown): ScheduleDualResourceEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("双方资源证据结构无效")
  const row = raw as ScheduleDualResourceEvidence
  const keys = ["app", "format", "formatVersion", "scheduleId", "exportedAt", "local", "cloud", "cloudMedia", "resolutionEnabled", "meaning"]
  if (keys.some(key => !(key in row)) || Object.keys(row).some(key => !keys.includes(key)) || row.app !== "quire" ||
      row.format !== "terminal-dual-resource-evidence" || row.formatVersion !== 1 || typeof row.scheduleId !== "string" ||
      scheduleEntryId(row.scheduleId) !== row.scheduleId || typeof row.exportedAt !== "string" ||
      conversionUtc(row.exportedAt) !== row.exportedAt || row.resolutionEnabled !== false ||
      row.meaning !== "both_versions_not_confirmation_or_restore" || row.local?.scheduleId !== row.scheduleId ||
      !Array.isArray(row.cloudMedia)) throw new Error("不是本版双方资源证据或含未知字段")
  const cloud = assertDualResourceTarget(row.local, row.cloud)
  // Reuse strict bounded resource rows/references; cloud bytes form a separate snapshot, never a local replacement.
  const remote = checkScheduleResourceEvidence({ app: "quire", format: "terminal-local-resource-evidence", formatVersion: 1,
    exportedAt: row.exportedAt, scheduleId: row.scheduleId,
    state: { source: cloud.review.schedule, entry: cloud.review.entry, linkedEntries: [cloud.review.entry],
      intentions: [], candidates: [], p2Conflicts: [] },
    mediaIds: cloud.mediaIds, tagIds: cloud.tagIds, media: row.cloudMedia,
    tags: cloud.tags.map(tag => ({ ...tag, dirty: 0 })), missingMediaIds: [], missingTagIds: [],
    completeLocalResources: true, entryPendingPurge: false, resolutionEnabled: false,
    meaning: "local_snapshot_not_cloud_confirmation_or_restore" })
  if (remote.media.length !== cloud.media.length) throw new Error("云端图片证据不完整")
  for (const proof of cloud.media) {
    const item = remote.media.find(media => media.id === proof.id)
    if (!item || item.entryId !== row.scheduleId || item.orphanedAt !== null || item.size !== proof.size ||
        item.sortOrder !== proof.sortOrder || item.width !== proof.width || item.height !== proof.height ||
        item.mime !== proof.original.mime || item.createdAt !== proof.createdAt || item.dirty !== 1 ||
        item.hadRemoteLink || item.hadThumbRemoteLink ||
        (proof.thumbnail.state === "not_present" ? item.thumbBase64 !== null || item.thumbMime !== null :
          item.thumbBase64 === null || item.thumbMime !== proof.thumbnail.mime)) throw new Error("云端图片身份或元数据与证明不同")
  }
  return conversionCopy(row)
}
export function parseDualResourceEvidence(text: string): ScheduleDualResourceEvidence {
  if (typeof text !== "string" || !text.length || text.length > RESOURCE_EVIDENCE_MAX_BYTES) throw new Error("双方证据为空或过大")
  const value: unknown = JSON.parse(text), stack = [{ value, depth: 0 }]; let work = 0
  while (stack.length) {
    const item = stack.pop()!
    if (++work > 200000 || item.depth > 72) throw new Error("双方证据过深或过大")
    if (item.value && typeof item.value === "object") {
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 })
    }
  }
  return checkDualResourceEvidence(value)
}
export function serializeDualResourceEvidence(value: ScheduleDualResourceEvidence): string {
  return `${JSON.stringify(parseDualResourceEvidence(JSON.stringify(value)))}\n`
}
