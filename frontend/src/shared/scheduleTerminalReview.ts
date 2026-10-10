import { conversionCopy, conversionUtc, parseConversionEntry } from "./scheduleConversionSync"
import { parseScheduleWire } from "./schedulePush"
import { assertScheduleDate, scheduleEntryId } from "./schedules"
import type { Entry, Schedule } from "./types"

export interface ScheduleTerminalReview {
  readOnly: true; reviewable: boolean; reason: string; schedule: Schedule | null; entry: Entry | null
  entryState: "active" | "deleted" | "purged" | "unknown"; receiptKnown: boolean
  firstEntryDate: string | null; firstEntryDeleted: boolean | null
}
/** Preserve full P2 microseconds in read-only evidence; do not round them into writable CAS proof. */
function reviewWire(raw: unknown) {
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("核对版本结构无效")
  const validation=conversionCopy(raw) as Record<string,unknown>, times: Record<string,string|null>={}
  const names: Record<string,string>={created_at:"createdAt",updated_at:"updatedAt",client_updated_at:"clientUpdatedAt",deleted_at:"deletedAt",converted_at:"convertedAt"}
  for (const [wire,local] of Object.entries(names)) {
    if (!(wire in validation)) continue
    const at=validation[wire]
    if (at===null) {times[local]=null;continue}
    if (typeof at!=="string") throw new Error("核对时间无效")
    const match=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(at)
    if (!match) throw new Error("核对时间精度不受支持")
    const digits=(match[2]??"").padEnd(6,"0")
    const millis=conversionUtc(`${match[1]}.${digits.slice(0,3)}${match[3]??"Z"}`)
    const tail=digits.slice(3)
    times[local]=tail!=="000"?`${millis.slice(0,-1)}${tail}Z`:millis
    validation[wire]=millis
  }
  if (times.updatedAt) times.serverUpdatedAt=times.updatedAt
  return {validation,times}
}
/** A known cloud receipt is not confirmation or adoption of the current local intention. */
export function parseScheduleTerminalReview(raw: unknown,id: string): ScheduleTerminalReview {
  if (scheduleEntryId(id)!==id || !raw || typeof raw!=="object" || Array.isArray(raw)) throw new Error("终态核对响应无效")
  const r=raw as Record<string,unknown>
  const keys=["read_only","reviewable","reason","schedule","entry","entry_state","receipt_known","first_entry_date","first_entry_deleted"]
  if (Object.keys(r).some(key=>!keys.includes(key)) || r.read_only!==true || typeof r.reviewable!=="boolean" || typeof r.receipt_known!=="boolean" ||
      !["terminal_review","not_terminal","invalid_state","identity_conflict","receipt_unknown"].includes(String(r.reason))) throw new Error("终态核对不能伪装为转换确认")
  const sourceWire=r.schedule===null?null:reviewWire(r.schedule)
  const entryWire=r.entry===null?null:reviewWire(r.entry)
  const source=sourceWire?{...parseScheduleWire(sourceWire.validation,id),...sourceWire.times} as Schedule:null
  const entry=entryWire?{...parseConversionEntry(entryWire.validation,id),...entryWire.times} as Entry:null
  const state=r.entry_state
  if (!(["active","deleted","purged","unknown"].includes(String(state))) ||
      (state==="active" && (!entry || entry.isDeleted!==0)) || (state==="deleted" && (!entry || entry.isDeleted!==1)) ||
      (["purged","unknown"].includes(String(state)) && entry!==null)) throw new Error("核对日记状态不一致")
  if (r.receipt_known) {
    if (typeof r.first_entry_date!=="string" || typeof r.first_entry_deleted!=="boolean") throw new Error("首次回执摘要不完整")
    assertScheduleDate(r.first_entry_date)
    if (Number(r.first_entry_date.slice(0,4))<1000) throw new Error("首次日期超出范围")
  } else if (r.first_entry_date!==null || r.first_entry_deleted!==null) throw new Error("不能从当前日记猜首次回执")
  if (r.reviewable !== (r.reason==="terminal_review") ||
      (r.reviewable && (!r.receipt_known || source?.status!=="converted" || state==="unknown")) ||
      (r.reason==="receipt_unknown" && (r.receipt_known || source?.status!=="converted" || state==="unknown")) ||
      (r.reason==="not_terminal" && (source?.status!=="pending" || entry!==null || state!=="unknown" || r.receipt_known)) ||
      (["invalid_state","identity_conflict"].includes(String(r.reason)) && (entry!==null || state!=="unknown" || r.receipt_known))) throw new Error("核对证明和状态矛盾")
  return conversionCopy({readOnly:true,reviewable:r.reviewable,reason:r.reason,schedule:source,entry,entryState:state,receiptKnown:r.receipt_known,
    firstEntryDate:r.first_entry_date,firstEntryDeleted:r.first_entry_deleted}) as ScheduleTerminalReview
}
