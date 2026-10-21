import { conflictEvidence } from "./scheduleConflict"
import type { ScheduleConflictEvidence, ScheduleConflictTicket } from "./scheduleConflict"
import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { terminalConflictEvidence, terminalSourceTombstoneEvidence, terminalDiscardEvidence } from "./scheduleTerminalConflict"
import type { TerminalConflictEvidence, TerminalConflictTicket, TerminalSourceTombstoneEvidence, TerminalDiscardEvidence, TerminalDiscardChoice } from "./scheduleTerminalConflict"
import { parseScheduleTerminalReview } from "./scheduleTerminalReview"
import { scheduleEntryId } from "./schedules"
import type { Entry, Schedule } from "./types"

export type ConflictEvidence = ScheduleConflictEvidence | TerminalConflictEvidence | TerminalSourceTombstoneEvidence | TerminalDiscardEvidence
export const CONFLICT_EVIDENCE_MAX_CHARS = 2 * 1024 * 1024
export const CONFLICT_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024
const VALIDATION_OWNER = "evidence-validation-only"
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("冲突证据字段无效")
  return raw as Record<string, unknown>
}
function exact(raw: unknown, keys: string[]) {
  const row = object(raw)
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row))) {
    throw new Error("冲突证据字段缺失或未知，未删字段")
  }
  return row
}
function array(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) throw new Error("冲突证据数组无效")
  return raw
}
function sourceWire(raw: unknown) {
  const r = object(raw) as unknown as Schedule
  return { id: r.id, remind_date: r.remindDate, title: r.title, content: r.content,
    content_text: r.contentText, status: r.status, converted_entry_id: r.convertedEntryId,
    converted_at: r.convertedAt, client_updated_at: r.clientUpdatedAt, deleted_at: r.deletedAt,
    created_at: r.createdAt, updated_at: r.serverUpdatedAt }
}
function entryWire(raw: unknown) {
  const r = object(raw) as unknown as Entry
  return { id: r.id, from_schedule_id: r.fromScheduleId, entry_date: r.entryDate,
    sort_order: r.sortOrder, title: r.title, content: r.content, content_text: r.contentText,
    mood: r.mood, weather: r.weather, tag_ids: r.tagIds, client_updated_at: r.clientUpdatedAt,
    deleted_at: r.deletedAt, created_at: r.createdAt, updated_at: r.serverUpdatedAt }
}
function intent(raw: unknown) {
  const row = exact(raw, ["scheduleId", "source", "entry", "queuedAt"])
  // A temporary validation owner is never imported, returned, or used as a runtime lease.
  return { ...row, ownerUserId: VALIDATION_OWNER }
}
function terminal(raw: Record<string, unknown>): TerminalConflictEvidence | TerminalSourceTombstoneEvidence | TerminalDiscardEvidence {
  const review = exact(raw.cloudReview, ["readOnly", "reviewable", "reason", "schedule", "entry",
    "entryState", "receiptKnown", "firstEntryDate", "firstEntryDeleted"])
  if (review.readOnly !== true) throw new Error("证据不是只读核对")
  const server = parseScheduleTerminalReview({ read_only: review.readOnly, reviewable: review.reviewable,
    reason: review.reason, schedule: sourceWire(review.schedule), entry: review.entry===null?null:entryWire(review.entry),
    entry_state: review.entryState, receipt_known: review.receiptKnown,
    first_entry_date: review.firstEntryDate, first_entry_deleted: review.firstEntryDeleted }, raw.scheduleId as string)
  if (conversionCanonical(server) !== conversionCanonical(review)) throw new Error("云端证据字段不一致")
  const candidates = array(raw.candidates).map(value => {
    const row = object(value)
    return row.firstIntent === undefined ? row : { ...row, firstIntent: intent(row.firstIntent) }
  })
  const ticket = { id: raw.scheduleId, lease: { ownerUserId: VALIDATION_OWNER, generation: "validation-only", tokenGeneration: 0 }, fingerprint: "",
    server, local: { source: raw.localSource, entry: raw.localEntry, linkedEntries: raw.localEntry===null?[]:[raw.localEntry],
      intentions: array(raw.intentions).map(intent), candidates, media: [], pendingPurges: raw.format==="terminal-discard-evidence"?array(raw.pendingPurges):[],
      p2Conflicts: [], scheduleDraft: null, diaryDraft: null } } as unknown as TerminalConflictTicket
  if(raw.format==="terminal-discard-evidence") return terminalDiscardEvidence(ticket,raw.choice as TerminalDiscardChoice)
  return raw.format === "terminal-source-tombstone-evidence" ? terminalSourceTombstoneEvidence(ticket)
    : terminalConflictEvidence(ticket, raw.choice as TerminalConflictEvidence["choice"])
}
function check(raw: unknown): ConflictEvidence {
  const r = object(raw)
  const pending = r.format === "schedule-conflict-evidence"
  const discard = r.format === "terminal-discard-evidence"
  const tombstone = r.format === "terminal-source-tombstone-evidence"
  const terminalFile = r.format === "terminal-text-conflict-evidence" || tombstone || discard
  if (!pending && !terminalFile) throw new Error("不是支持的冲突证据；不能当作防蠹备份导入")
  exact(r, pending ? ["app", "format", "formatVersion", "exportedAt", "scheduleId", "choice", "local", "server", "candidates"]
    : ["app", "format", "formatVersion", "exportedAt", "scheduleId", "choice", "localSource", "localEntry",
      "cloudReview", "intentions", "candidates", "meaning", ...(discard?["pendingPurges"]:[])])
  if (r.app !== "quire" || r.formatVersion !== 1 || typeof r.scheduleId !== "string" ||
      scheduleEntryId(r.scheduleId) !== r.scheduleId || typeof r.exportedAt !== "string" ||
      conversionUtc(r.exportedAt) !== r.exportedAt) throw new Error("冲突证据版本、身份或导出时间无效")
  if (pending ? !["keep-local", "use-cloud"].includes(String(r.choice))
    : discard ? !["finish-cloud-purged","handoff-cleared-tombstone"].includes(String(r.choice))
      : tombstone ? r.choice !== "accept-cloud-source-tombstone"
      : !["cloud-source-keep-diary", "cloud-source-use-diary"].includes(String(r.choice))) throw new Error("冲突证据选择无效")
  let regenerated: ConflictEvidence
  if (pending) {
    const ticket = { id: r.scheduleId, lease: { ownerUserId: VALIDATION_OWNER, generation: "validation-only", tokenGeneration: 0 },
      fingerprint: "", server: r.server, snapshot: { local: r.local,
      records: array(r.candidates), queue: [], linkedEntries: [], draft: null } } as ScheduleConflictTicket
    regenerated = conflictEvidence(ticket, r.choice as ScheduleConflictEvidence["choice"])
  } else {
    if (r.meaning !== (discard ? "existing_purge_not_first_intent_confirmation" : tombstone ? "source_only_not_diary_or_intent_confirmation" : "explicit_choice_not_first_intent_confirmation")) throw new Error("证据不能伪称首次意图确认")
    regenerated = terminal(r)
  }
  regenerated.exportedAt = r.exportedAt
  if (conversionCanonical(regenerated) !== conversionCanonical(r)) throw new Error("证据不能降级、丢字段或改写版本")
  return conversionCopy(regenerated)
}
/** Read-only file validation, not current-state verification or a restore/conversion instruction. */
export function parseConflictEvidenceFile(text: string): ConflictEvidence {
  if (typeof text !== "string" || !text.length || text.length > CONFLICT_EVIDENCE_MAX_CHARS) {
    throw new Error("冲突证据文件为空或超过本批文本限制")
  }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error("冲突证据JSON损坏") }
  // Bound traversal before recursive business canonicalization. Unknown future fields are not stripped.
  const stack: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const current = stack.pop()!
    if (++nodes > 100000 || current.depth > 64) throw new Error("冲突证据过深或过大")
    if (current.value && typeof current.value === "object") {
      for (const value of Object.values(current.value)) stack.push({ value, depth: current.depth + 1 })
    }
  }
  return check(raw)
}
export function serializeConflictEvidenceFile(evidence: ConflictEvidence): string {
  // JSON round-trip excludes JS objects/getters from the returned validation result; cycles fail closed.
  const text = JSON.stringify(evidence)
  const valid = parseConflictEvidenceFile(text)
  return `${JSON.stringify(valid)}\n`
}
export function conflictEvidenceFileName(evidence: ConflictEvidence): string {
  const valid = parseConflictEvidenceFile(serializeConflictEvidenceFile(evidence))
  return `quire-conflict-${valid.scheduleId}-${valid.exportedAt.replace(/[-:.]/g, "")}.json`
}
