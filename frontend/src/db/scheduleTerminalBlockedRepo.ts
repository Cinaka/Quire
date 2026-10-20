import { captureSyncContext } from "@/api/syncContext"
import { createTerminalBlockedFilePreserver } from "@/io/scheduleTerminalBlockedFile"
import type { ConflictEvidenceFileHandle } from "@/io/scheduleConflictEvidenceFile"
import { conversionCanonical, conversionCopy } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { parseTerminalBlockedReview, terminalBlockedEvidence, terminalBlockers } from "@/shared/scheduleTerminalBlockers"
import type { TerminalBlockedEvidence } from "@/shared/scheduleTerminalBlockers"
import type { TerminalConflictTransport } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId } from "@/shared/schedules"
import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease } from "./scheduleSyncStateRepo"

/** Read-only local bytes plus current server observation. No download, mutation, ACK or release API. */
export function createInternalTerminalBlockedObserver(transport: TerminalConflictTransport){
  let busy=false,serial=0,pinned: string|null=null
  let ticket: {id: string;lease: ConversionLease;localKey: string;evidence: TerminalBlockedEvidence}|null=null
  const current=(run: number)=>{if(run!==serial)throw new Error("旧只读观察已失效")}
  const snapshot=async(id: string,lease: ConversionLease,run: number)=>{
    current(run);await assertScheduleLease(lease)
    const first=await captureScheduleResourceSnapshot(id,lease),encoded=await encodeScheduleResourceSnapshot(first,id,lease)
    current(run);await assertScheduleLease(lease);return encoded
  }
  const verify=async(active: NonNullable<typeof ticket>,run: number)=>{
    if(conversionCanonical(await snapshot(active.id,active.lease,run))!==active.localKey)throw new Error("观察期间本机内容或字节已变化")
    current(run);await assertScheduleLease(active.lease)
  }
  const cloud=async(active: NonNullable<typeof ticket>,run: number)=>{
    await verify(active,run)
    const server=parseTerminalBlockedReview(await transport.review(active.id,conversionCopy(active.lease)),active.id)
    await verify(active,run)
    if(conversionCanonical(server)!==conversionCanonical(active.evidence.server))throw new Error("云端观察已变化")
  }
  return {
    async review(id: string){
      if(busy)return {ready:false,reason:"busy",reviewId:0,resolutionEnabled:false}
      busy=true;ticket=null;const run=++serial
      try{
        if(scheduleEntryId(id)!==id)throw new Error("来源ID无效")
        const lease=await captureSyncContext();current(run)
        const identity=conversionCanonical({id,lease});if(pinned!==null && pinned!==identity)throw new Error("来源或登录恢复上下文已变化");pinned=identity
        const encoded=await snapshot(id,lease,run),local=scheduleResourceSnapshotEvidence(encoded,id)
        const server=parseTerminalBlockedReview(await transport.review(id,conversionCopy(lease)),id)
        const evidence=terminalBlockedEvidence(local,server),active={id,lease,localKey:conversionCanonical(encoded),evidence}
        await verify(active,run);ticket=conversionCopy(active)
        return {ready:true,reason:"read_only_observation",reviewId:run,blocks:terminalBlockers(evidence),
          completeLocalResources:local.completeLocalResources,cloudResourcesIncluded:false,resolutionEnabled:false,
          localIntentStatus:"not_checked",cloudSynced:false}
      }catch{ticket=null;return {ready:false,reason:"observation_unconfirmed_keep_library",reviewId:0,resolutionEnabled:false}}
      finally{busy=false}
    },
    async save(reviewId: number,confirmed: boolean,handle?: ConflictEvidenceFileHandle){
      if(busy)return {saved:false,reason:"busy",resolutionEnabled:false}
      if(!ticket || reviewId!==serial || confirmed!==true || !handle)return {saved:false,reason:"explicit_observation_file_required",resolutionEnabled:false}
      busy=true;const active=conversionCopy(ticket),run=serial
      try{
        await cloud(active,run)
        await createTerminalBlockedFilePreserver(handle)(conversionCopy(active.evidence))
        await cloud(active,run);current(run);ticket=null
        return {saved:true,reason:"local_evidence_and_cloud_observation_saved",completeLocalResources:active.evidence.local.completeLocalResources,
          cloudResourcesIncluded:false,resolutionEnabled:false,localIntentStatus:"not_checked",cloudSynced:false}
      }catch{ticket=null;return {saved:false,reason:"observation_save_unconfirmed_recheck_keep_file_and_library",resolutionEnabled:false}}
      finally{busy=false}
    },
    cancel(){++serial;ticket=null},
  }
}
