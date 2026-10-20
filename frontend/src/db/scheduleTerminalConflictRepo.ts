import { createConflictEvidenceFilePreserver } from "@/io/scheduleConflictEvidenceFile"
import type { ConflictEvidenceFileHandle } from "@/io/scheduleConflictEvidenceFile"
import { createScheduleSourceTombstoneResolver } from "@/shared/scheduleSourceTombstone"
import { terminalSourceTombstoneEvidence } from "@/shared/scheduleTerminalConflict"
import { captureSyncContext } from "@/api/syncContext"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { chosenTerminalEntry, createScheduleTerminalConflictResolver, terminalVersionKey } from "@/shared/scheduleTerminalConflict"
import type { TerminalConflictPort, TerminalConflictSnapshot, TerminalConflictTicket, TerminalConflictTransport } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"

import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db } from "./schema"

async function records(key: string): Promise<unknown[]> {
  const row=await db.meta.get(key)
  if(row && !Array.isArray(row.value))throw new Error("冲突或留档元数据损坏")
  return (row?.value??[]) as unknown[]
}
const target=(raw: unknown,id: string)=>!!raw && typeof raw==="object" && "scheduleId" in raw && raw.scheduleId===id
function entryConflict(raw: unknown,id: string): boolean {
  if(!raw || typeof raw!=="object")return false
  const row=raw as {entryId?: unknown;local?: {id?: unknown};server?: {id?: unknown}}
  return (row.entryId??row.local?.id??row.server?.id)===id
}
async function snapshot(id: string,lease: ConversionLease): Promise<TerminalConflictSnapshot>{
  const queue=await readCheckedConversionQueue(lease.ownerUserId),intentions=queue.filter(row=>row.scheduleId===id)
  const purges=(await db.meta.get("pendingPurges"))?.value??[]
  if(!Array.isArray(purges) || purges.some(raw=>typeof raw!=="string" || !raw))throw new Error("弃去队列损坏")
  const media=await db.media.where("entryId").equals(id).toArray()
  for(const mediaId of new Set(intentions.flatMap(row=>row.protectedMediaIds??[]))){const held=await db.media.get(mediaId);if(held && !media.some(row=>row.id===mediaId))media.push(held)}
  return {source:await db.schedules.get(id)??null,entry:await db.entries.get(id)??null,linkedEntries:await db.entries.where("fromScheduleId").equals(id).toArray(),intentions,
    candidates:(await records(SCHEDULE_META_KEYS.conflicts)).filter(row=>target(row,id)),media,pendingPurges:purges as string[],
    p2Conflicts:(await records("conflicts")).filter(row=>entryConflict(row,id)),scheduleDraft:(await db.meta.get(SCHEDULE_META_KEYS.draft))?.value??null,
    diaryDraft:(await db.meta.get("draft"))?.value??null}
}
async function check(ticket: Omit<TerminalConflictTicket,"server">){
  await assertScheduleLease(ticket.lease)
  if(conversionCanonical(await snapshot(ticket.id,ticket.lease))!==ticket.fingerprint)throw new Error("本机来源、日记、候选、草稿或媒体保护已变化")
  await records(SCHEDULE_CONFLICT_ARCHIVE);await assertScheduleLease(ticket.lease)
}
const port: TerminalConflictPort={
  async capture(id){
    if(scheduleEntryId(id)!==id)throw new Error("来源ID无效")
    const lease=await captureSyncContext()
    return db.transaction("r",db.schedules,db.entries,db.media,db.meta,async()=>{
      await assertScheduleLease(lease);const local=await snapshot(id,lease)
      if(!local.candidates.length)throw new Error("没有待取舍候选")
      await records(SCHEDULE_CONFLICT_ARCHIVE);await assertScheduleLease(lease)
      return {id,lease,local:conversionCopy(local),fingerprint:conversionCanonical(local)}
    })
  },
  async verify(ticket){await db.transaction("r",db.schedules,db.entries,db.media,db.meta,async()=>{await check(ticket)})},
  async apply(ticket,choice,evidence){
    await db.transaction("rw",db.schedules,db.entries,db.media,db.meta,async()=>{
      await check(ticket)
      const cloud=ticket.server.schedule!,remote=ticket.server.entry!,source=ticket.local.source!,entry=ticket.local.entry!
      const base=await readScheduleServerState(ticket.lease,ticket.id)
      if((base && base.serverUpdatedAt>cloud.serverUpdatedAt) || (source.serverUpdatedAt && conversionUtc(source.serverUpdatedAt)>cloud.serverUpdatedAt) ||
          (entry.serverUpdatedAt && terminalVersionKey(entry.serverUpdatedAt)>terminalVersionKey(remote.serverUpdatedAt)))throw new Error("已知云端水位领先本次核对")
      if(base && base.serverUpdatedAt===cloud.serverUpdatedAt && conversionCanonical(base)!==conversionCanonical(cloud))throw new Error("同水位来源证明矛盾")
      const chosen=chosenTerminalEntry(ticket,choice,evidence.exportedAt),archive=await records(SCHEDULE_CONFLICT_ARCHIVE)
      await db.meta.put({key:SCHEDULE_CONFLICT_ARCHIVE,value:[...archive,{ownerUserId:ticket.lease.ownerUserId,generation:ticket.lease.generation,
        scheduleId:ticket.id,kind:"terminal-text-resolution",choice,evidence:conversionCopy(evidence),result:conversionCopy(chosen)}]})
      await rememberScheduleServerState(ticket.lease,cloud)
      await db.schedules.put({...conversionCopy(cloud),contentText:toPlainText(cloud.content),dirty:0})
      await db.entries.put({...chosen,contentText:toPlainText(chosen.content)})
      const queue=await readCheckedConversionQueue(ticket.lease.ownerUserId)
      await db.meta.put({key:SCHEDULE_META_KEYS.conversions,value:queue.filter(row=>row.scheduleId!==ticket.id)})
      const candidates=await records(SCHEDULE_META_KEYS.conflicts)
      await db.meta.put({key:SCHEDULE_META_KEYS.conflicts,value:candidates.filter(row=>!target(row,ticket.id))})
      await assertScheduleLease(ticket.lease)
    })
  },
}
/** Text-only explicit handoff. Reuses read-only review transport; does not call P2 or convert. */
export function createInternalScheduleTerminalConflictResolver(transport: TerminalConflictTransport){
  return createScheduleTerminalConflictResolver(port,transport)
}

/** Internal R2 source-only path. No diary writes, conversion ACK, queue/candidate removal or purge. */
export function createInternalScheduleSourceTombstoneResolver(transport: TerminalConflictTransport) {
  const controller = createScheduleSourceTombstoneResolver({ capture:port.capture, verify:port.verify,
    async applySource(ticket,evidence,active) {
      await db.transaction("rw",db.schedules,db.entries,db.media,db.meta,async () => {
        active(); await check(ticket); active()
        const validated = terminalSourceTombstoneEvidence(ticket)
        validated.exportedAt = evidence.exportedAt
        if (conversionCanonical(validated)!==conversionCanonical(evidence)) throw new Error("来源墓碑证据不一致")
        const cloud = ticket.server.schedule!, source = ticket.local.source!, base = await readScheduleServerState(ticket.lease,ticket.id)
        if ((base && base.serverUpdatedAt>cloud.serverUpdatedAt) ||
            (source.serverUpdatedAt && conversionUtc(source.serverUpdatedAt)>cloud.serverUpdatedAt)) throw new Error("云端来源水位倒退")
        if (base && base.serverUpdatedAt===cloud.serverUpdatedAt && conversionCanonical(base)!==conversionCanonical(cloud)) throw new Error("同水位来源证明矛盾")
        const archive = await records(SCHEDULE_CONFLICT_ARCHIVE)
        active()
        await db.meta.put({key:SCHEDULE_CONFLICT_ARCHIVE,value:[...archive,{kind:"terminal-source-tombstone",
          ownerUserId:ticket.lease.ownerUserId,generation:ticket.lease.generation,scheduleId:ticket.id,
          evidence:conversionCopy(evidence),result:conversionCopy(cloud)}]})
        await rememberScheduleServerState(ticket.lease,cloud)
        await db.schedules.put({...conversionCopy(cloud),contentText:toPlainText(cloud.content),dirty:0})
        await assertScheduleLease(ticket.lease); active()
      })
    },
  },transport)
  return { review:controller.review, cancel:controller.cancel,
    async resolve(reviewId: number, confirmed: boolean, handle?: ConflictEvidenceFileHandle) {
      return controller.resolve(reviewId,confirmed,handle ? createConflictEvidenceFilePreserver(handle) : undefined)
    },
  }
}
