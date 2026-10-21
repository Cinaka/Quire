import { isBackupSchedule } from "./scheduleBackup"
import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import type { ConversionLease } from "./scheduleConversionSync"
import { assertScheduleBody, scheduleEntryId } from "./schedules"
import { toPlainText } from "./text"
import type { Schedule } from "./types"

export interface SchedulePushItem { local: Schedule; base?: Schedule; wire: Record<string, unknown> }
export interface SchedulePushOutcome { id: string; kind: "confirmed" | "held" | "conflict" | "error"; reason: string }
export interface SchedulePushTicket { lease: ConversionLease; items: SchedulePushItem[]; held: SchedulePushOutcome[]; more: boolean }
export interface ParsedSchedulePushItem { kind: "accepted" | "conflict" | "error"; reason: string; current: Schedule | null }
export interface SchedulePushTransport { push(body: unknown, lease: ConversionLease): Promise<unknown> }
export class SchedulePushTransportError extends Error {
  readonly reason: string
  constructor(reason: string) { super("日程上行未确认"); this.reason = reason }
}
export interface SchedulePushPort {
  capture(): Promise<SchedulePushTicket>
  beforeSend(ticket: SchedulePushTicket): Promise<void>
  verifyLease(lease: ConversionLease): Promise<void>
  apply(lease: ConversionLease, item: SchedulePushItem, result: ParsedSchedulePushItem): Promise<SchedulePushOutcome>
  failed(ticket: SchedulePushTicket, reason: string): Promise<SchedulePushOutcome[]>
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("日程批量回执结构无效")
  return raw as Record<string, unknown>
}
function optionalTime(raw: unknown): string | null { return raw === null ? null : conversionUtc(raw) }
export function parseScheduleWire(raw: unknown, id: string): Schedule {
  const r = object(raw)
  if (r.id !== id || scheduleEntryId(id) !== id || typeof r.title !== "string" || typeof r.content_text !== "string") throw new Error("日程回执身份或文本字段无效")
  const result = {
    id, remindDate: r.remind_date, title: r.title, content: r.content, contentText: r.content_text,
    status: r.status, convertedEntryId: r.converted_entry_id, convertedAt: optionalTime(r.converted_at),
    createdAt: conversionUtc(r.created_at), updatedAt: conversionUtc(r.updated_at), serverUpdatedAt: conversionUtc(r.updated_at),
    clientUpdatedAt: conversionUtc(r.client_updated_at), deletedAt: optionalTime(r.deleted_at),
    isDeleted: r.deleted_at === null ? 0 : 1, dirty: 0,
  }
  if (!isBackupSchedule(result)) throw new Error("日程回执日期、正文或转换关系无效")
  return conversionCopy(result)
}
export function sameScheduleBusiness(a: Schedule, b: Schedule): boolean {
  return a.id === b.id && a.status === b.status && a.remindDate === b.remindDate && a.title === b.title &&
    conversionCanonical(a.content) === conversionCanonical(b.content) && a.convertedEntryId === b.convertedEntryId
}
export function buildSchedulePushItem(local: Schedule, base?: Schedule): SchedulePushItem {
  if (!isBackupSchedule(local) || local.dirty !== 1) throw new Error("invalid_local")
  const client = conversionUtc(local.clientUpdatedAt), deleted = optionalTime(local.deletedAt)
  if (Number(local.remindDate.slice(0, 4)) < 1000 || (deleted && deleted > client)) throw new Error("invalid_local")
  if (local.status === "pending") {
    assertScheduleBody(local.title, local.content)
    return { local: conversionCopy(local), wire: { id: local.id, status: "pending", remind_date: local.remindDate,
      title: local.title, content: conversionCopy(local.content), content_text: toPlainText(local.content),
      client_updated_at: client, deleted_at: deleted } }
  }
  if (!base) throw new Error("missing_server_base")
  if (!isBackupSchedule(base) || !sameScheduleBusiness(local, base)) throw new Error("terminal_source_conflict")
  if (client <= conversionUtc(base.clientUpdatedAt)) throw new Error("revision_not_ahead")
  return { local: conversionCopy(local), base: conversionCopy(base), wire: { id: local.id, status: "converted",
    expected_schedule_client_updated_at: conversionUtc(base.clientUpdatedAt), client_updated_at: client, deleted_at: deleted } }
}
const ERROR_REASONS = new Set(["conflict", "terminal", "not_found", "not_terminal", "invalid_state", "source_revision", "invalid", "retry", "storage", "aborted"])
export function parseSchedulePushBatch(raw: unknown, items: SchedulePushItem[]): ParsedSchedulePushItem[] {
  const body = object(raw)
  if (typeof body.interrupted !== "boolean" || !Array.isArray(body.schedules) || body.schedules.length !== items.length) throw new Error("日程回执缺项或截断")
  let aborted = false
  return body.schedules.map((rawItem, index): ParsedSchedulePushItem => {
    const r = object(rawItem), sent = items[index]!
    if (r.index !== index || r.id !== sent.local.id) throw new Error("日程回执错位或ID不匹配")
    const current = r.current === null ? null : parseScheduleWire(r.current, sent.local.id)
    if (r.status === "applied") {
      if (aborted || !["applied", "replayed"].includes(String(r.reason)) || !current ||
          conversionUtc(r.submitted_client_updated_at) !== sent.wire.client_updated_at) throw new Error("日程成功回执无效")
      const matches = sameScheduleBusiness(sent.local, current) && current.clientUpdatedAt === sent.wire.client_updated_at &&
        current.isDeleted === sent.local.isDeleted && current.deletedAt === optionalTime(sent.local.deletedAt) &&
        (!sent.base || (current.serverUpdatedAt >= conversionUtc(sent.base.serverUpdatedAt) &&
          current.convertedAt === sent.base.convertedAt && current.createdAt === sent.base.createdAt)) &&
        (sent.local.status !== "pending" || current.contentText === sent.wire.content_text)
      return { kind: matches ? "accepted" : "conflict", reason: matches ? String(r.reason) : "echo_mismatch", current }
    }
    if (r.status === "stale" && r.reason === "stale" && !aborted) return { kind: "conflict", reason: "stale", current }
    if (r.status !== "error" || typeof r.reason !== "string" || !ERROR_REASONS.has(r.reason) ||
        (aborted && r.reason !== "aborted") || (r.reason === "aborted" && !body.interrupted)) throw new Error("日程错误回执无效")
    aborted ||= r.reason === "aborted"
    return { kind: ["conflict", "terminal", "not_terminal", "invalid_state", "source_revision"].includes(r.reason) ? "conflict" : "error", reason: r.reason, current }
  })
}
export function createSchedulePushCoordinator(port: SchedulePushPort, transport: SchedulePushTransport) {
  let busy = false
  return { async runOnce() {
    if (busy) return { sent: 0, more: false, stopped: true, reason: "busy", items: [] as SchedulePushOutcome[] }
    busy = true
    let ticket: SchedulePushTicket | undefined, sent = 0
    try {
      ticket = conversionCopy(await port.capture())
      if (!ticket.items.length) return { sent: 0, more: ticket.more, stopped: false, reason: "no_eligible", items: ticket.held }
      await port.beforeSend(ticket)
      sent = ticket.items.length
      const raw = await transport.push({ schedules: ticket.items.map(row => conversionCopy(row.wire)) }, conversionCopy(ticket.lease))
      await port.verifyLease(ticket.lease)
      let parsed: ParsedSchedulePushItem[]
      try { parsed = parseSchedulePushBatch(raw, ticket.items) }
      catch { throw new SchedulePushTransportError("invalid_response") }
      const results = [...ticket.held]
      for (let i = 0; i < ticket.items.length; i++) {
        const item = ticket.items[i]!
        try { results.push(await port.apply(ticket.lease, item, parsed[i]!)) }
        catch {
          try { await port.verifyLease(ticket.lease) }
          catch {
            results.push(...ticket.items.slice(i).map(row => ({ id: row.local.id, kind: "held" as const, reason: "context_changed" })))
            return { sent, more: ticket.more, stopped: true, reason: "context_changed", items: results }
          }
          try { results.push(...await port.failed({ ...ticket, items: [item], held: [] }, "ack_storage")) }
          catch { results.push({ id: item.local.id, kind: "held", reason: "ack_storage" }) }
        }
      }
      return { sent, more: ticket.more, stopped: false, reason: "batch_processed", items: results }
    } catch (error) {
      let results = ticket ? [...ticket.held] : []
      if (ticket) {
        try {
          await port.verifyLease(ticket.lease)
          if (sent) results.push(...await port.failed(ticket, error instanceof SchedulePushTransportError ? error.reason : "network"))
          else results.push(...ticket.items.map(row => ({ id: row.local.id, kind: "held" as const, reason: "snapshot_changed" })))
        } catch { results = ticket.items.map(row => ({ id: row.local.id, kind: "held" as const, reason: "context_changed" })) }
      }
      return { sent, more: ticket?.more ?? false, stopped: true, reason: "unconfirmed", items: results }
    } finally { busy = false }
  } }
}
