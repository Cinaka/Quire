import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { getPinnedScheduleResourceReview } from "./request"

export interface ScheduleCloudResourceTransport {
  review(id: string, lease: ConversionLease): Promise<unknown>
}
/** A fixed-account GET factory; constructing it does not start any network request. */
export function createScheduleCloudResourceTransport(): ScheduleCloudResourceTransport {
  return { async review(id, lease) { return getPinnedScheduleResourceReview(id, lease) } }
}
