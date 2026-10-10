import { SchedulePullTransportError } from "@/shared/schedulePull"
import type { SchedulePullTransport } from "@/shared/schedulePull"

import { ApiError, getPinnedScheduleChanges } from "./request"

export function createSchedulePullTransport(): SchedulePullTransport {
  return {
    async pull(params, lease) {
      try {
        return await getPinnedScheduleChanges(params, lease)
      } catch (error) {
        const status = error instanceof ApiError ? error.status : undefined
        const reason = status === 409 ? "cursor_or_lock_conflict"
          : status === 401 ? "unauthorized"
          : status === 422 ? "invalid_request" : "network"
        throw new SchedulePullTransportError(reason)
      }
    },
  }
}
