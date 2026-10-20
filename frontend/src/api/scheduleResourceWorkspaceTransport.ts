import { createScheduleCloudResourceImageTransport } from "./scheduleCloudResourceImageTransport"
import { createScheduleTagPublicationTransport, createScheduleTagHandoffTransport } from "./scheduleTagPublicationTransport"
/** Inert fixed-path transport composition; it starts no request or background scheduling. */
export function createScheduleResourceWorkspaceTransport() {
  const images = createScheduleCloudResourceImageTransport(), publication = createScheduleTagPublicationTransport(), handoff = createScheduleTagHandoffTransport()
  return { review: images.review, image: images.image, publish: publication.publish, checkTags: handoff.checkTags }
}
