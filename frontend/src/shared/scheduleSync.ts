import type { ConversionConsumeResult, ConversionLease } from "./scheduleConversionSync"
import type { SchedulePullItem } from "./schedulePull"
import type { SchedulePushOutcome } from "./schedulePush"

export interface ScheduleSyncOptions { maxConversions?: number; maxPullPages?: number; pageLimit?: number }
export interface ScheduleSyncPending { conversions: number; dirty: number; conflicts: number; pullContinuation: boolean }
export interface ScheduleSyncPushResult { sent: number; more: boolean; stopped: boolean; reason: string; items: SchedulePushOutcome[] }
export interface ScheduleSyncPullResult { applied: boolean; hasMore: boolean; reason: string; items: SchedulePullItem[] }
export interface ScheduleSyncPort {
  capture(): Promise<{ lease: ConversionLease; ids: string[] }>
  verify(lease: ConversionLease): Promise<void>
  consume(id: string, lease: ConversionLease): Promise<ConversionConsumeResult>
  push(lease: ConversionLease): Promise<ScheduleSyncPushResult>
  pull(limit: number, lease: ConversionLease): Promise<ScheduleSyncPullResult>
  inspect(lease: ConversionLease): Promise<ScheduleSyncPending>
}
/** Bounded explicit cycle only; never reports all diary/cloud data complete. */
export function createScheduleSyncCoordinator(port: ScheduleSyncPort) {
  let busy = false
  return { async runOnce(options: ScheduleSyncOptions = {}) {
    const conversions: Array<ConversionConsumeResult & { id: string }> = []
    let push: ScheduleSyncPushResult | null = null
    const pull: ScheduleSyncPullResult[] = []
    let pending: ScheduleSyncPending | null = null
    const result = (reason: string, stopped: boolean) => ({ reason, stopped, conversions, push, pull, pending,
      needsAnotherRun: stopped || pending === null || pending.conversions > 0 || pending.dirty > 0 || pending.conflicts > 0 || pending.pullContinuation || !!push?.more || !!pull.at(-1)?.hasMore })
    const maxConversions = options.maxConversions ?? 10, maxPullPages = options.maxPullPages ?? 3, pageLimit = options.pageLimit ?? 200
    if (![maxConversions,maxPullPages,pageLimit].every(Number.isSafeInteger) || maxConversions < 1 || maxConversions > 50 || maxPullPages < 1 || maxPullPages > 20 || pageLimit < 1 || pageLimit > 500) return result("invalid_options", true)
    if (busy) return result("busy", true)
    busy = true
    try {
      const ticket = await port.capture()
      for (const id of ticket.ids.slice(0,maxConversions)) {
        await port.verify(ticket.lease)
        conversions.push({ id, ...await port.consume(id,ticket.lease) })
        await port.verify(ticket.lease)
      }
      await port.verify(ticket.lease)
      push = await port.push(ticket.lease)
      await port.verify(ticket.lease)
      // A failed upstream request must not be hidden behind a later successful pull.
      if (push.stopped) { pending = await port.inspect(ticket.lease); return result("push_unconfirmed",true) }
      for (let n=0;n<maxPullPages;n++) {
        await port.verify(ticket.lease)
        const page = await port.pull(pageLimit,ticket.lease); pull.push(page)
        await port.verify(ticket.lease)
        if (!page.applied) { pending = await port.inspect(ticket.lease); return result("pull_unconfirmed",true) }
        if (!page.hasMore) break
      }
      pending = await port.inspect(ticket.lease)
      await port.verify(ticket.lease)
      return result("cycle_processed",false)
    } catch {
      // Earlier confirmed stages remain real; don't claim rollback of remote work.
      return result("context_or_storage_unconfirmed",true)
    } finally { busy = false }
  } }
}
