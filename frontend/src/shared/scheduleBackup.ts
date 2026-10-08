import { assertScheduleContent, assertScheduleDate, scheduleEntryId } from "./schedules"
import { toPlainText } from "./text"
import { isLocalDate } from "./time"
import { CONTENT_SCHEMA_VERSION, type Entry, type EntryContent, type Schedule } from "./types"

export interface BackupScheduleConversion {
  scheduleId: string
  source: Schedule
  entry: Entry
  queuedAt: string
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value))
}
function contentShape(value: unknown): boolean {
  return value === null || (object(value) && Number.isSafeInteger(value.schemaVersion) &&
    Number(value.schemaVersion) >= 1 && object(value.doc) && value.doc.type === "doc")
}
export function scheduleContentTooNew(row: { content: EntryContent | null }): boolean {
  return (row.content?.schemaVersion ?? 0) > CONTENT_SCHEMA_VERSION
}

/** v3 的新实体严校验；过新正文保留结构供导入报告隔离，不强行降版本。 */
export function isBackupSchedule(raw: unknown): raw is Schedule {
  if (!object(raw)) return false
  try {
    if (typeof raw.id !== "string" || scheduleEntryId(raw.id) !== raw.id) return false
    if (typeof raw.remindDate !== "string") return false
    assertScheduleDate(raw.remindDate)
    if (typeof raw.title !== "string" || raw.title.length > 255 || typeof raw.contentText !== "string") return false
    if (!contentShape(raw.content)) return false
    const row = raw as unknown as Schedule
    if (!scheduleContentTooNew(row)) assertScheduleContent(row.content)
    if (!iso(raw.createdAt) || !iso(raw.updatedAt) || !iso(raw.clientUpdatedAt)) return false
    if (raw.serverUpdatedAt !== "" && !iso(raw.serverUpdatedAt)) return false
    if (![0, 1].includes(Number(raw.isDeleted)) || typeof raw.isDeleted !== "number") return false
    if (![0, 1].includes(Number(raw.dirty)) || typeof raw.dirty !== "number") return false
    if ((raw.isDeleted === 0 && raw.deletedAt !== null) || (raw.isDeleted === 1 && !iso(raw.deletedAt))) return false
    if (raw.status === "pending") return raw.convertedEntryId === null && raw.convertedAt === null
    return raw.status === "converted" && raw.convertedEntryId === raw.id && iso(raw.convertedAt)
  } catch { return false }
}

function conversionEntry(raw: unknown, id: string): raw is Entry {
  if (!object(raw) || raw.id !== id || raw.fromScheduleId !== id) return false
  if (typeof raw.entryDate !== "string" || !isLocalDate(raw.entryDate)) return false
  return typeof raw.title === "string" && typeof raw.contentText === "string" &&
    contentShape(raw.content) && Array.isArray(raw.tagIds) && raw.tagIds.every(x => typeof x === "string") &&
    (raw.mood === null || typeof raw.mood === "string") &&
    (raw.weather === null || typeof raw.weather === "string") && Number.isSafeInteger(raw.sortOrder) &&
    iso(raw.createdAt) && iso(raw.updatedAt) && iso(raw.clientUpdatedAt) &&
    (raw.serverUpdatedAt === "" || iso(raw.serverUpdatedAt)) && typeof raw.dirty === "number" && [0, 1].includes(raw.dirty) &&
    (raw.isDeleted === 0 ? raw.deletedAt === null : raw.isDeleted === 1 && iso(raw.deletedAt))
}
export function isBackupConversion(raw: unknown): raw is BackupScheduleConversion {
  return object(raw) && typeof raw.scheduleId === "string" && isBackupSchedule(raw.source) &&
    raw.source.id === raw.scheduleId && raw.source.status === "pending" && raw.source.isDeleted === 0 &&
    conversionEntry(raw.entry, raw.scheduleId) && iso(raw.queuedAt)
}

export function validateScheduleGraph(
  schedules: unknown[], conversions: unknown[], entries: Entry[],
): string | null {
  if (!schedules.every(isBackupSchedule)) return "预简记录结构、日期、状态或正文无效"
  if (!conversions.every(isBackupConversion)) return "转简恢复意图损坏，已拒绝写库"
  const rows = new Map(schedules.map(row => [row.id, row]))
  if (rows.size !== schedules.length) return "预简 ID 重复"
  const queued = new Set<string>()
  for (const item of conversions) {
    const source = rows.get(item.scheduleId)
    if (queued.has(item.scheduleId) || source?.status !== "converted") return "转简意图与终态来源不一致"
    queued.add(item.scheduleId)
  }
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || ids.has(entry.id)) return "日记 ID 缺失或重复"
    ids.add(entry.id)
    const source = rows.get(entry.fromScheduleId ?? "")
    if (source && (source.status !== "converted" || !conversionEntry(entry, source.id))) return "日记与转简来源关系不一致"
    if (rows.has(entry.id) && entry.fromScheduleId !== entry.id) return "日记与预简主键碰撞，不能覆盖"
  }
  return null
}

/** 恢复已弃去/已清理的转换身份，只构造待同步墓碑，不制造可见日记。 */
function absentEntry(row: Schedule): Entry {
  const at = row.convertedAt ?? row.updatedAt
  return {
    id: row.id, fromScheduleId: row.id, entryDate: row.remindDate, sortOrder: 0,
    title: "", content: null, contentText: "", mood: null, weather: null, tagIds: [],
    createdAt: row.createdAt, updatedAt: at, clientUpdatedAt: at, serverUpdatedAt: "",
    deletedAt: at, isDeleted: 1, dirty: 1,
  }
}

export function remapScheduleBackup(
  schedules: Schedule[], conversions: BackupScheduleConversion[], entries: Entry[],
  scheduleIds: ReadonlyMap<string, string>, mapEntry: (row: Entry) => Entry, now: string,
): { schedules: Schedule[]; conversions: BackupScheduleConversion[]; skippedSourceIds: string[] } {
  const byEntry = new Map(entries.map(row => [row.id, row]))
  const byIntent = new Map(conversions.map(row => [row.scheduleId, row]))
  const skippedSourceIds: string[] = []
  const restored: Schedule[] = []
  const queued: BackupScheduleConversion[] = []
  for (const row of schedules) {
    const intent = byIntent.get(row.id)
    const entry = byEntry.get(row.id)
    if (scheduleContentTooNew(row) || (intent && (scheduleContentTooNew(intent.source) ||
      scheduleContentTooNew(intent.entry))) || (entry && scheduleContentTooNew(entry))) {
      skippedSourceIds.push(row.id)
      continue
    }
    const id = scheduleIds.get(row.id) ?? row.id
    const next: Schedule = {
      ...row, id, contentText: toPlainText(row.content), dirty: 1, serverUpdatedAt: "",
      convertedEntryId: row.status === "converted" ? id : null,
    }
    restored.push(next)
    if (row.status !== "converted") continue
    // 不带账号、token 或服务端确认标记；导入事务按当前本地owner重新绑定。
    const source: Schedule = intent ? { ...intent.source, id, contentText: toPlainText(intent.source.content), dirty: 1, serverUpdatedAt: "" } : {
      ...next, status: "pending", convertedAt: null, convertedEntryId: null, isDeleted: 0, deletedAt: null,
    }
    queued.push({
      scheduleId: id, source, entry: mapEntry(intent?.entry ?? entry ?? absentEntry(row)),
      queuedAt: intent?.queuedAt ?? now,
    })
  }
  return { schedules: restored, conversions: queued, skippedSourceIds }
}
