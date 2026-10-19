import { liveQuery } from "dexie"
import type { ScheduleHostContext } from "@/shared/scheduleHostTypes"
import { summarizeScheduleReminders } from "@/shared/scheduleReminder"
import type { ScheduleReminderPort } from "@/shared/scheduleReminder"
import { assertHostContext, captureHostContext } from "./scheduleHostContext"
import { localScheduleHostRepo } from "./scheduleHostRepo"
import { db } from "./schema"

/** Inert until read by an explicitly entered host. No auth, owner claim, network or writes. */
export function createLocalScheduleReminderPort(): ScheduleReminderPort {
  let context: ScheduleHostContext | null = null
  return {
    async read(today) {
      return db.transaction("r", db.schedules, db.meta, async () => {
        if (!context) context = await captureHostContext()
        const pinned = { ...context }
        await assertHostContext(pinned)
        const rows = await db.schedules.toArray()
        await assertHostContext(pinned)
        return summarizeScheduleReminders(rows, today)
      })
    },
    watch(changed, expired) {
      if (!context) throw new Error("请先读取固定上下文提醒")
      const pinned = { ...context }
      let stopped = false, subscription: { unsubscribe(): void } | undefined
      let stopOwner: (() => void) | undefined
      function stop(): void {
        if (stopped) return
        stopped = true; subscription?.unsubscribe(); stopOwner?.()
      }
      function revoke(): void { if (!stopped) { stop(); expired() } }
      try {
        // Reuse the existing host's DB-owner/epoch and auth-generation watcher.
        stopOwner = localScheduleHostRepo.watch(pinned, revoke)
        if (stopped) stopOwner()
        else {
          subscription = liveQuery(() => db.schedules.toArray()).subscribe({
            next() { if (!stopped) changed() }, error: revoke,
          })
          if (stopped) subscription.unsubscribe()
        }
      } catch { stop(); throw new Error("无法确认预简提醒上下文") }
      return stop
    },
  }
}
