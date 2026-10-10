import { captureSyncContext } from "@/api/syncContext"
import { conversionCanonical, conversionCopy } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { parseScheduleTerminalReview } from "@/shared/scheduleTerminalReview"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"

import { assertScheduleLease, readCheckedConversionQueue } from "./scheduleSyncStateRepo"
import { db } from "./schema"

export interface ScheduleTerminalReviewTransport { review(id: string,lease: ConversionLease): Promise<unknown> }
async function snapshot(id: string,lease: ConversionLease) {
  const log=await db.meta.get(SCHEDULE_META_KEYS.conflicts),purges=await db.meta.get("pendingPurges")
  if (log && !Array.isArray(log.value)) throw new Error("冲突记录损坏")
  if (purges && (!Array.isArray(purges.value) || purges.value.some(raw=>typeof raw!=="string" || !raw))) throw new Error("弃去队列损坏")
  const conflicts=(log?.value ?? []) as unknown[]
  return {source:await db.schedules.get(id) ?? null,entry:await db.entries.get(id) ?? null,
    linkedEntries:await db.entries.where("fromScheduleId").equals(id).toArray(),
    intentions:(await readCheckedConversionQueue(lease.ownerUserId)).filter(row=>row.scheduleId===id),
    candidates:conflicts.filter(raw=>raw && typeof raw==="object" && "scheduleId" in raw && raw.scheduleId===id),
    pendingPurges:purges?.value ?? [],scheduleDraft:(await db.meta.get(SCHEDULE_META_KEYS.draft))?.value ?? null}
}
/** Read-only prerequisite for a future explicit resolver; no ACK, merge, archive or protection release. */
export function createInternalScheduleTerminalReviewer(transport: ScheduleTerminalReviewTransport) {
  let busy=false
  return {async review(id: string){
    if (busy) return {ready:false,reason:"busy",resolutionEnabled:false}
    busy=true
    try {
      if (scheduleEntryId(id)!==id) throw new Error("来源ID无效")
      const lease=await captureSyncContext()
      const local=await db.transaction("r",db.schedules,db.entries,db.meta,async()=>{
        await assertScheduleLease(lease);const value=await snapshot(id,lease);await assertScheduleLease(lease);return conversionCopy(value)
      })
      const server=parseScheduleTerminalReview(await transport.review(id,conversionCopy(lease)),id)
      await db.transaction("r",db.schedules,db.entries,db.meta,async()=>{
        await assertScheduleLease(lease)
        if (conversionCanonical(await snapshot(id,lease))!==conversionCanonical(local)) throw new Error("核对期间本机状态变化，请重新读取")
        await assertScheduleLease(lease)
      })
      return {ready:true,reason:"read_only_review",resolutionEnabled:false,localIntentStatus:"not_checked",local,server}
    } catch {return {ready:false,reason:"review_unconfirmed",resolutionEnabled:false} }
    finally {busy=false}
  }}
}
