import { isBackupConversion } from "./scheduleBackup"
import { assertKnownConflictSchedule } from "./scheduleConflict"
import { parseScheduleDraftState } from "./scheduleDrafts"
import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import type { ConversionLease } from "./scheduleConversionSync"
import { assertScheduleContent, assertScheduleDate } from "./schedules"
import { parseScheduleTerminalReview } from "./scheduleTerminalReview"
import type { ScheduleTerminalReview } from "./scheduleTerminalReview"
import type { Entry, Schedule, ScheduleConversion } from "./types"

export type TerminalConflictChoice = "cloud-source-keep-diary" | "cloud-source-use-diary"
export interface TerminalConflictSnapshot {
  source: Schedule | null; entry: Entry | null; linkedEntries: Entry[]; intentions: ScheduleConversion[]
  candidates: unknown[]; media: unknown[]; pendingPurges: string[]; p2Conflicts: unknown[]
  scheduleDraft: unknown; diaryDraft: unknown
}
export interface TerminalConflictTicket {
  id: string; lease: ConversionLease; fingerprint: string; local: TerminalConflictSnapshot; server: ScheduleTerminalReview
}
export interface TerminalConflictPort {
  capture(id: string): Promise<Omit<TerminalConflictTicket,"server">>
  verify(ticket: Omit<TerminalConflictTicket,"server">): Promise<void>
  apply(ticket: TerminalConflictTicket,choice: TerminalConflictChoice,evidence: TerminalConflictEvidence): Promise<void>
}
export interface TerminalConflictTransport {review(id: string,lease: ConversionLease): Promise<unknown>}
export interface TerminalConflictEvidence {
  app: "quire"; format: "terminal-text-conflict-evidence"; formatVersion: 1; exportedAt: string
  scheduleId: string; choice: TerminalConflictChoice; localSource: Schedule; localEntry: Entry
  cloudReview: ScheduleTerminalReview; intentions: unknown[]; candidates: unknown[]
  meaning: "explicit_choice_not_first_intent_confirmation"
}
const ENTRY_KEYS=new Set(["id","entryDate","sortOrder","title","content","contentText","mood","weather","tagIds","fromScheduleId","createdAt","updatedAt","clientUpdatedAt","serverUpdatedAt","deletedAt","isDeleted","dirty"])
/** Canonical microsecond key for comparison only; explicit next edits use a strictly greater millisecond. */
export function terminalVersionKey(raw: string): string {
  const m=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(raw)
  if (!m) throw new Error("日记修订必须是已归一UTC")
  const digits=(m[2]??"").padEnd(6,"0")
  const millis=conversionUtc(`${m[1]}.${digits.slice(0,3)}Z`)
  return `${millis.slice(0,-1)}${digits.slice(3)}Z`
}
export function assertTerminalTextEntry(raw: unknown,id: string): asserts raw is Entry {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("日记不存在")
  const r=raw as Entry
  if (Object.keys(r).some(key=>!ENTRY_KEYS.has(key)) || r.id!==id || r.fromScheduleId!==id || typeof r.title!=="string" || r.title.length>255 ||
      typeof r.contentText!=="string" || !Number.isSafeInteger(r.sortOrder) || r.sortOrder<0 || r.sortOrder>2147483647 ||
      !Array.isArray(r.tagIds) || r.tagIds.length || ![0,1].includes(r.dirty) || ![0,1].includes(r.isDeleted) ||
      !(r.mood===null || typeof r.mood==="string") || !(r.weather===null || typeof r.weather==="string")) throw new Error("仅支持稳定关联的无标签纯文本日记")
  if(r.serverUpdatedAt!=="" && typeof r.serverUpdatedAt!=="string")throw new Error("日记云端水位字段无效")
  assertScheduleDate(r.entryDate);assertScheduleContent(r.content)
  terminalVersionKey(r.createdAt);terminalVersionKey(r.updatedAt);const at=terminalVersionKey(r.clientUpdatedAt)
  if(r.serverUpdatedAt)terminalVersionKey(r.serverUpdatedAt)
  if(r.isDeleted===0 ? r.deletedAt!==null : r.deletedAt===null || terminalVersionKey(r.deletedAt)>at) throw new Error("日记删除修订不一致")
}
function portableIntent(raw: unknown,id: string,owner: string) {
  if (!isBackupConversion(raw) || raw.scheduleId!==id || Object.keys(raw).some(key=>!["scheduleId","source","entry","queuedAt","ownerUserId","protectedMediaIds"].includes(key))) throw new Error("首次意图未知")
  const intent=raw as ScheduleConversion
  if (intent.ownerUserId!==owner || intent.protectedMediaIds?.length) throw new Error("首次意图归属或媒体保护待处理")
  assertKnownConflictSchedule(intent.source,id);assertTerminalTextEntry(intent.entry,id);conversionUtc(intent.queuedAt)
  return {scheduleId:id,source:conversionCopy(intent.source),entry:conversionCopy(intent.entry),queuedAt:intent.queuedAt}
}
function candidateEvidence(raw: unknown,id: string,owner: string): unknown {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("未知候选")
  const r=raw as Record<string,unknown>
  const shapes: Record<string,string[]>={
    "conversion-entry":["scheduleId","kind","localEntry","serverEntry"],
    "conversion-ack":["scheduleId","kind","reason","firstIntent","serverSchedule","serverEntry"],
    "conversion-transport":["scheduleId","kind","firstIntent","stage","reason","serverSchedule","serverEntry","firstEntryDate","firstEntryDeleted"],
    "schedule-pull-conflict":["scheduleId","kind","reason","localSchedule","serverSchedule"],
    "schedule-push":["scheduleId","kind","reason","submitted","expectedServerRevision","serverSchedule"],
  }
  const allowed=typeof r.kind==="string"?shapes[r.kind]:undefined
  if (!allowed || r.scheduleId!==id || Object.keys(r).some(key=>!allowed.includes(key)) || allowed.some(key=>!(key in r) && !(r.kind==="conversion-entry" && key==="localEntry"))) throw new Error("候选结构未知，未删字段")
  if (r.reason!==undefined && !["identity","server_entry_changed","identity_conflict","invalid_state","source_deleted","source_revision","conversion_revision","source_content","source_snapshot","receipt_unknown","intent_conflict","stale","conflict","terminal","not_terminal","echo_mismatch","dirty_conflict","terminal_regression","terminal_source_changed","same_revision_conflict","revision_regression","entry_identity_conflict","retry","network","unauthorized","not_found","invalid_request","invalid_response","storage","aborted"].includes(String(r.reason))) throw new Error("候选原因未知")
  const result=conversionCopy(r)
  for(const key of ["localEntry","serverEntry"])if(result[key]!=null)assertTerminalTextEntry(result[key],id)
  for(const key of ["localSchedule","serverSchedule","submitted"])if(result[key]!=null)assertKnownConflictSchedule(result[key],id)
  if(result.firstIntent!==undefined)result.firstIntent=portableIntent(result.firstIntent,id,owner)
  if(result.stage!==undefined && !["source","convert"].includes(String(result.stage)))throw new Error("候选阶段未知")
  if(result.firstEntryDate!==undefined && result.firstEntryDate!==null){if(typeof result.firstEntryDate!=="string")throw new Error("候选首次日期无效");assertScheduleDate(result.firstEntryDate)}
  if(result.firstEntryDeleted!==undefined && result.firstEntryDeleted!==null && typeof result.firstEntryDeleted!=="boolean")throw new Error("候选首次状态无效")
  if(result.expectedServerRevision!==undefined && result.expectedServerRevision!==null)conversionUtc(result.expectedServerRevision)
  return result
}
export function terminalConflictChoices(ticket: TerminalConflictTicket): TerminalConflictChoice[] {
  const {id,local,server}=ticket
  if(!server.reviewable || !server.receiptKnown || server.reason!=="terminal_review" || !server.schedule || !server.entry || server.entryState==="purged")throw new Error("终态或回执尚不能取舍")
  assertKnownConflictSchedule(local.source,id);assertKnownConflictSchedule(server.schedule,id)
  assertTerminalTextEntry(local.entry,id);assertTerminalTextEntry(server.entry,id)
  const activeDraft=local.scheduleDraft!==null && parseScheduleDraftState(local.scheduleDraft).draft!==null
  if(local.source.status!=="converted" || server.schedule.status!=="converted" || local.source.isDeleted!==server.schedule.isDeleted ||
      local.linkedEntries.length!==1 || local.linkedEntries[0]?.id!==id || local.intentions.length>1 || !local.candidates.length ||
      local.media.length || local.pendingPurges.includes(id) || local.p2Conflicts.length || activeDraft || local.diaryDraft!==null) throw new Error("来源删除/身份/弃去/媒体/其他冲突或草稿待处理")
  assertTerminalTextEntry(local.linkedEntries[0],id)
  local.intentions.forEach(row=>portableIntent(row,id,ticket.lease.ownerUserId))
  local.candidates.forEach(row=>candidateEvidence(row,id,ticket.lease.ownerUserId))
  const choices: TerminalConflictChoice[]=[]
  if(local.entry.isDeleted===server.entry.isDeleted || local.entry.isDeleted===1)choices.push("cloud-source-keep-diary")
  if(local.entry.isDeleted===server.entry.isDeleted || server.entry.isDeleted===1)choices.push("cloud-source-use-diary")
  return choices
}
export function terminalConflictEvidence(ticket: TerminalConflictTicket,choice: TerminalConflictChoice): TerminalConflictEvidence {
  if(!terminalConflictChoices(ticket).includes(choice))throw new Error("选择未开放，不自动恢复日记")
  return {app:"quire",format:"terminal-text-conflict-evidence",formatVersion:1,exportedAt:conversionUtc(new Date().toISOString()),scheduleId:ticket.id,choice,
    localSource:conversionCopy(ticket.local.source!),localEntry:conversionCopy(ticket.local.entry!),cloudReview:conversionCopy(ticket.server),
    intentions:ticket.local.intentions.map(row=>portableIntent(row,ticket.id,ticket.lease.ownerUserId)),
    candidates:ticket.local.candidates.map(row=>candidateEvidence(row,ticket.id,ticket.lease.ownerUserId)),meaning:"explicit_choice_not_first_intent_confirmation"}
}
export function chosenTerminalEntry(ticket: TerminalConflictTicket,choice: TerminalConflictChoice,now: string): Entry {
  terminalConflictEvidence(ticket,choice)
  if(choice==="cloud-source-use-diary")return {...conversionCopy(ticket.server.entry!),dirty:0}
  const local=ticket.local.entry!,remote=ticket.server.entry!
  // Floor plus one millisecond is strictly greater even when either saved revision has microseconds.
  const previous=Math.max(Date.parse(terminalVersionKey(local.clientUpdatedAt)),Date.parse(terminalVersionKey(remote.clientUpdatedAt)))
  const revision=conversionUtc(new Date(Math.max(previous+1,Date.parse(conversionUtc(now)))).toISOString())
  return {...conversionCopy(local),updatedAt:revision,clientUpdatedAt:revision,serverUpdatedAt:remote.serverUpdatedAt,dirty:1}
}
/** Explicit text-only resolution. No conversion POST, P2 run, or silent discard of old intent. */
export function createScheduleTerminalConflictResolver(port: TerminalConflictPort,transport: TerminalConflictTransport) {
  let ticket: TerminalConflictTicket|null=null,serial=0,busy=false
  return {
    async review(id: string){
      if(busy)return {ready:false,reason:"busy",reviewId:0,choices:[] as TerminalConflictChoice[]}
      busy=true;ticket=null;const reviewId=++serial
      try{
        const local=await port.capture(id),server=parseScheduleTerminalReview(await transport.review(id,conversionCopy(local.lease)),id)
        await port.verify(local);ticket=conversionCopy({...local,server})
        let choices: TerminalConflictChoice[]=[];try{choices=terminalConflictChoices(ticket)}catch{/* protected read-only */}
        return {ready:true,reason:choices.length?"explicit_text_choices":"read_only_protected",reviewId,choices,local:conversionCopy(local.local),server:conversionCopy(server),sourcePolicy:"accept-cloud-terminal"}
      }catch{ticket=null;return {ready:false,reason:"review_unconfirmed",reviewId:0,choices:[] as TerminalConflictChoice[]}}
      finally{busy=false}
    },
    async resolve(reviewId: number,choice: TerminalConflictChoice,confirmed: boolean,preserve?: (evidence: TerminalConflictEvidence)=>Promise<void>){
      if(busy)return {applied:false,reason:"busy"}
      if(!ticket || reviewId!==serial || !confirmed || typeof preserve!=="function" || !["cloud-source-keep-diary","cloud-source-use-diary"].includes(choice))return {applied:false,reason:"explicit_choice_and_export_required"}
      busy=true;const active=conversionCopy(ticket)
      try{
        const evidence=terminalConflictEvidence(active,choice)
        await port.verify(active)
        const latest=parseScheduleTerminalReview(await transport.review(active.id,conversionCopy(active.lease)),active.id)
        if(conversionCanonical(latest)!==conversionCanonical(active.server)){ticket=null;return {applied:false,reason:"server_changed_reopen"}}
        await port.verify(active);await preserve(conversionCopy(evidence));await port.verify(active)
        const afterExport=parseScheduleTerminalReview(await transport.review(active.id,conversionCopy(active.lease)),active.id)
        if(conversionCanonical(afterExport)!==conversionCanonical(active.server)){ticket=null;return {applied:false,reason:"server_changed_reopen"}}
        await port.verify(active);await port.apply(active,choice,evidence);ticket=null
        return {applied:true,reason:choice==="cloud-source-keep-diary"?"local_diary_ready_for_p2":"cloud_diary_adopted",localIntentStatus:active.local.intentions.length?"superseded_by_explicit_choice":"no_local_intent"}
      }catch{return {applied:false,reason:"resolution_unconfirmed"}}
      finally{busy=false}
    },
  }
}
