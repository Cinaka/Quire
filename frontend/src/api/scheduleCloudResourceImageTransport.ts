import type { CloudImageProof } from "@/shared/scheduleCloudResources"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { getPinnedScheduleResourceImage, getPinnedScheduleResourceReview } from "./request"
import type { ScheduleCloudResourceTransport } from "./scheduleCloudResourceTransport"

export type ResourceImageVariant = "original" | "thumbnail"
export interface ScheduleCloudResourceImageTransport extends ScheduleCloudResourceTransport {
  image(id: string, mediaId: string, variant: ResourceImageVariant, proof: CloudImageProof,
    lease: ConversionLease, signal: AbortSignal): Promise<unknown>
}
/** Construction is inert; only an explicit internal prepare starts authenticated GETs. */
export function createScheduleCloudResourceImageTransport(): ScheduleCloudResourceImageTransport {
  return {
    review: (id, lease) => getPinnedScheduleResourceReview(id, lease),
    image: (id, mediaId, variant, proof, lease, signal) =>
      getPinnedScheduleResourceImage(id, mediaId, variant, proof, lease, signal),
  }
}
