import type { ScheduleCloudResourceReview } from "./scheduleCloudResources"
import { conversionCanonical } from "./scheduleConversionSync"
import { checkScheduleResourceEvidence } from "./scheduleResourceEvidence"
import type { ScheduleResourceEvidence } from "./scheduleResourceEvidence"
import { scheduleEntryId } from "./schedules"

export interface ScheduleResourceRepairStep { mediaId: string; createRow: boolean; fillOriginal: boolean; fillThumbnail: boolean }
export function assertResourceRepairTarget(local: ScheduleResourceEvidence, cloud: ScheduleCloudResourceReview, selected: string[]) {
  const value = checkScheduleResourceEvidence(local), state = value.state, review = cloud.review
  if (!state.source || !state.entry || state.source.status !== "converted" || !review.schedule || !review.entry ||
      review.schedule.status !== "converted" || state.source.id !== review.schedule.id || state.source.isDeleted !== review.schedule.isDeleted ||
      !review.receiptKnown || !review.reviewable || review.reason !== "terminal_review" || cloud.resourceState !== "verified" || !cloud.resourcesComplete ||
      value.entryPendingPurge || state.p2Conflicts.length || state.intentions.length !== 1 || !state.candidates.length || state.linkedEntries.length !== 1 ||
      conversionCanonical(state.entry) !== conversionCanonical(state.linkedEntries[0])) throw new Error("来源、日记或其他保护尚不能补齐资源")
  if (!Array.isArray(selected) || !selected.length || selected.length > 64 || new Set(selected).size !== selected.length ||
      selected.some(id => typeof id !== "string" || scheduleEntryId(id) !== id || !value.mediaIds.includes(id) || !cloud.mediaIds.includes(id))) {
    throw new Error("须明确选择已被本机保护且云端当前证明包含的媒体ID")
  }
}
