import { captureSyncContext } from "@/api/syncContext"
import { isBackupSchedule, scheduleContentTooNew } from "@/shared/scheduleBackup"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import { createSchedulePullCoordinator, readScopedPullCursor } from "@/shared/schedulePull"
import type { SchedulePullItem, SchedulePullPort, SchedulePullTransport } from "@/shared/schedulePull"
import { sameScheduleBusiness } from "@/shared/schedulePush"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"
import type { Schedule } from "@/shared/types"

import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db } from "./schema"

async function log(key: string): Promise<unknown[]> {
  const stored = await db.meta.get(key)
  if (stored && !Array.isArray(stored.value)) throw new Error("日程候选日志损坏")
  return (stored?.value ?? []) as unknown[]
}
async function retain(key: string, value: unknown) {
  const records = await log(key)
  if (!records.some(row => conversionCanonical(row) === conversionCanonical(value))) await db.meta.put({ key,value:[...records,conversionCopy(value)] })
}
function sameVersion(a: Schedule, b: Schedule): boolean {
  return sameScheduleBusiness(a,b) && conversionUtc(a.clientUpdatedAt) === b.clientUpdatedAt &&
    a.isDeleted === b.isDeleted && (a.deletedAt === null ? null : conversionUtc(a.deletedAt)) === b.deletedAt
}
const scheduleFields = new Set(["id","remindDate","title","content","contentText","status","convertedEntryId","convertedAt","createdAt","updatedAt","clientUpdatedAt","serverUpdatedAt","deletedAt","isDeleted","dirty"])
const port: SchedulePullPort = {
  async capture(limit) {
    const lease = await captureSyncContext()
    return db.transaction("r",db.meta,async()=>{
      await assertScheduleLease(lease); await readCheckedConversionQueue(lease.ownerUserId)
      await log(SCHEDULE_META_KEYS.conflicts); await log(SCHEDULE_META_KEYS.errors)
      const stored = await db.meta.get(SCHEDULE_META_KEYS.cursor), raw = stored?.value ?? null
      const cursor = readScopedPullCursor(raw,lease)
      await assertScheduleLease(lease)
      return { lease,cursor,fingerprint:conversionCanonical(raw),limit }
    })
  },
  async apply(ticket,page) {
    return db.transaction("rw",db.schedules,db.entries,db.meta,async()=>{
      await assertScheduleLease(ticket.lease)
      const currentCursor = (await db.meta.get(SCHEDULE_META_KEYS.cursor))?.value ?? null
      if (conversionCanonical(currentCursor) !== ticket.fingerprint) return { applied:false,items:[] }
      const queue = await readCheckedConversionQueue(ticket.lease.ownerUserId)
      const protectedIds = new Set(queue.map(row=>row.scheduleId)), conflicts = await log(SCHEDULE_META_KEYS.conflicts)
      const blocked = new Set(conflicts.flatMap(raw=>raw && typeof raw === "object" && "scheduleId" in raw && typeof raw.scheduleId === "string" ? [raw.scheduleId] : []))
      const items: SchedulePullItem[] = []
      for (const incoming of page.rows) {
        const local = await db.schedules.get(incoming.id)
        const base = await readScheduleServerState(ticket.lease,incoming.id)
        let reason = "", kind: "held" | "conflict" = "conflict"
        if (protectedIds.has(incoming.id)) { reason="conversion_pending";kind="held" }
        else if (blocked.has(incoming.id)) { reason="conflict_pending";kind="held" }
        else if (scheduleContentTooNew(incoming) || (local && scheduleContentTooNew(local))) reason="unsupported_content"
        else if (local && !isBackupSchedule(local)) reason="invalid_local"
        else if (local && Object.keys(local).some(key=>!scheduleFields.has(key))) reason="unknown_local_fields"
        else if ((base && base.serverUpdatedAt > incoming.serverUpdatedAt) || (local?.serverUpdatedAt && conversionUtc(local.serverUpdatedAt) > incoming.serverUpdatedAt)) { reason="older_server_state";kind="held" }
        else if (local?.dirty !== 1 && ((base && base.serverUpdatedAt === incoming.serverUpdatedAt && !sameVersion(base,incoming)) ||
          (local?.serverUpdatedAt && conversionUtc(local.serverUpdatedAt) === incoming.serverUpdatedAt && !sameVersion(local,incoming)))) reason="server_revision_conflict"
        else if (local?.dirty === 1) {
          if (sameVersion(local,incoming) || (base && sameVersion(base,incoming))) { reason="local_pending";kind="held" }
          else reason="dirty_conflict"
        } else if (local?.status === "converted" && incoming.status !== "converted") reason="terminal_regression"
        else if (local?.status === "converted" && (!sameScheduleBusiness(local,incoming) ||
          conversionUtc(base?.convertedAt ?? local.convertedAt) !== incoming.convertedAt || conversionUtc(base?.createdAt ?? local.createdAt) !== incoming.createdAt)) reason="terminal_source_changed"
        else if (local && conversionUtc(local.clientUpdatedAt) > incoming.clientUpdatedAt) reason="revision_regression"
        else if (local && conversionUtc(local.clientUpdatedAt) === incoming.clientUpdatedAt && !sameVersion(local,incoming)) reason="same_revision_conflict"
        if (!reason && incoming.status === "converted") {
          const existing = await db.entries.get(incoming.id), linked = await db.entries.where("fromScheduleId").equals(incoming.id).toArray()
          if ((existing && existing.fromScheduleId !== incoming.id) || linked.length > 1 || linked.some(row=>row.id!==incoming.id)) reason="entry_identity_conflict"
        }
        if (reason) {
          await retain(kind === "conflict" ? SCHEDULE_META_KEYS.conflicts : SCHEDULE_META_KEYS.errors,
            { scheduleId:incoming.id,kind:kind === "held" ? "schedule-pull-held" : "schedule-pull-conflict",reason,
              localSchedule:local ?? null,serverSchedule:incoming })
          items.push({id:incoming.id,kind,reason});continue
        }
        const accepted = { ...incoming,contentText:toPlainText(incoming.content) }
        await rememberScheduleServerState(ticket.lease,accepted)
        await db.schedules.put(accepted)
        items.push({id:incoming.id,kind:"merged",reason:"server_version"})
      }
      await db.meta.put({key:SCHEDULE_META_KEYS.cursor,value:{ownerUserId:ticket.lease.ownerUserId,generation:ticket.lease.generation,...page.next}})
      await assertScheduleLease(ticket.lease)
      return {applied:true,items}
    })
  },
  async failed(ticket,reason) {
    await db.transaction("rw",db.meta,async()=>{
      await assertScheduleLease(ticket.lease)
      const raw = (await db.meta.get(SCHEDULE_META_KEYS.cursor))?.value ?? null
      if (conversionCanonical(raw)!==ticket.fingerprint) return
      await retain(SCHEDULE_META_KEYS.errors,{kind:"schedule-pull-error",reason,cursor:ticket.cursor})
      await assertScheduleLease(ticket.lease)
    })
  },
}
/** Internal and explicit; never modifies entries/media/tags or the P2 cursor. */
export function createInternalSchedulePullCoordinator(transport: SchedulePullTransport) {
  return createSchedulePullCoordinator(port,transport)
}
