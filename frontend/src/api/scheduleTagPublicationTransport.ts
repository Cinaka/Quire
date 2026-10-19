import type { ConversionLease } from "@/shared/scheduleConversionSync"
import type { TagPublicationRequest } from "@/shared/scheduleTagPublication"
import { getPinnedScheduleResourceReview, postPinnedScheduleIndependentTags } from "./request"
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
