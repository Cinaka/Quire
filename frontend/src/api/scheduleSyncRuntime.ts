import { liveQuery } from "dexie"
import { db } from "@/db/schema"
import { localScheduleHostRepo } from "@/db/scheduleHostRepo"
import { createInternalScheduleSyncCoordinator } from "@/db/scheduleSyncRepo"
import { readCheckedConversionQueue } from "@/db/scheduleSyncStateRepo"
import { conversionCanonical, conversionCopy } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { summarizeScheduleSyncIssues } from "@/shared/scheduleSyncIssues"
import { createScheduleSyncRuntime } from "@/shared/scheduleSyncRuntime"
import type { ScheduleRuntimePort } from "@/shared/scheduleSyncRuntime"
import type { Schedule } from "@/shared/types"
import { createScheduleConversionTransport } from "./scheduleConversionTransport"
import { createSchedulePushTransport } from "./schedulePushTransport"
import { createSchedulePullTransport } from "./schedulePullTransport"

// A known protective hold is not permission to merge/clear it; it only allows another bounded cycle.
const safePushHolds = new Set(["conversion_pending", "changed_locally", "older_server_state"])
const safePullHolds = new Set(["conversion_pending", "local_pending", "older_server_state"])
const retryableErrors = new Set(["network", "retry", "storage", "aborted", "ack_storage"])
export const scheduleRuntimePort: ScheduleRuntimePort = {
  capture: () => localScheduleHostRepo.capture(),
  verify: context => localScheduleHostRepo.validate(context),
  online: () => navigator.onLine, foreground: () => document.visibilityState === "visible",
  later: (work, delay) => window.setTimeout(work, delay), clear: timer => window.clearTimeout(timer),
  watch(context, changed, expired) {
    const pin = conversionCopy(context)
    let last: string | undefined, stopped = false, stopOwner: (() => void) | undefined
    let subscription: { unsubscribe(): void } | undefined
    const stop = () => {
      if (stopped) return
      stopped = true
      try { stopOwner?.() } catch { /* continue revoking the other observer */ }
      try { subscription?.unsubscribe() } catch { /* session remains stopped */ }
    }
    const revoke = () => { if (!stopped) { stop(); expired() } }
    try {
      stopOwner = localScheduleHostRepo.watch(pin, revoke)
      if (stopped) { stopOwner(); return stop }
      subscription = liveQuery(() => db.transaction("r", db.schedules, db.meta, async () => {
        await localScheduleHostRepo.validate(pin)
        const rows: Schedule[] = await db.schedules.where("dirty").equals(1).toArray(), queue = await readCheckedConversionQueue(pin.ownerUserId)
        await localScheduleHostRepo.validate(pin)
        // ACK/cursor/error writes alone cannot cause a perpetual scheduling feedback loop.
        return conversionCanonical({ dirty: rows.filter(row => row.dirty === 1).map(row => [row.id, row.clientUpdatedAt, row.status, row.deletedAt]).sort(), queue })
      })).subscribe({ next(value: string) { if (stopped) return; const previous = last; last = value; if (previous !== undefined && previous !== value) changed() }, error: revoke })
      if (stopped) subscription?.unsubscribe()
      return stop
    } catch (error) { stop(); throw error }
  },
  async run(context, active) {
    const pin = conversionCopy(context), lease: ConversionLease = { ownerUserId: pin.ownerUserId, generation: pin.generation, tokenGeneration: pin.authGeneration }
    let unsupported = false
    const unavailable = () => { unsupported = true }
    const guard = async () => {
      if (!active() || unsupported) throw new Error("本次日程调度已停止")
      await localScheduleHostRepo.validate(pin)
      if (!active()) throw new Error("旧日程调度已取消")
    }
    const conversion = createScheduleConversionTransport(unavailable), push = createSchedulePushTransport(unavailable), pull = createSchedulePullTransport(unavailable)
    const result = await createInternalScheduleSyncCoordinator({
      conversion: {
        async pushSource(body, candidate) { await guard(); const r = await conversion.pushSource(body, candidate); await guard(); return r },
        async convert(id, body, candidate) { await guard(); const r = await conversion.convert(id, body, candidate); await guard(); return r },
      },
      push: { async push(body, candidate) { await guard(); const r = await push.push(body, candidate); await guard(); return r } },
      pull: { async pull(params, candidate) { await guard(); const r = await pull.pull(params, candidate); await guard(); return r } },
    }, lease).runOnce()
    const blocked = (result.pending?.conflicts ?? 0) > 0 || result.conversions.some(row => row.kind !== "confirmed") || result.push?.items.some(row =>
      row.kind === "conflict" ||
      (row.kind === "held" && !safePushHolds.has(row.reason) && !(result.stopped && retryableErrors.has(row.reason))) ||
      (row.kind === "error" && !retryableErrors.has(row.reason))) === true ||
      result.pull.some(page => page.items.some(row => row.kind === "conflict" || (row.kind === "held" && !safePullHolds.has(row.reason))))
    const pending = result.pending
    return { issues: summarizeScheduleSyncIssues(result), unsupported, blocked: !unsupported && blocked, failed: result.stopped || result.push?.items.some(row => row.kind === "error") === true, pending,
      more: pending !== null && (pending.dirty > 0 || pending.conversions > 0 || pending.pullContinuation) || result.push?.more === true || result.pull.at(-1)?.hasMore === true }
  },
}
export const scheduleSyncRuntime = createScheduleSyncRuntime(scheduleRuntimePort)
let installed = false
/** Install foreground signals only; no capture, request, claim or persisted preference until explicit enable. */
export function installScheduleSyncRuntime(): () => void {
  if (installed) return () => {}
  installed = true
  const request = () => scheduleSyncRuntime.request(0)
  const visible = () => { if (document.visibilityState === "visible") request() }
  window.addEventListener("online", request); window.addEventListener("offline", request); window.addEventListener("focus", visible)
  document.addEventListener("visibilitychange", visible)
  const timer = window.setInterval(visible, 5 * 60_000)
  let live = true
  return () => {
    if (!live) return
    live = false
    if (!installed) return
    installed = false; window.clearInterval(timer)
    window.removeEventListener("online", request); window.removeEventListener("offline", request); window.removeEventListener("focus", visible)
    document.removeEventListener("visibilitychange", visible); scheduleSyncRuntime.pause()
  }
}
