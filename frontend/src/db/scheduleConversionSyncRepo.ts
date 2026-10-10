import { accessTokenSubject, tokenGeneration } from "@/api/tokenStore"
import { assertSyncContext, captureSyncContext } from "@/api/syncContext"
import { isBackupConversion, isBackupSchedule } from "@/shared/scheduleBackup"
import {
  conversionCanonical, conversionCopy, conversionIntentKey, conversionUtc, createScheduleConversionConsumer,
  prepareConversionRequest, sameFirstEntry,
} from "@/shared/scheduleConversionSync"
import type { ConversionAck, ConversionConsumerPort, ConversionTicket, ConversionTransport } from "@/shared/scheduleConversionSync"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"
import type { ScheduleConversion } from "@/shared/types"

import { OWNER_GENERATION_KEY } from "./scheduleStateRepo"
import { db } from "./schema"

async function checkLease(lease: ConversionTicket["lease"]): Promise<void> {
  const owner = await db.meta.get("ownerUserId"), epoch = await db.meta.get(OWNER_GENERATION_KEY)
  if (!owner || typeof owner.value !== "string" || (epoch && typeof epoch.value !== "string")) throw new Error("本地归属或恢复代际标记损坏")
  await assertSyncContext(lease)
  // Recheck auth after the awaited DB owner read, not only before it.
  if (accessTokenSubject() !== lease.ownerUserId || tokenGeneration() !== lease.tokenGeneration) throw new Error("旧登录租约已失效")
}
async function checkedQueue(owner: string): Promise<ScheduleConversion[]> {
  const stored = await db.meta.get(SCHEDULE_META_KEYS.conversions)
  if (!stored) return []
  if (!Array.isArray(stored.value)) throw new Error("转换队列损坏")
  const ids = new Set<string>()
  for (const raw of stored.value) {
    if (!isBackupConversion(raw) || (raw as ScheduleConversion).ownerUserId !== owner || ids.has(raw.scheduleId)) throw new Error("转换队列结构或归属异常")
    ids.add(raw.scheduleId)
  }
  return stored.value as ScheduleConversion[]
}
async function conflict(ticket: ConversionTicket, ack: ConversionAck, reason: string) {
  const stored = await db.meta.get(SCHEDULE_META_KEYS.conflicts)
  if (stored && !Array.isArray(stored.value)) throw new Error("日程冲突记录损坏")
  const records = (stored?.value ?? []) as Array<{ scheduleId?: string }>
  await db.meta.put({ key: SCHEDULE_META_KEYS.conflicts, value: [
    ...records.filter(row => row?.scheduleId !== ticket.intent.scheduleId),
    { scheduleId: ticket.intent.scheduleId, kind: "conversion-ack", reason,
      firstIntent: conversionCopy(ticket.intent), serverSchedule: ack.schedule, serverEntry: ack.entry },
  ] })
  return { kind: "conflict" as const, reason }
}
const conversionPort: ConversionConsumerPort = {
  async prepare(id) {
    const lease = await captureSyncContext()
    return db.transaction("r", db.schedules, db.entries, db.meta, async () => {
      await checkLease(lease)
      const queued = await checkedQueue(lease.ownerUserId), intent = queued.find(row => row.scheduleId === id)
      const source = await db.schedules.get(id)
      if (!intent || !source || !isBackupSchedule(source) || source.status !== "converted") throw new Error("转换意图或终态来源缺失")
      const ticket = { lease, intent: conversionCopy(intent) }
      prepareConversionRequest(ticket)
      return ticket
    })
  },
  async verify(ticket) {
    await db.transaction("r", db.meta, async () => {
      await checkLease(ticket.lease)
      const intent = (await checkedQueue(ticket.lease.ownerUserId)).find(row => row.scheduleId === ticket.intent.scheduleId)
      if (!intent || conversionIntentKey(intent) !== conversionIntentKey(ticket.intent)) throw new Error("首次转换意图已变化")
    })
  },
  async acknowledge(ticket, ack) {
    return db.transaction("rw", db.schedules, db.entries, db.meta, async () => {
      await checkLease(ticket.lease)
      const queue = await checkedQueue(ticket.lease.ownerUserId)
      const intent = queue.find(row => row.scheduleId === ticket.intent.scheduleId)
      if (!intent || conversionIntentKey(intent) !== conversionIntentKey(ticket.intent)) return { kind: "held", reason: "intent_changed" }
      const source = await db.schedules.get(intent.scheduleId), entry = await db.entries.get(intent.scheduleId)
      if (!source || !isBackupSchedule(source) || source.status !== "converted" ||
          conversionUtc(source.clientUpdatedAt) !== conversionUtc(intent.entry.clientUpdatedAt) || source.isDeleted !== ack.schedule.isDeleted ||
          source.deletedAt !== ack.schedule.deletedAt || source.remindDate !== ack.schedule.remindDate ||
          source.title !== ack.schedule.title || conversionCanonical(source.content) !== conversionCanonical(ack.schedule.content)) {
        return { kind: "held", reason: "source_changed" }
      }
      if (entry && (entry.id !== intent.scheduleId || entry.fromScheduleId !== intent.scheduleId)) return conflict(ticket, ack, "identity")
      if (!entry && ack.entryState !== "purged") return { kind: "held", reason: "missing_local_entry" }
      if (entry && (!ack.entry || !sameFirstEntry(ack.entry, intent.entry) ||
          conversionUtc(ack.entry.clientUpdatedAt) > conversionUtc(entry.clientUpdatedAt))) return conflict(ticket, ack, "server_entry_changed")
      // Do not clear dirty or copy any server content into the current local diary.
      if (source.serverUpdatedAt && conversionUtc(source.serverUpdatedAt) > ack.schedule.serverUpdatedAt) return { kind: "held", reason: "older_server_watermark" }
      const exactSourceRevision = conversionUtc(source.clientUpdatedAt) === ack.schedule.clientUpdatedAt
      await db.schedules.put({ ...source, serverUpdatedAt: ack.schedule.serverUpdatedAt,
        dirty: exactSourceRevision ? 0 : source.dirty })
      await db.meta.put({ key: SCHEDULE_META_KEYS.conversions,
        value: queue.filter(row => row.scheduleId !== intent.scheduleId) })
      await checkLease(ticket.lease)
      return { kind: "confirmed", reason: exactSourceRevision ? "first_intent" : "source_revision_held" }
    })
  },
}
/** Internal dependency-injected factory. Not exported from @/repo or wired to runSync. */
export function createInternalScheduleConversionConsumer(transport: ConversionTransport) {
  return createScheduleConversionConsumer(conversionPort, transport)
}
