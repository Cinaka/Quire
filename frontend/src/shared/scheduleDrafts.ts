import { assertScheduleContent, assertScheduleDate, scheduleEntryId } from "./schedules"
import type { EntryContent, Iso, LocalDate, Schedule } from "./types"

export interface ScheduleDraftPayload {
  scheduleId: string | null
  baseClientUpdatedAt: Iso | null
  remindDate: LocalDate
  title: string
  content: EntryContent | null
}
export interface ScheduleDraftSaveInput extends ScheduleDraftPayload {
  /** null只用于空槽的新草稿；继续编辑必须带read返回的同一草稿身份。 */
  draftId: string | null
}
export interface ScheduleEditorDraft extends ScheduleDraftPayload {
  draftId: string
  updatedAt: Iso
}
export interface ScheduleDraftState {
  formatVersion: 1
  revision: number
  draft: ScheduleEditorDraft | null
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function isDraftIso(value: unknown): value is Iso {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
}
export function assertDraftId(value: unknown): asserts value is string {
  if (typeof value !== "string" || scheduleEntryId(value) !== value) throw new Error("预简草稿ID无效")
}
const PAYLOAD_KEYS = new Set(["scheduleId", "baseClientUpdatedAt", "remindDate", "title", "content"])

/** 日期可以已到期，标题/正文可以暂空；安全草稿不代替业务创建校验。 */
export function parseScheduleDraftPayload(raw: unknown): ScheduleDraftPayload {
  if (!object(raw) || Object.keys(raw).some(key => !PAYLOAD_KEYS.has(key))) {
    throw new Error("预简草稿载荷无效，不接受日记图片或元信息")
  }
  if (raw.scheduleId === null) {
    if (raw.baseClientUpdatedAt !== null) throw new Error("新预简草稿不能绑定旧修订")
  } else {
    assertDraftId(raw.scheduleId)
    if (!isDraftIso(raw.baseClientUpdatedAt)) throw new Error("预简草稿缺少来源修订")
  }
  if (typeof raw.remindDate !== "string") throw new Error("预简草稿日期无效")
  assertScheduleDate(raw.remindDate)
  if (typeof raw.title !== "string" || raw.title.length > 255) throw new Error("预简草稿标题无效")
  assertScheduleContent(raw.content as EntryContent | null)
  // 校验后同步复制，避免等待写事务时调用方又修改同一正文对象。
  return {
    scheduleId: raw.scheduleId as string | null,
    baseClientUpdatedAt: raw.baseClientUpdatedAt as Iso | null,
    remindDate: raw.remindDate, title: raw.title,
    content: JSON.parse(JSON.stringify(raw.content)) as EntryContent | null,
  }
}
export function isScheduleEditorDraft(raw: unknown): raw is ScheduleEditorDraft {
  try {
    if (!object(raw)) return false
    const { draftId, updatedAt, ...payload } = raw
    assertDraftId(draftId)
    if (!isDraftIso(updatedAt)) return false
    parseScheduleDraftPayload(payload)
    return true
  } catch { return false }
}
export function emptyScheduleDraftState(): ScheduleDraftState {
  return { formatVersion: 1, revision: 0, draft: null }
}
/** 仅作操作期间的变更比较，不持久化/导出；包含空标记修订，避免清空再写回的ABA。 */
export function scheduleDraftFingerprint(exists: boolean, value: unknown): string {
  try {
    const result = JSON.stringify({ exists, value })
    if (typeof result !== "string") throw new Error("unserializable draft")
    return result
  } catch {
    throw new Error("预简草稿无法安全校验，已停止认领或清库")
  }
}
export function parseScheduleDraftState(raw: unknown): ScheduleDraftState {
  if (!object(raw) || Object.keys(raw).some(key => !["formatVersion", "revision", "draft"].includes(key)) ||
    raw.formatVersion !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 ||
    (raw.revision === 0 && raw.draft !== null) ||
    (raw.draft !== null && !isScheduleEditorDraft(raw.draft))) {
    throw new Error("预简草稿损坏或版本不受支持，已保留原值，未覆盖")
  }
  return JSON.parse(JSON.stringify(raw)) as ScheduleDraftState
}
export function advanceScheduleDraftState(
  state: ScheduleDraftState, draft: ScheduleEditorDraft | null,
): ScheduleDraftState {
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error("预简草稿修订已耗尽，已停止写入")
  return { formatVersion: 1, revision: state.revision + 1, draft }
}
export function matchesScheduleDraftBody(draft: ScheduleDraftPayload, row: Schedule): boolean {
  return draft.remindDate === row.remindDate && draft.title === row.title &&
    JSON.stringify(draft.content) === JSON.stringify(row.content)
}
export function remapScheduleDraft(
  draft: ScheduleEditorDraft, scheduleIds: ReadonlyMap<string, string>, asCopy: boolean, draftId: string,
): { draft: ScheduleEditorDraft; detached: boolean } {
  assertDraftId(draftId)
  const copy = JSON.parse(JSON.stringify(draft)) as ScheduleEditorDraft
  copy.draftId = draftId // 恢复是新的草稿会话，不复用旧保存回执。
  if (copy.scheduleId && scheduleIds.has(copy.scheduleId)) {
    copy.scheduleId = scheduleIds.get(copy.scheduleId)!
    return { draft: copy, detached: false }
  }
  if (copy.scheduleId && asCopy) {
    copy.scheduleId = null
    copy.baseClientUpdatedAt = null
    return { draft: copy, detached: true }
  }
  return { draft: copy, detached: false }
}