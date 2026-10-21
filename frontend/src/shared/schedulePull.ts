import { conversionCopy, conversionUtc } from "./scheduleConversionSync"
import type { ConversionLease } from "./scheduleConversionSync"
import { parseScheduleWire } from "./schedulePush"
import { scheduleEntryId } from "./schedules"
import type { Schedule } from "./types"

export const SCHEDULE_PULL_FLOOR = "1000-01-01T00:00:00.000Z"
export interface SchedulePullCursor { since: string; afterId: string | null; until: string | null }
export interface SchedulePullTicket { lease: ConversionLease; cursor: SchedulePullCursor; fingerprint: string; limit: number }
export interface SchedulePullPage { rows: Schedule[]; next: SchedulePullCursor; hasMore: boolean; window: string }
export interface SchedulePullItem { id: string; kind: "merged" | "held" | "conflict"; reason: string }
export interface SchedulePullTransport { pull(params: unknown, lease: ConversionLease): Promise<unknown> }
export class SchedulePullTransportError extends Error {
  readonly reason: string
  constructor(reason: string) { super("日程拉取未确认"); this.reason = reason }
}
export interface SchedulePullPort {
  capture(limit: number): Promise<SchedulePullTicket>
  apply(ticket: SchedulePullTicket, page: SchedulePullPage): Promise<{ applied: boolean; items: SchedulePullItem[] }>
  failed(ticket: SchedulePullTicket, reason: string): Promise<void>
}
export function readScopedPullCursor(raw: unknown, lease: ConversionLease): SchedulePullCursor {
  const empty = { since: SCHEDULE_PULL_FLOOR, afterId: null, until: null }
  if (raw === null) return empty
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("日程游标格式未确认")
  const r = raw as Record<string, unknown>
  if (typeof r.ownerUserId !== "string" || typeof r.generation !== "string") throw new Error("日程游标归属格式无效")
  if (r.ownerUserId !== lease.ownerUserId || r.generation !== lease.generation) return empty
  const since = conversionUtc(r.since)
  if (r.afterId === null && r.until === null) return { since, afterId: null, until: null }
  if (typeof r.afterId !== "string" || scheduleEntryId(r.afterId) !== r.afterId || typeof r.until !== "string") throw new Error("日程分页游标不完整")
  const until = conversionUtc(r.until)
  if (since > until) throw new Error("日程分页游标倒置")
  return { since, afterId: r.afterId, until }
}
export function pullParams(ticket: SchedulePullTicket) {
  return { since: ticket.cursor.since, limit: ticket.limit,
    ...(ticket.cursor.afterId ? { after_id: ticket.cursor.afterId, until: ticket.cursor.until } : {}) }
}
export function parseSchedulePullPage(raw: unknown, ticket: SchedulePullTicket): SchedulePullPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("日程拉取响应无效")
  const r = raw as Record<string, unknown>
  if (typeof r.has_more !== "boolean" || !Array.isArray(r.schedules) || r.schedules.length > ticket.limit) throw new Error("日程拉取分页字段无效")
  const until = conversionUtc(r.sync_until), nextTime = conversionUtc(r.server_time)
  if (until < ticket.cursor.since || nextTime < ticket.cursor.since || nextTime > until ||
      (ticket.cursor.until && until !== ticket.cursor.until)) throw new Error("日程窗口或游标倒退")
  const seen = new Set<string>()
  let time = ticket.cursor.since, id = ticket.cursor.afterId ?? ""
  const rows = r.schedules.map(rawRow => {
    const value = rawRow as { id?: unknown } | null
    if (!value || typeof value.id !== "string") throw new Error("日程ID无效")
    const row = parseScheduleWire(rawRow,value.id)
    if (seen.has(row.id) || row.serverUpdatedAt < time || row.serverUpdatedAt > until ||
        (row.serverUpdatedAt === time && row.id <= id)) throw new Error("日程顺序、范围或重复ID无效")
    seen.add(row.id); time = row.serverUpdatedAt; id = row.id
    return row
  })
  if (r.has_more) {
    const last = rows.at(-1)
    if (!last || rows.length !== ticket.limit || r.cursor_id !== last.id || nextTime !== last.serverUpdatedAt) throw new Error("日程续页游标与末行不匹配")
    return { rows, window: until, hasMore: true, next: { since: nextTime, afterId: last.id, until } }
  }
  if (r.cursor_id !== null || nextTime !== until) throw new Error("日程末页游标不完整")
  return { rows, window: until, hasMore: false, next: { since: until, afterId: null, until: null } }
}
/** One page only. No automatic loop, cursor reset on HTTP failure, or P2 sync calls. */
export function createSchedulePullCoordinator(port: SchedulePullPort, transport: SchedulePullTransport) {
  let busy = false
  return { async runPage(limit = 200) {
    if (busy || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return { applied: false, hasMore: false, items: [] as SchedulePullItem[], reason: busy ? "busy" : "invalid_limit" }
    busy = true
    let ticket: SchedulePullTicket | undefined
    try {
      ticket = conversionCopy(await port.capture(limit))
      const raw = await transport.pull(pullParams(ticket),conversionCopy(ticket.lease))
      let page: SchedulePullPage
      try { page = parseSchedulePullPage(raw,ticket) }
      catch { throw new SchedulePullTransportError("invalid_response") }
      const result = await port.apply(ticket,conversionCopy(page))
      return { ...result, hasMore: result.applied && page.hasMore, reason: result.applied ? "page_processed" : "cursor_changed" }
    } catch (error) {
      if (ticket) {
        try { await port.failed(ticket,error instanceof SchedulePullTransportError ? error.reason : "apply_unconfirmed") }
        catch { /* don't write an old failure under a changed lease */ }
      }
      return { applied: false, hasMore: false, items: [] as SchedulePullItem[], reason: "unconfirmed" }
    } finally { busy = false }
  } }
}
