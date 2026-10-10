import { isBackupSchedule, scheduleContentTooNew } from "./scheduleBackup"
import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import type { ConversionLease } from "./scheduleConversionSync"
import { parseScheduleWire } from "./schedulePush"
import { assertScheduleBody, nextScheduleRevision } from "./schedules"
import type { Schedule } from "./types"

export const SCHEDULE_CONFLICT_ARCHIVE = "scheduleConflictArchive"
export type ScheduleConflictChoice = "keep-local" | "use-cloud"
export interface ScheduleConflictSnapshot {
  local: Schedule | null; records: unknown[]; queue: unknown[]; linkedEntries: unknown[]; draft: unknown
}
export interface ScheduleConflictTicket {
  id: string; lease: ConversionLease; fingerprint: string; snapshot: ScheduleConflictSnapshot; server: Schedule
}
export interface ScheduleConflictEvidence {
  app: "quire"; format: "schedule-conflict-evidence"; formatVersion: 1; exportedAt: string; scheduleId: string
  choice: ScheduleConflictChoice; local: Schedule; server: Schedule; candidates: unknown[]
}
export interface ScheduleConflictPort {
  capture(id: string): Promise<Omit<ScheduleConflictTicket,"server">>
  verify(ticket: Omit<ScheduleConflictTicket,"server">): Promise<void>
  apply(ticket: ScheduleConflictTicket, choice: ScheduleConflictChoice, evidence: ScheduleConflictEvidence): Promise<void>
}
export interface ScheduleConflictTransport { detail(id: string, lease: ConversionLease): Promise<unknown> }
const FIELDS = new Set(["id","remindDate","title","content","contentText","status","convertedEntryId","convertedAt","createdAt","updatedAt","clientUpdatedAt","serverUpdatedAt","deletedAt","isDeleted","dirty"])
export function assertKnownConflictSchedule(raw: unknown, id: string): asserts raw is Schedule {
  if (!isBackupSchedule(raw) || raw.id !== id || scheduleContentTooNew(raw) || Object.keys(raw).some(key=>!FIELDS.has(key))) throw new Error("未知来源字段或正文不能取舍")
  assertScheduleBody(raw.title,raw.content)
  conversionUtc(raw.createdAt);conversionUtc(raw.updatedAt)
  if (raw.serverUpdatedAt) conversionUtc(raw.serverUpdatedAt)
  if (raw.convertedAt) conversionUtc(raw.convertedAt)
  const client = conversionUtc(raw.clientUpdatedAt)
  if (raw.deletedAt !== null && conversionUtc(raw.deletedAt)>client) throw new Error("来源墓碑修订异常")
}
function reports(records: unknown[], id: string): unknown[] {
  if (!records.length) throw new Error("没有待取舍候选")
  return records.map(raw=>{
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("冲突候选未知")
    const r=raw as Record<string,unknown>
    const keys = r.kind === "schedule-push" ? ["scheduleId","kind","reason","submitted","expectedServerRevision","serverSchedule"]
      : r.kind === "schedule-pull-conflict" ? ["scheduleId","kind","reason","localSchedule","serverSchedule"] : null
    if (!keys || Object.keys(r).some(key=>!keys.includes(key)) || r.scheduleId!==id || typeof r.reason!=="string" || !["stale","conflict","terminal","not_terminal","invalid_state","source_revision","echo_mismatch","dirty_conflict","unsupported_content","invalid_local","unknown_local_fields","server_revision_conflict","terminal_regression","terminal_source_changed","revision_regression","same_revision_conflict","entry_identity_conflict"].includes(r.reason)) throw new Error("候选格式尚不支持取舍")
    const local = r.kind === "schedule-push" ? r.submitted : r.localSchedule
    if (local !== null) {assertKnownConflictSchedule(local,id);if (local.status!=="pending") throw new Error("历史来源已终态")}
    if (r.serverSchedule !== null) {assertKnownConflictSchedule(r.serverSchedule,id);if (r.serverSchedule.status!=="pending") throw new Error("历史来源已终态")}
    if (r.kind === "schedule-push" && r.expectedServerRevision !== null) conversionUtc(r.expectedServerRevision)
    return conversionCopy(r)
  })
}
export function conflictEvidence(ticket: ScheduleConflictTicket, choice: ScheduleConflictChoice): ScheduleConflictEvidence {
  const {snapshot,server,id}=ticket
  assertKnownConflictSchedule(snapshot.local,id);assertKnownConflictSchedule(server,id)
  if (snapshot.local.status!=="pending" || server.status!=="pending" || snapshot.queue.length || snapshot.linkedEntries.length || snapshot.draft!==null) throw new Error("转换、终态、关联日记或安全草稿需要独立处理")
  return { app:"quire",format:"schedule-conflict-evidence",formatVersion:1,exportedAt:conversionUtc(new Date().toISOString()),scheduleId:id,
    choice,local:conversionCopy(snapshot.local),server:conversionCopy(server),candidates:reports(snapshot.records,id) }
}
export function chosenConflictSchedule(ticket: ScheduleConflictTicket, choice: ScheduleConflictChoice, now: string): Schedule {
  conflictEvidence(ticket,choice)
  if (choice === "use-cloud") return conversionCopy(ticket.server)
  const local=ticket.snapshot.local!
  const previous=conversionUtc(local.clientUpdatedAt)>ticket.server.clientUpdatedAt?conversionUtc(local.clientUpdatedAt):ticket.server.clientUpdatedAt
  const revision=conversionUtc(nextScheduleRevision(previous,conversionUtc(now)))
  return { ...conversionCopy(local),updatedAt:revision,clientUpdatedAt:revision,serverUpdatedAt:ticket.server.serverUpdatedAt,dirty:1 }
}
/** Single private review ticket. No auto-adoption, network write, or fallback that bypasses evidence export. */
export function createScheduleConflictResolver(port: ScheduleConflictPort, transport: ScheduleConflictTransport) {
  let ticket: ScheduleConflictTicket | null = null, serial=0, busy=false
  return {
    async review(id: string) {
      if (busy) return {ready:false,reason:"busy",reviewId:0,choices:[] as ScheduleConflictChoice[]}
      busy=true;ticket=null;const reviewId=++serial
      try {
        const capture=await port.capture(id)
        const server=parseScheduleWire(await transport.detail(id,conversionCopy(capture.lease)),id)
        await port.verify(capture);ticket=conversionCopy({...capture,server})
        let choices: ScheduleConflictChoice[]=[]
        try {conflictEvidence(ticket,"use-cloud");choices=["keep-local","use-cloud"]} catch { /* read-only evidence remains available */ }
        return {ready:true,reason:choices.length?"pending_choices":"read_only_protected",reviewId,choices,
          local:conversionCopy(capture.snapshot.local),server:conversionCopy(server),candidates:conversionCopy(capture.snapshot.records)}
      } catch {ticket=null;return {ready:false,reason:"review_unconfirmed",reviewId:0,choices:[] as ScheduleConflictChoice[]} }
      finally {busy=false}
    },
    async resolve(reviewId: number, choice: ScheduleConflictChoice, confirmed: boolean,
      preserve?: (evidence: ScheduleConflictEvidence) => Promise<void>) {
      if (busy) return {applied:false,reason:"busy"}
      if (!ticket || reviewId!==serial || !confirmed || !["keep-local","use-cloud"].includes(choice) || typeof preserve!=="function") return {applied:false,reason:"explicit_choice_and_export_required"}
      busy=true
      const active=conversionCopy(ticket)
      try {
        const evidence=conflictEvidence(active,choice)
        await port.verify(active)
        const latest=parseScheduleWire(await transport.detail(active.id,conversionCopy(active.lease)),active.id)
        if (conversionCanonical(latest)!==conversionCanonical(active.server)) {ticket=null;return {applied:false,reason:"server_changed_reopen"} }
        await port.verify(active)
        await preserve(conversionCopy(evidence))
        await port.verify(active)
        await port.apply(active,choice,evidence)
        ticket=null
        return {applied:true,reason:choice==="keep-local"?"local_dirty_preserved":"cloud_adopted"}
      } catch {return {applied:false,reason:"resolution_unconfirmed"} }
      finally {busy=false}
    },
  }
}
