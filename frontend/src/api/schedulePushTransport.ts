import { SchedulePushTransportError } from "@/shared/schedulePush"
import type { SchedulePushTransport } from "@/shared/schedulePush"

import { ApiError, postPinnedSchedule } from "./request"

export function createSchedulePushTransport(unavailable?: () => void): SchedulePushTransport {
  return { async push(body, lease) {
    try { return await postPinnedSchedule("/schedules/sync/push", body, lease) }
    catch (error) {
      const status = error instanceof ApiError ? error.status : undefined
      if (status === 404 || status === 405 || status === 501) unavailable?.()
      const reason = status === 401 ? "unauthorized" : status === 409 ? "retry" : status === 422 ? "invalid_request" :
        status && status >= 500 ? "storage" : "network"
      throw new SchedulePushTransportError(reason)
    }
  } }
}
