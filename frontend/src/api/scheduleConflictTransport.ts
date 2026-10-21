import type { ScheduleConflictTransport } from "@/shared/scheduleConflict"

import { getPinnedScheduleDetail } from "./request"

/** Factory creation is inert; review does not mutate cloud state. */
export function createScheduleConflictTransport(): ScheduleConflictTransport {
  return { async detail(id,lease) {return getPinnedScheduleDetail(id,lease)} }
}
