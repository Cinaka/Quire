import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceTransport } from "@/api/scheduleCloudResourceTransport"
import { assertMatchedResourceBytes } from "@/io/scheduleResourceConflictFile"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { parseScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import type { ScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { checkResourceConflictEvidence, chosenResourceEntry, matchedResourceChoices } from "@/shared/scheduleResourceConflict"
import type { ScheduleResourceConflictEvidence } from "@/shared/scheduleResourceConflict"
import type { ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import { terminalVersionKey } from "@/shared/scheduleTerminalConflict"
import type { TerminalConflictChoice } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"

import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db, waitForScheduleResourceBytes } from "./schema"

interface Ticket {
  id: string; lease: ConversionLease; fingerprint: string; local: ScheduleResourceEvidence
  cloud: ScheduleCloudResourceReview; wire: unknown
}
async function archiveRows(): Promise<unknown[]> {
  const row = await db.meta.get(SCHEDULE_CONFLICT_ARCHIVE)
  if (row && !Array.isArray(row.value)) throw new Error("留档元数据损坏")
  return row?.value as unknown[] ?? []
}
async function current(id: string, lease: ConversionLease, insideWrite = false) {
  const raw = await captureScheduleResourceSnapshot(id, lease)
  // Blob JSON is {}, so metadata comparison alone is never byte verification.
  const pending = encodeScheduleResourceSnapshot(raw, id, lease)
  const value = insideWrite ? await waitForScheduleResourceBytes(pending) : await pending
  await assertScheduleLease(lease)
  await archiveRows()
  return { fingerprint: conversionCanonical({ metadata: raw, value }), local: scheduleResourceSnapshotEvidence(value, id) }
}
async function verify(ticket: Ticket) {
  const latest = await current(ticket.id, ticket.lease)
  if (latest.fingerprint !== ticket.fingerprint) throw new Error("来源、候选、媒体字节、标签或保护已变化")
}
async function apply(ticket: Ticket, choice: TerminalConflictChoice, evidence: ScheduleResourceConflictEvidence) {
  await db.transaction("rw", db.schedules, db.entries, db.tags, db.media, db.meta, async () => {
    const latest = await current(ticket.id, ticket.lease, true)
    if (latest.fingerprint !== ticket.fingerprint) throw new Error("事务内资源已经变化")
    const cloud = ticket.cloud.review.schedule!, remote = ticket.cloud.review.entry!, source = ticket.local.state.source!, entry = ticket.local.state.entry!
    const base = await readScheduleServerState(ticket.lease, ticket.id)
    if ((base && terminalVersionKey(base.serverUpdatedAt) > terminalVersionKey(cloud.serverUpdatedAt)) ||
        (source.serverUpdatedAt && terminalVersionKey(source.serverUpdatedAt) > terminalVersionKey(cloud.serverUpdatedAt)) ||
        (entry.serverUpdatedAt && terminalVersionKey(entry.serverUpdatedAt) > terminalVersionKey(remote.serverUpdatedAt))) throw new Error("本机已知水位领先云端证明")
    if (base && base.serverUpdatedAt === cloud.serverUpdatedAt && conversionCanonical(base) !== conversionCanonical(cloud)) throw new Error("同水位来源证明矛盾")
    const chosen = chosenResourceEntry(ticket.local, ticket.cloud, choice, evidence.exportedAt), archive = await archiveRows()
    await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: [...archive, { ownerUserId: ticket.lease.ownerUserId,
      generation: ticket.lease.generation, scheduleId: ticket.id, kind: "terminal-matched-resource-resolution", choice,
      evidence: conversionCopy(evidence), result: conversionCopy(chosen) }] })
    await rememberScheduleServerState(ticket.lease, cloud)
    await db.schedules.put({ ...conversionCopy(cloud), contentText: toPlainText(cloud.content), dirty: 0 })
    await db.entries.put({ ...chosen, contentText: toPlainText(chosen.content) })
    const queue = await readCheckedConversionQueue(ticket.lease.ownerUserId)
    await db.meta.put({ key: SCHEDULE_META_KEYS.conversions, value: queue.filter(row => row.scheduleId !== ticket.id) })
    const candidates = (await db.meta.get(SCHEDULE_META_KEYS.conflicts))?.value
    if (!Array.isArray(candidates)) throw new Error("候选元数据损坏")
    await db.meta.put({ key: SCHEDULE_META_KEYS.conflicts, value: candidates.filter(raw => !raw || typeof raw !== "object" || !("scheduleId" in raw) || raw.scheduleId !== ticket.id) })
    // Shared tag definitions, media bytes/IDs/dirty, P2 conflicts, cursors and purge queues are read-only.
    await assertScheduleLease(ticket.lease)
  })
}
/** Unmounted explicit handoff for already-present, byte-identical current cloud resources only. */
export function createInternalScheduleResourceConflictResolver(transport: ScheduleCloudResourceTransport) {
  let ticket: Ticket | null = null, serial = 0, busy = false
  return {
    async review(id: string) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0, choices: [] as TerminalConflictChoice[] }
      busy = true; ticket = null; const reviewId = ++serial
      try {
        if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
        const lease = await captureSyncContext(), snapshot = await current(id, lease)
        const wire = conversionCopy(await transport.review(id, conversionCopy(lease))), cloud = parseScheduleCloudResourceReview(wire, id)
        const active = { id, lease, ...snapshot, cloud, wire }
        await verify(active)
        let choices: TerminalConflictChoice[] = []
        try { await assertMatchedResourceBytes(snapshot.local, cloud); choices = matchedResourceChoices(snapshot.local, cloud) } catch { /* keep protected */ }
        await verify(active); ticket = conversionCopy(active)
        return { ready: true, reason: choices.length ? "explicit_matched_resource_choices" : "read_only_protected", reviewId, choices,
          local: conversionCopy(snapshot.local), server: conversionCopy(cloud), sourcePolicy: "accept-cloud-terminal" }
      } catch { return { ready: false, reason: "resource_review_unconfirmed", reviewId: 0, choices: [] as TerminalConflictChoice[] } }
      finally { busy = false }
    },
    async resolve(reviewId: number, choice: TerminalConflictChoice, confirmed: boolean, preserve?: (evidence: ScheduleResourceConflictEvidence) => Promise<void>) {
      if (busy) return { applied: false, reason: "busy" }
      if (!ticket || reviewId !== serial || !confirmed || typeof preserve !== "function" ||
          !["cloud-source-keep-diary", "cloud-source-use-diary"].includes(choice)) return { applied: false, reason: "explicit_choice_and_export_required" }
      busy = true; const active = conversionCopy(ticket)
      try {
        const evidence = checkResourceConflictEvidence({ app: "quire", format: "terminal-matched-resource-conflict-evidence", formatVersion: 1,
          exportedAt: conversionUtc(new Date().toISOString()), scheduleId: active.id, choice, local: active.local, cloud: active.wire,
          meaning: "explicit_choice_not_first_intent_confirmation" })
        await assertMatchedResourceBytes(active.local, active.cloud)
        await verify(active)
        for (const boundary of ["before_export", "after_export"] as const) {
          const cloud = parseScheduleCloudResourceReview(await transport.review(active.id, conversionCopy(active.lease)), active.id)
          if (conversionCanonical(cloud) !== conversionCanonical(active.cloud)) { ticket = null; return { applied: false, reason: "server_changed_reopen" } }
          await verify(active)
          if (boundary === "before_export") { await preserve(conversionCopy(evidence)); await verify(active) }
        }
        await apply(active, choice, evidence); ticket = null
        return { applied: true, reason: choice === "cloud-source-keep-diary" ? "local_diary_ready_for_p2" : "cloud_diary_adopted",
          localIntentStatus: active.local.state.intentions.length ? "superseded_by_explicit_choice" : "no_local_intent" }
      } catch { ticket = null; return { applied: false, reason: "resource_resolution_unconfirmed" } }
      finally { busy = false }
    },
  }
}
