import type { ConversionLease } from "@/shared/scheduleConversionSync"
import type { TagPublicationRequest } from "@/shared/scheduleTagPublication"
import { getPinnedScheduleResourceReview, postPinnedScheduleIndependentTags, reviewPinnedScheduleIndependentTags } from "./request"
import type { ScheduleCloudResourceTransport } from "./scheduleCloudResourceTransport"

export interface ScheduleTagPublicationTransport extends ScheduleCloudResourceTransport {
  publish(id: string, body: TagPublicationRequest, lease: ConversionLease, signal: AbortSignal): Promise<unknown>
}
/** Inert construction; no unpinned generic POST and no scheduling side effects. */
export function createScheduleTagPublicationTransport(): ScheduleTagPublicationTransport {
  return {
    review: (id, lease) => getPinnedScheduleResourceReview(id, lease),
    publish: (id, body, lease, signal) => postPinnedScheduleIndependentTags(id, body, lease, signal),
  }
}

export interface ScheduleTagHandoffTransport extends ScheduleCloudResourceTransport {
  checkTags(id: string, body: TagPublicationRequest, lease: ConversionLease, signal: AbortSignal): Promise<unknown>
}
export function createScheduleTagHandoffTransport(): ScheduleTagHandoffTransport {
  return { review: (id, lease) => getPinnedScheduleResourceReview(id, lease),
    checkTags: (id, body, lease, signal) => reviewPinnedScheduleIndependentTags(id, body, lease, signal) }
}
