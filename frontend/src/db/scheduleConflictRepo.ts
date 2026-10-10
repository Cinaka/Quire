import { captureSyncContext } from "@/api/syncContext"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { chosenConflictSchedule, createScheduleConflictResolver, SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import type { ScheduleConflictPort, ScheduleConflictSnapshot, ScheduleConflictTicket, ScheduleConflictTransport } from "@/shared/scheduleConflict"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"

import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db } from "./schema"

async function records(key: string): Promise<unknown[]> {
  const row=await db.meta.get(key)
  if (row && !Array.isArray(row.value)) throw new Error("候选或取舍留档损坏")
  return (row?.value ?? []) as unknown[]
}
const target = (row: unknown,id: string) => !!row && typeof row==="object" && "scheduleId" in row && row.scheduleId===id
async function snapshot(id: string,lease: ConversionLease): Promise<ScheduleConflictSnapshot> {
  const candidates=await records(SCHEDULE_META_KEYS.conflicts)
  const queue=await readCheckedConversionQueue(lease.ownerUserId)
  const existing=await db.entries.get(id),linked=await db.entries.where("fromScheduleId").equals(id).toArray()
  const linkedEntries=existing && !linked.some(row=>row.id===existing.id)?[...linked,existing]:linked
  return {local:await db.schedules.get(id) ?? null,records:candidates.filter(row=>target(row,id)),queue:queue.filter(row=>row.scheduleId===id),
    linkedEntries,draft:(await db.meta.get(SCHEDULE_META_KEYS.draft))?.value ?? null}
}
async function check(ticket: Omit<ScheduleConflictTicket,"server">) {
  await assertScheduleLease(ticket.lease)
  const fresh=await snapshot(ticket.id,ticket.lease)
  if (conversionCanonical(fresh)!==ticket.fingerprint) throw new Error("候选、本机来源、草稿或意图已变化")
  await records(SCHEDULE_CONFLICT_ARCHIVE)
  await assertScheduleLease(ticket.lease)
}
const port: ScheduleConflictPort = {
  async capture(id) {
    if (scheduleEntryId(id)!==id) throw new Error("来源ID无效")
    const lease=await captureSyncContext()
    return db.transaction("r",db.schedules,db.entries,db.meta,async()=>{
      await assertScheduleLease(lease);const value=await snapshot(id,lease)
      if (!value.records.length) throw new Error("没有待取舍候选")
      await records(SCHEDULE_CONFLICT_ARCHIVE);await assertScheduleLease(lease)
      return {id,lease,snapshot:conversionCopy(value),fingerprint:conversionCanonical(value)}
    })
  },
  async verify(ticket) {
    await db.transaction("r",db.schedules,db.entries,db.meta,async()=>{await check(ticket)})
  },
  async apply(ticket,choice,evidence) {
    await db.transaction("rw",db.schedules,db.entries,db.meta,async()=>{
      await check(ticket)
      const base=await readScheduleServerState(ticket.lease,ticket.id)
      const local=ticket.snapshot.local!
      if ((base && base.serverUpdatedAt>ticket.server.serverUpdatedAt) || (local.serverUpdatedAt && conversionUtc(local.serverUpdatedAt)>ticket.server.serverUpdatedAt)) throw new Error("已知水位领先复核服务器版本")
      if (base && base.serverUpdatedAt===ticket.server.serverUpdatedAt && conversionCanonical(base)!==conversionCanonical(ticket.server)) throw new Error("同一云端水位的证明不一致")
      const chosen=chosenConflictSchedule(ticket,choice,evidence.exportedAt)
      const archive=await records(SCHEDULE_CONFLICT_ARCHIVE)
      // Full portable losing versions already exported; the runtime archive is additional, not backup-v3.
      await db.meta.put({key:SCHEDULE_CONFLICT_ARCHIVE,value:[...archive,{ownerUserId:ticket.lease.ownerUserId,generation:ticket.lease.generation,
        scheduleId:ticket.id,kind:"pending-resolution",choice,evidence:conversionCopy(evidence),result:conversionCopy(chosen)}]})
      await rememberScheduleServerState(ticket.lease,ticket.server)
      await db.schedules.put({...chosen,contentText:toPlainText(chosen.content)})
      const candidates=await records(SCHEDULE_META_KEYS.conflicts)
      await db.meta.put({key:SCHEDULE_META_KEYS.conflicts,value:candidates.filter(row=>!target(row,ticket.id))})
      await assertScheduleLease(ticket.lease)
    })
  },
}
/** Internal only. Caller must explicitly confirm and successfully preserve the evidence before any write. */
export function createInternalScheduleConflictResolver(transport: ScheduleConflictTransport) {
  return createScheduleConflictResolver(port,transport)
}
