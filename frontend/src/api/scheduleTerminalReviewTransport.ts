import type { ScheduleTerminalReviewTransport } from "@/db/scheduleTerminalReviewRepo"

import { getPinnedScheduleReview } from "./request"

export function createScheduleTerminalReviewTransport(): ScheduleTerminalReviewTransport {
  return {async review(id,lease){return getPinnedScheduleReview(id,lease)}}
}
