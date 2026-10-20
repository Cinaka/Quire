import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { checkScheduleResourceEvidence, resourceEvidenceReferences, RESOURCE_EVIDENCE_MAX_BYTES } from "./scheduleResourceEvidence"
import type { ScheduleResourceEvidence } from "./scheduleResourceEvidence"
import { parseScheduleTerminalReview } from "./scheduleTerminalReview"
import type { ScheduleTerminalReview } from "./scheduleTerminalReview"
import { scheduleEntryId } from "./schedules"
import type { Entry, Schedule } from "./types"

export const TERMINAL_BLOCK_TEXT = {
  receipt_unknown: "服务端未提供可识别的首次转换回执。当前日记不是首次回执；不猜测、不清除原意图。",
  cloud_not_terminal: "本次云端来源尚未确认已转简，不根据本机状态覆写云端来源。",
  cloud_invalid_identity: "本次服务端报告来源状态或身份异常；保留原库，不合并身份、不重建日记。",
  local_source_not_terminal: "本机来源尚非已转简终态，不以观察文件推动转换或覆盖来源。",
  local_identity: "本机来源或关联日记身份不一致，不能选择另一条关联记录代替。",
  source_deletion_differs: "双方来源删除状态不同，来源删除与日记删除须分别明确处理。",
  local_entry_missing: "本机当前关联日记缺失。首次意图或历史候选不等于当前内容，不自动重建。",
  cloud_entry_deleted: "本次云端日记已软删除。不会自动恢复；已有永久弃去须另走明确处置。",
  cloud_entry_purged: "本次云端未保留关联日记。当前缺失不授权清除本机内容或猜测首次回执。",
  existing_purge: "本机已有永久弃去标记；本页不消费该标记或替代原明确处置。",
  first_intent_missing: "本机没有本来源的原转换意图。本次只保存观察，不构造替代首次快照。",
  local_resources_missing: "本机部分图片或标签实物缺失。文件会标明缺口，不能称为完整备份。",
  resources_need_review: "存在图片或标签引用；本文件只保全本机已有实物，不含云端图片字节或云端标签定义。",
  read_only_observation: "本页仅说明和保存当前观察；保存文件不确认转换、不解除保护、不启动同步。",
} as const
export const TERMINAL_OBSERVATION_FAILURE_TEXT = "当前观察或文件保存未核实。请保留原库、已保存文件和原意图，不清库、不强制同步；先处理未保存输入，再明确重新核对。此提示不推断具体故障或权限原因。"
export type TerminalBlock = keyof typeof TERMINAL_BLOCK_TEXT
export interface TerminalBlockedEvidence {
  app: "quire"; format: "terminal-blocked-observation"; formatVersion: 1; exportedAt: string; scheduleId: string
  local: ScheduleResourceEvidence; server: ScheduleTerminalReview; cloudMediaIds: string[]; cloudTagIds: string[]
  cloudResourcesIncluded: false; resolutionEnabled: false; meaning: "observation_not_receipt_ack_or_restore"
}
function exact(raw: unknown, keys: string[]) {
  if (!raw || typeof raw!=="object" || Array.isArray(raw) || Object.keys(raw).some(key=>!keys.includes(key)) || keys.some(key=>!(key in raw))) throw new Error("观察字段未知或缺失")
  return raw as Record<string,unknown>
}
/** Strict nested wire fields: never silently discard an unknown receipt/token field into a saved proof. */
export function parseTerminalBlockedReview(raw: unknown,id: string) {
  const r=raw as Record<string,unknown>
  if(r?.schedule!==null)exact(r?.schedule,["id","remind_date","title","content","content_text","status","converted_entry_id","converted_at","client_updated_at","deleted_at","created_at","updated_at"])
  if(r?.entry!==null)exact(r?.entry,["id","from_schedule_id","entry_date","sort_order","title","content","content_text","mood","weather","tag_ids","client_updated_at","deleted_at","created_at","updated_at"])
  return parseScheduleTerminalReview(raw,id)
}
function sourceWire(r: Schedule | null) { return r===null?null:{id:r.id,remind_date:r.remindDate,title:r.title,content:r.content,content_text:r.contentText,status:r.status,converted_entry_id:r.convertedEntryId,converted_at:r.convertedAt,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:r.serverUpdatedAt} }
function entryWire(r: Entry | null) { return r===null?null:{id:r.id,from_schedule_id:r.fromScheduleId,entry_date:r.entryDate,sort_order:r.sortOrder,title:r.title,content:r.content,content_text:r.contentText,mood:r.mood,weather:r.weather,tag_ids:r.tagIds,client_updated_at:r.clientUpdatedAt,deleted_at:r.deletedAt,created_at:r.createdAt,updated_at:r.serverUpdatedAt} }
function normalizedReview(raw: unknown,id: string) {
  const r=exact(raw,["readOnly","reviewable","reason","schedule","entry","entryState","receiptKnown","firstEntryDate","firstEntryDeleted"])
  const review=parseTerminalBlockedReview({read_only:r.readOnly,reviewable:r.reviewable,reason:r.reason,schedule:sourceWire(r.schedule as Schedule|null),entry:entryWire(r.entry as Entry|null),entry_state:r.entryState,receipt_known:r.receiptKnown,first_entry_date:r.firstEntryDate,first_entry_deleted:r.firstEntryDeleted},id)
  if(conversionCanonical(review)!==conversionCanonical(raw))throw new Error("观察不能改写或丢字段")
  return review
}
export function checkTerminalBlockedEvidence(raw: unknown): TerminalBlockedEvidence {
  const r=exact(raw,["app","format","formatVersion","exportedAt","scheduleId","local","server","cloudMediaIds","cloudTagIds","cloudResourcesIncluded","resolutionEnabled","meaning"])
  if(r.app!=="quire" || r.format!=="terminal-blocked-observation" || r.formatVersion!==1 || typeof r.scheduleId!=="string" || scheduleEntryId(r.scheduleId)!==r.scheduleId || typeof r.exportedAt!=="string" || conversionUtc(r.exportedAt)!==r.exportedAt || r.cloudResourcesIncluded!==false || r.resolutionEnabled!==false || r.meaning!=="observation_not_receipt_ack_or_restore")throw new Error("不是只读观察文件")
  const local=checkScheduleResourceEvidence(r.local),server=normalizedReview(r.server,r.scheduleId)
  if(local.scheduleId!==r.scheduleId || !local.state.source)throw new Error("观察来源不一致")
  const refs=resourceEvidenceReferences({source:server.schedule,entry:server.entry,linkedEntries:server.entry?[server.entry]:[],intentions:[],candidates:[],p2Conflicts:[]},r.scheduleId)
  if(conversionCanonical(refs.mediaIds)!==conversionCanonical(r.cloudMediaIds) || conversionCanonical(refs.tagIds)!==conversionCanonical(r.cloudTagIds))throw new Error("云端引用缺口不能伪称实物完整")
  return conversionCopy({...r,local,server}) as unknown as TerminalBlockedEvidence
}
export function terminalBlockedEvidence(local: ScheduleResourceEvidence,server: ScheduleTerminalReview): TerminalBlockedEvidence {
  const refs=resourceEvidenceReferences({source:server.schedule,entry:server.entry,linkedEntries:server.entry?[server.entry]:[],intentions:[],candidates:[],p2Conflicts:[]},local.scheduleId)
  return checkTerminalBlockedEvidence({app:"quire",format:"terminal-blocked-observation",formatVersion:1,exportedAt:conversionUtc(new Date().toISOString()),scheduleId:local.scheduleId,local,server,cloudMediaIds:refs.mediaIds,cloudTagIds:refs.tagIds,cloudResourcesIncluded:false,resolutionEnabled:false,meaning:"observation_not_receipt_ack_or_restore"})
}
export function terminalBlockers(input: TerminalBlockedEvidence): TerminalBlock[] {
  const e=checkTerminalBlockedEvidence(input),local=e.local.state,server=e.server,blocks: TerminalBlock[]=[]
  if(server.reason==="receipt_unknown")blocks.push("receipt_unknown")
  if(server.reason==="not_terminal")blocks.push("cloud_not_terminal")
  if(["invalid_state","identity_conflict"].includes(server.reason))blocks.push("cloud_invalid_identity")
  if(local.source?.status!=="converted")blocks.push("local_source_not_terminal")
  if(local.linkedEntries.length>1 || local.linkedEntries.some(row=>row.id!==e.scheduleId) || (local.entry!==null && local.linkedEntries.length!==1))blocks.push("local_identity")
  if(server.schedule && local.source?.isDeleted!==server.schedule.isDeleted)blocks.push("source_deletion_differs")
  if(local.entry===null)blocks.push("local_entry_missing")
  if(server.entryState==="deleted")blocks.push("cloud_entry_deleted")
  if(server.entryState==="purged")blocks.push("cloud_entry_purged")
  if(e.local.entryPendingPurge)blocks.push("existing_purge")
  if(!local.intentions.length)blocks.push("first_intent_missing")
  if(!e.local.completeLocalResources)blocks.push("local_resources_missing")
  if(e.cloudMediaIds.length || e.cloudTagIds.length || e.local.mediaIds.length || e.local.tagIds.length)blocks.push("resources_need_review")
  blocks.push("read_only_observation");return blocks
}
export function parseTerminalBlockedEvidence(text: string): TerminalBlockedEvidence {
  if(typeof text!=="string" || !text.length || text.length>RESOURCE_EVIDENCE_MAX_BYTES)throw new Error("观察文件为空或过大")
  const raw: unknown=JSON.parse(text),stack=[{value:raw,depth:0}];let work=0
  while(stack.length){const item=stack.pop()!;if(++work>200000 || item.depth>72)throw new Error("观察文件过深或过大");if(item.value&&typeof item.value==="object")for(const value of Object.values(item.value))stack.push({value,depth:item.depth+1})}
  return checkTerminalBlockedEvidence(raw)
}
export function serializeTerminalBlockedEvidence(evidence: TerminalBlockedEvidence) {return `${JSON.stringify(parseTerminalBlockedEvidence(JSON.stringify(evidence)))}\n`}
