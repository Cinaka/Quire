import { isBackupConversion, isBackupSchedule } from "./scheduleBackup"
import { assertScheduleBody, assertScheduleContent, assertScheduleDate } from "./schedules"
import { toPlainText } from "./text"
import type { Entry, Schedule, ScheduleConversion } from "./types"

export interface ConversionLease { ownerUserId: string; generation: string; tokenGeneration: number }
export interface ConversionTicket { lease: ConversionLease; intent: ScheduleConversion }
export interface ConversionAck { schedule: Schedule; entry: Entry | null; entryState: "active" | "deleted" | "purged" }
export interface ConversionConsumeResult { kind: "confirmed" | "held" | "conflict"; reason: string }
export interface ConversionTransport {
  pushSource(body: unknown, lease: ConversionLease): Promise<unknown>
  convert(id: string, body: unknown, lease: ConversionLease): Promise<unknown>
}
export interface ConversionConsumerPort {
  prepare(id: string): Promise<ConversionTicket>
  verify(ticket: ConversionTicket): Promise<void>
  acknowledge(ticket: ConversionTicket, ack: ConversionAck): Promise<ConversionConsumeResult>
}

export function conversionCopy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
export function conversionCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(conversionCanonical).join(",")}]`
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${conversionCanonical(row[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}
export function conversionIntentKey(intent: ScheduleConversion): string {
  // Growing media protection is not part of the immutable first snapshot.
  return conversionCanonical({ scheduleId: intent.scheduleId, source: intent.source,
    entry: intent.entry, queuedAt: intent.queuedAt, ownerUserId: intent.ownerUserId })
}
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("云端转换响应结构无效")
  return raw as Record<string, unknown>
}
export function conversionUtc(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(raw)) {
    throw new Error("转换时间格式或精度无效")
  }
  const value = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}Z`
  const at = new Date(value)
  if (!Number.isFinite(at.getTime()) || at.getUTCFullYear() < 1000) throw new Error("转换时间范围无效")
  // Date.parse normalizes impossible days; don't silently accept such wire timestamps.
  const day = raw.slice(0, 10); assertScheduleDate(day)
  return at.toISOString()
}
function nullableTime(raw: unknown): string | null { return raw === null ? null : conversionUtc(raw) }
function wireSchedule(raw: unknown, id: string): Schedule {
  const r = record(raw)
  if (r.id !== id || typeof r.title !== "string" || typeof r.content_text !== "string") throw new Error("来源响应身份无效")
  const row = {
    id, remindDate: r.remind_date, title: r.title, content: r.content, contentText: r.content_text,
    status: r.status, convertedEntryId: r.converted_entry_id, convertedAt: nullableTime(r.converted_at),
    createdAt: conversionUtc(r.created_at), updatedAt: conversionUtc(r.updated_at),
    clientUpdatedAt: conversionUtc(r.client_updated_at), serverUpdatedAt: conversionUtc(r.updated_at),
    deletedAt: nullableTime(r.deleted_at), isDeleted: r.deleted_at === null ? 0 : 1, dirty: 0,
  }
  if (!isBackupSchedule(row)) throw new Error("来源响应内容或转换关系无效")
  return row
}
function wireEntry(raw: unknown, id: string): Entry {
  const r = record(raw)
  if (r.id !== id || r.from_schedule_id !== id || typeof r.title !== "string" || typeof r.content_text !== "string" ||
      typeof r.entry_date !== "string" || !Number.isSafeInteger(r.sort_order) || Number(r.sort_order) < 0 ||
      !Array.isArray(r.tag_ids) || !r.tag_ids.every(x => typeof x === "string") ||
      (r.mood !== null && typeof r.mood !== "string") || (r.weather !== null && typeof r.weather !== "string")) {
    throw new Error("日记响应身份或字段无效")
  }
  assertScheduleDate(r.entry_date)
  if (r.content !== null) {
    const body = record(r.content)
    if (!Number.isSafeInteger(body.schemaVersion) || Number(body.schemaVersion) < 1 || record(body.doc).type !== "doc") throw new Error("日记响应正文结构无效")
  }
  return {
    id, fromScheduleId: id, title: r.title, content: r.content as Entry["content"], contentText: r.content_text,
    entryDate: r.entry_date, sortOrder: Number(r.sort_order), mood: r.mood as string | null,
    weather: r.weather as string | null, tagIds: r.tag_ids as string[],
    createdAt: conversionUtc(r.created_at), updatedAt: conversionUtc(r.updated_at),
    clientUpdatedAt: conversionUtc(r.client_updated_at), serverUpdatedAt: conversionUtc(r.updated_at),
    deletedAt: nullableTime(r.deleted_at), isDeleted: r.deleted_at === null ? 0 : 1, dirty: 0,
  }
}
export function prepareConversionRequest(ticket: ConversionTicket) {
  const i = ticket.intent
  if (!ticket.lease.ownerUserId || i.ownerUserId !== ticket.lease.ownerUserId || !isBackupConversion(i)) throw new Error("转换意图结构或账号无效")
  assertScheduleBody(i.source.title, i.source.content); assertScheduleContent(i.entry.content)
  assertScheduleDate(i.entry.entryDate)
  if (Number(i.entry.entryDate.slice(0, 4)) < 1000 || i.entry.title.length > 255 || i.entry.mood !== null || i.entry.weather !== null ||
      i.entry.tagIds.length || i.entry.sortOrder < 0 || i.entry.sortOrder > 2147483647) throw new Error("首次转换快照不兼容，不降级回放")
  const sourceAt = conversionUtc(i.source.clientUpdatedAt), entryAt = conversionUtc(i.entry.clientUpdatedAt)
  if (entryAt < sourceAt || (i.entry.isDeleted === 0 && entryAt === sourceAt) ||
      (i.entry.deletedAt !== null && conversionUtc(i.entry.deletedAt) > entryAt)) throw new Error("转换快照修订无效")
  const tombstone = i.entry.isDeleted === 1 && i.entry.title === "" && i.entry.content === null
  if (!tombstone && (i.source.title !== i.entry.title || conversionCanonical(i.source.content) !== conversionCanonical(i.entry.content))) throw new Error("首次转换快照与来源不一致")
  return {
    source: { id: i.scheduleId, status: "pending", remind_date: i.source.remindDate,
      title: i.source.title, content: conversionCopy(i.source.content), content_text: toPlainText(i.source.content),
      client_updated_at: sourceAt, deleted_at: null },
    convert: { expected_schedule_client_updated_at: sourceAt, entry: {
      id: i.scheduleId, from_schedule_id: i.scheduleId, entry_date: i.entry.entryDate,
      sort_order: i.entry.sortOrder, title: i.entry.title, content: conversionCopy(i.entry.content),
      content_text: toPlainText(i.entry.content), mood: null, weather: null, tag_ids: [],
      client_updated_at: entryAt, deleted_at: i.entry.deletedAt,
    } },
  }
}
export function assertConversionSourcePush(raw: unknown, ticket: ConversionTicket): void {
  const body = record(raw)
  if (body.interrupted !== false || !Array.isArray(body.schedules) || body.schedules.length !== 1) throw new Error("来源上行未完整确认")
  const r = record(body.schedules[0]), id = ticket.intent.scheduleId
  if (r.index !== 0 || r.id !== id) throw new Error("来源上行回执错位")
  const current = wireSchedule(r.current, id)
  if (r.status === "error" && r.reason === "terminal" && current.status === "converted") return
  if (r.status !== "applied" || !["applied", "replayed"].includes(String(r.reason)) ||
      conversionUtc(r.submitted_client_updated_at) !== conversionUtc(ticket.intent.source.clientUpdatedAt) ||
      current.status !== "pending" || current.isDeleted || current.clientUpdatedAt !== conversionUtc(ticket.intent.source.clientUpdatedAt) ||
      current.remindDate !== ticket.intent.source.remindDate || current.title !== ticket.intent.source.title ||
      conversionCanonical(current.content) !== conversionCanonical(ticket.intent.source.content)) throw new Error("来源修订或内容未确认")
}
export function parseConversionAck(raw: unknown, ticket: ConversionTicket): ConversionAck {
  const r = record(raw), i = ticket.intent
  if (r.confirmed !== true || !["applied", "replayed"].includes(String(r.reason)) ||
      r.created !== (r.reason === "applied") || r.first_entry_date !== i.entry.entryDate ||
      r.first_entry_deleted !== (i.entry.isDeleted === 1)) throw new Error("首次转换回执未确认")
  const schedule = wireSchedule(r.schedule, i.scheduleId)
  if (schedule.status !== "converted") throw new Error("来源尚未终态")
  const entry = r.entry === null ? null : wireEntry(r.entry, i.scheduleId)
  if (r.entry_state === "purged" && entry === null) return { schedule, entry, entryState: "purged" }
  if (entry && ((r.entry_state === "active" && !entry.isDeleted) || (r.entry_state === "deleted" && entry.isDeleted))) {
    return { schedule, entry, entryState: r.entry_state }
  }
  throw new Error("关联日记状态与响应不一致")
}
export function sameFirstEntry(a: Entry, b: Entry): boolean {
  return a.id === b.id && a.fromScheduleId === b.fromScheduleId && a.entryDate === b.entryDate && a.title === b.title &&
    conversionCanonical(a.content) === conversionCanonical(b.content) && a.isDeleted === b.isDeleted &&
    a.mood === b.mood && a.weather === b.weather && conversionCanonical(a.tagIds) === conversionCanonical(b.tagIds)
}
/** Explicit single-intent execution only. No timer, auto-sync, retry loop, or production transport. */
export function createScheduleConversionConsumer(port: ConversionConsumerPort, transport: ConversionTransport) {
  const busy = new Set<string>()
  return { async consumeOne(id: string): Promise<ConversionConsumeResult> {
    if (busy.has(id)) return { kind: "held", reason: "busy" }
    busy.add(id)
    try {
      const ticket = conversionCopy(await port.prepare(id)), request = prepareConversionRequest(ticket)
      await port.verify(ticket)
      const source = await transport.pushSource({ schedules: [request.source] }, conversionCopy(ticket.lease))
      await port.verify(ticket); assertConversionSourcePush(source, ticket)
      const raw = await transport.convert(id, request.convert, conversionCopy(ticket.lease))
      await port.verify(ticket)
      return await port.acknowledge(ticket, conversionCopy(parseConversionAck(raw, ticket)))
    } catch {
      // Even a server commit followed by timeout is not permission to remove the intention.
      return { kind: "held", reason: "unconfirmed" }
    } finally { busy.delete(id) }
  } }
}
