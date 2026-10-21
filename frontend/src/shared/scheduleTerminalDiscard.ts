import { conversionCanonical, conversionCopy } from "./scheduleConversionSync"
import { terminalDiscardEvidence } from "./scheduleTerminalConflict"
import type { TerminalConflictTicket, TerminalConflictTransport, TerminalDiscardChoice, TerminalDiscardEvidence } from "./scheduleTerminalConflict"
import { parseScheduleTerminalReview } from "./scheduleTerminalReview"
export interface TerminalDiscardPort {
  capture(id: string): Promise<Omit<TerminalConflictTicket,"server">>
  verify(ticket: Omit<TerminalConflictTicket,"server">): Promise<void>
  applyDiscard(ticket: TerminalConflictTicket, evidence: TerminalDiscardEvidence, check: () => void): Promise<void>
}
/** Converges an existing purge request, never starts remote deletion or synthesizes a first receipt. */
export function createScheduleTerminalDiscardResolver(port: TerminalDiscardPort, transport: TerminalConflictTransport) {
  let ticket: TerminalConflictTicket | null = null, pinned: string | null = null, busy=false, serial=0
  const current=(run: number)=>{if(run!==serial)throw new Error("旧弃去核对已失效")}
  const verify=async(active: TerminalConflictTicket,run: number)=>{current(run);await port.verify(active);current(run)}
  const cloud=async(active: TerminalConflictTicket,run: number)=>{
    await verify(active,run)
    const latest=parseScheduleTerminalReview(await transport.review(active.id,conversionCopy(active.lease)),active.id)
    await verify(active,run)
    if(conversionCanonical(latest)!==conversionCanonical(active.server))throw new Error("云端弃去证明已变化")
  }
  return {
    async review(id: string){
      if(busy)return {ready:false,reason:"busy",reviewId:0,choices:[] as TerminalDiscardChoice[]}
      busy=true;ticket=null;const run=++serial
      try {
        const captured=await port.capture(id);current(run)
        const identity=conversionCanonical({id:captured.id,lease:captured.lease})
        if(pinned!==null && pinned!==identity)throw new Error("来源或账号恢复上下文变化")
        pinned=identity;await port.verify(captured);current(run)
        const server=parseScheduleTerminalReview(await transport.review(id,conversionCopy(captured.lease)),id)
        await port.verify(captured);current(run)
        const active=conversionCopy({...captured,server}),choices: TerminalDiscardChoice[]=[]
        for(const choice of ["finish-cloud-purged","handoff-cleared-tombstone"] as TerminalDiscardChoice[]){
          try{terminalDiscardEvidence(active,choice);choices.push(choice)}catch{/* no widening for unknown states */}
        }
        ticket=choices.length?active:null
        return {ready:true,reason:choices.length?"explicit_existing_purge_choices":"read_only_protected",reviewId:run,choices,
          local:conversionCopy(active.local),server:conversionCopy(server),cloudSynced:false}
      }catch{ticket=null;return {ready:false,reason:"review_unconfirmed",reviewId:0,choices:[] as TerminalDiscardChoice[]}}
      finally{busy=false}
    },
    async resolve(reviewId: number,choice: TerminalDiscardChoice,confirmed: boolean,preserve?: (evidence: TerminalDiscardEvidence)=>Promise<void>){
      if(busy)return {applied:false,reason:"busy",cloudSynced:false}
      if(!ticket || reviewId!==serial || confirmed!==true || typeof preserve!=="function")return {applied:false,reason:"explicit_existing_purge_and_file_required",cloudSynced:false}
      busy=true;const active=conversionCopy(ticket),run=serial
      try{
        const evidence=terminalDiscardEvidence(active,choice)
        await cloud(active,run);await preserve(conversionCopy(evidence));await cloud(active,run);await verify(active,run)
        await port.applyDiscard(active,evidence,()=>current(run));current(run);ticket=null
        return {applied:true,reason:choice==="finish-cloud-purged"?"cloud_absence_adopted":"cleared_tombstone_ready_for_p2",
          localIntentStatus:"superseded_by_explicit_existing_purge",cloudSynced:false}
      }catch{ticket=null;return {applied:false,reason:"discard_unconfirmed_recheck",cloudSynced:false}}
      finally{busy=false}
    },
    cancel(){++serial;ticket=null},
  }
}
