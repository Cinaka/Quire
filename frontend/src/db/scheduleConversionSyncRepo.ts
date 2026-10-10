import { captureSyncContext } from "@/api/syncContext"
import { isBackupSchedule } from "@/shared/scheduleBackup"
import {
  conversionCanonical, conversionCopy, conversionIntentKey, conversionUtc, createScheduleConversionConsumer,
  prepareConversionRequest, sameFirstEntry,
} from "@/shared/scheduleConversionSync"
import type { ConversionAck, ConversionConsumerPort, ConversionTicket, ConversionTransport } from "@/shared/scheduleConversionSync"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"

import {
  assertScheduleLease, readCheckedConversionQueue,
  rememberScheduleServerState,
} from "./scheduleSyncStateRepo"
import { db } from "./schema"

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
  async reject(ticket, failure) {
    return db.transaction("rw", db.meta, async () => {
      await assertScheduleLease(ticket.lease)
      const queued = (await readCheckedConversionQueue(ticket.lease.ownerUserId)).find(row => row.scheduleId === ticket.intent.scheduleId)
      if (!queued || conversionIntentKey(queued) !== conversionIntentKey(ticket.intent)) return { kind: "held", reason: "intent_changed" }
      const key = failure.category === "conflict" ? SCHEDULE_META_KEYS.conflicts : SCHEDULE_META_KEYS.errors
      const stored = await db.meta.get(key)
      if (stored && !Array.isArray(stored.value)) throw new Error("日程候选日志损坏，未替换原记录")
      // Keep distinct older candidates; identical repeated failures need not grow the log.
      const candidate = { scheduleId: ticket.intent.scheduleId, kind: "conversion-transport",
        firstIntent: conversionCopy(queued), stage: failure.stage, reason: failure.reason,
        serverSchedule: failure.serverSchedule, serverEntry: failure.serverEntry,
        firstEntryDate: failure.firstEntryDate, firstEntryDeleted: failure.firstEntryDeleted }
      const records = (stored?.value ?? []) as unknown[]
      if (!records.some(row => conversionCanonical(row) === conversionCanonical(candidate))) {
        await db.meta.put({ key, value: [...records, conversionCopy(candidate)] })
      }
      await assertScheduleLease(ticket.lease)
      return { kind: failure.category === "conflict" ? "conflict" : "held", reason: failure.reason }
    })
  },
  async prepare(id) {
    const lease = await captureSyncContext()
    return db.transaction("r", db.schedules, db.entries, db.meta, async () => {
      await assertScheduleLease(lease)
      const queued = await readCheckedConversionQueue(lease.ownerUserId), intent = queued.find(row => row.scheduleId === id)
      const source = await db.schedules.get(id)
      if (!intent || !source || !isBackupSchedule(source) || source.status !== "converted") throw new Error("转换意图或终态来源缺失")
      const ticket = { lease, intent: conversionCopy(intent) }
      prepareConversionRequest(ticket)
      return ticket
    })
  },
  async verify(ticket) {
    await db.transaction("r", db.meta, async () => {
      await assertScheduleLease(ticket.lease)
      const intent = (await readCheckedConversionQueue(ticket.lease.ownerUserId)).find(row => row.scheduleId === ticket.intent.scheduleId)
      if (!intent || conversionIntentKey(intent) !== conversionIntentKey(ticket.intent)) throw new Error("首次转换意图已变化")
    })
  },
  async acknowledge(ticket, ack) {
    return db.transaction("rw", db.schedules, db.entries, db.meta, async () => {
      await assertScheduleLease(ticket.lease)
      const queue = await readCheckedConversionQueue(ticket.lease.ownerUserId)
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
      await rememberScheduleServerState(ticket.lease, ack.schedule)
      await db.meta.put({ key: SCHEDULE_META_KEYS.conversions,
        value: queue.filter(row => row.scheduleId !== intent.scheduleId) })
      await assertScheduleLease(ticket.lease)
      return { kind: "confirmed", reason: exactSourceRevision ? "first_intent" : "source_revision_held" }
    })
  },
}
/** Internal dependency-injected factory. Not exported from @/repo or wired to runSync. */
export function createInternalScheduleConversionConsumer(transport: ConversionTransport) {
  return createScheduleConversionConsumer(conversionPort, transport)
}
