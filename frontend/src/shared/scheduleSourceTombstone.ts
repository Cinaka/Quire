import { conversionCanonical, conversionCopy } from "./scheduleConversionSync"
import { terminalSourceTombstoneEvidence } from "./scheduleTerminalConflict"
import type { TerminalConflictTicket, TerminalConflictTransport, TerminalSourceTombstoneEvidence } from "./scheduleTerminalConflict"
import { parseScheduleTerminalReview } from "./scheduleTerminalReview"

export interface SourceTombstonePort {
  capture(id: string): Promise<Omit<TerminalConflictTicket,"server">>
  verify(ticket: Omit<TerminalConflictTicket,"server">): Promise<void>
  applySource(ticket: TerminalConflictTicket, evidence: TerminalSourceTombstoneEvidence, check: () => void): Promise<void>
}
/** Fixed first-use session. All server access is read-only; source-only application retains protection. */
export function createScheduleSourceTombstoneResolver(port: SourceTombstonePort, transport: TerminalConflictTransport) {
  let ticket: TerminalConflictTicket | null = null, pinned: { id: string; lease: string } | null = null
  let serial = 0, busy = false
  const current = (run: number) => { if (run !== serial) throw new Error("旧来源墓碑会话已失效") }
  async function verify(active: TerminalConflictTicket, run: number) {
    current(run); await port.verify(active); current(run)
  }
  async function cloud(active: TerminalConflictTicket, run: number) {
    await verify(active,run)
    const latest = parseScheduleTerminalReview(await transport.review(active.id,conversionCopy(active.lease)),active.id)
    await verify(active,run)
    if (conversionCanonical(latest)!==conversionCanonical(active.server)) throw new Error("云端核对已变化")
  }
  return {
    async review(id: string) {
      if (busy) return { ready:false, reason:"busy", reviewId:0, sourceDeletionEnabled:false }
      busy = true; ticket = null; const run = ++serial
      try {
        const captured = await port.capture(id); current(run)
        const identity = { id:captured.id, lease:conversionCanonical(captured.lease) }
        if (pinned && conversionCanonical(pinned)!==conversionCanonical(identity)) throw new Error("来源或登录恢复上下文已改变")
        pinned = identity
        await port.verify(captured); current(run)
        const server = parseScheduleTerminalReview(await transport.review(id,conversionCopy(captured.lease)),id)
        await port.verify(captured); current(run)
        const active = conversionCopy({...captured,server})
        let enabled = false
        try { terminalSourceTombstoneEvidence(active); enabled = true } catch { /* known narrow path only */ }
        ticket = enabled ? active : null
        return { ready:true, reason:enabled?"explicit_cloud_source_tombstone":"read_only_protected", reviewId:run,
          sourceDeletionEnabled:enabled, local:conversionCopy(active.local), server:conversionCopy(server),
          diaryChanged:false, localIntentStatus:"retained_not_confirmed", cloudSynced:false }
      } catch { ticket = null; return { ready:false, reason:"review_unconfirmed", reviewId:0, sourceDeletionEnabled:false } }
      finally { busy = false }
    },
    async resolve(reviewId: number, confirmed: boolean, preserve?: (evidence: TerminalSourceTombstoneEvidence) => Promise<void>) {
      if (busy) return { applied:false, reason:"busy", cloudSynced:false }
      if (!ticket || reviewId!==serial || confirmed!==true || typeof preserve!=="function") {
        return { applied:false, reason:"explicit_source_deletion_and_file_required", cloudSynced:false }
      }
      busy = true; const active = conversionCopy(ticket), run = serial
      try {
        const evidence = terminalSourceTombstoneEvidence(active)
        await cloud(active,run)
        await preserve(conversionCopy(evidence))
        await cloud(active,run)
        await verify(active,run)
        await port.applySource(active,evidence,() => current(run))
        current(run); ticket = null
        return { applied:true, reason:"source_tombstone_accepted_protection_retained", diaryChanged:false,
          localIntentStatus:"retained_not_confirmed", cloudSynced:false }
      } catch { ticket = null; return { applied:false, reason:"source_deletion_unconfirmed_recheck", cloudSynced:false } }
      finally { busy = false }
    },
    cancel() { ++serial; ticket = null },
  }
}
