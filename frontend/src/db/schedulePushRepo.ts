import { captureSyncContext } from "@/api/syncContext"
import { isBackupSchedule } from "@/shared/scheduleBackup"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import { buildSchedulePushItem, createSchedulePushCoordinator } from "@/shared/schedulePush"
import type { SchedulePushItem, SchedulePushOutcome, SchedulePushPort, SchedulePushTransport } from "@/shared/schedulePush"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"

import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db } from "./schema"

async function records(key: string): Promise<unknown[]> {
  const row = await db.meta.get(key)
  if (row && !Array.isArray(row.value)) throw new Error("日程同步日志损坏")
  return (row?.value ?? []) as unknown[]
}
async function append(key: string, candidate: unknown) {
  const old = await records(key)
  if (!old.some(row => conversionCanonical(row) === conversionCanonical(candidate))) await db.meta.put({ key, value: [...old, conversionCopy(candidate)] })
}
const port: SchedulePushPort = {
  async capture() {
    const lease = await captureSyncContext()
    return db.transaction("r", db.schedules, db.meta, async () => {
      await assertScheduleLease(lease)
      const queued = new Set((await readCheckedConversionQueue(lease.ownerUserId)).map(row => row.scheduleId))
      const conflicts = await records(SCHEDULE_META_KEYS.conflicts)
      const blocked = new Set(conflicts.flatMap(raw => raw && typeof raw === "object" && "scheduleId" in raw && typeof raw.scheduleId === "string" ? [raw.scheduleId] : []))
      const rows = (await db.schedules.toArray()).filter(row => row.dirty === 1).sort((a,b) => a.id.localeCompare(b.id))
      const items: SchedulePushItem[] = [], held: SchedulePushOutcome[] = []
      for (const row of rows) {
        if (queued.has(row.id) || blocked.has(row.id)) {
          held.push({ id: row.id, kind: "held", reason: queued.has(row.id) ? "conversion_pending" : "conflict_pending" }); continue
        }
        try {
          const base = row.status === "converted" ? await readScheduleServerState(lease, row.id) : undefined
          items.push(buildSchedulePushItem(row, base))
        } catch (error) {
          const known = ["missing_server_base", "terminal_source_conflict", "revision_not_ahead"]
          const message = error && typeof error === "object" && "message" in error ? error.message : ""
          const reason = typeof message === "string" && known.includes(message) ? message : "invalid_local"
          held.push({ id: row.id, kind: "held", reason })
        }
      }
      await assertScheduleLease(lease)
      return { lease, items: items.slice(0,50), held, more: items.length > 50 }
    })
  },
  async beforeSend(ticket) {
    await db.transaction("r", db.schedules, db.meta, async () => {
      await assertScheduleLease(ticket.lease)
      const queued = new Set((await readCheckedConversionQueue(ticket.lease.ownerUserId)).map(row => row.scheduleId))
      const conflicts = await records(SCHEDULE_META_KEYS.conflicts)
      for (const item of ticket.items) {
        if (conflicts.some(raw => raw && typeof raw === "object" && "scheduleId" in raw && raw.scheduleId === item.local.id)) throw new Error("日程冲突尚未处理")
        if (queued.has(item.local.id) || conversionCanonical(await db.schedules.get(item.local.id)) !== conversionCanonical(item.local)) throw new Error("日程发送快照已变化")
        if (item.base && conversionCanonical(await readScheduleServerState(ticket.lease,item.local.id)) !== conversionCanonical(item.base)) throw new Error("日程CAS基线已变化")
      }
      await assertScheduleLease(ticket.lease)
    })
  },
  async verifyLease(lease) {
    await db.transaction("r", db.meta, async () => { await assertScheduleLease(lease); await readCheckedConversionQueue(lease.ownerUserId); await assertScheduleLease(lease) })
  },
  async apply(lease, item, result) {
    return db.transaction("rw", db.schedules, db.meta, async () => {
      await assertScheduleLease(lease)
      const queued = await readCheckedConversionQueue(lease.ownerUserId)
      const candidate = { scheduleId: item.local.id, kind: "schedule-push", reason: result.reason,
        submitted: item.local, expectedServerRevision: item.base?.clientUpdatedAt ?? null, serverSchedule: result.current }
      if (result.kind !== "accepted" || !result.current) {
        await append(result.kind === "conflict" ? SCHEDULE_META_KEYS.conflicts : SCHEDULE_META_KEYS.errors, candidate)
        await assertScheduleLease(lease)
        return { id: item.local.id, kind: result.kind === "conflict" ? "conflict" : "error", reason: result.reason }
      }
      const current = await db.schedules.get(item.local.id)
      if (current && isBackupSchedule(current) && current.serverUpdatedAt && conversionUtc(current.serverUpdatedAt) > result.current.serverUpdatedAt) return { id: item.local.id, kind: "held", reason: "older_server_state" }
      const previous = await readScheduleServerState(lease,item.local.id)
      if (previous && previous.serverUpdatedAt > result.current.serverUpdatedAt) return { id: item.local.id, kind: "held", reason: "older_server_state" }
      await rememberScheduleServerState(lease,result.current)
      const conflicts = await records(SCHEDULE_META_KEYS.conflicts)
      if (conflicts.some(raw => raw && typeof raw === "object" && "scheduleId" in raw && raw.scheduleId === item.local.id) ||
          !current || !isBackupSchedule(current) || queued.some(row => row.scheduleId === item.local.id) ||
          conversionCanonical(current) !== conversionCanonical(item.local)) {
        await assertScheduleLease(lease)
        return { id: item.local.id, kind: "held", reason: "changed_locally" }
      }
      await db.schedules.put({ ...current, serverUpdatedAt: result.current.serverUpdatedAt, dirty: 0,
        contentText: current.status === "pending" ? toPlainText(current.content) : current.contentText })
      await assertScheduleLease(lease)
      return { id: item.local.id, kind: "confirmed", reason: result.reason }
    })
  },
  async failed(ticket, reason) {
    return db.transaction("rw", db.meta, async () => {
      await assertScheduleLease(ticket.lease); await readCheckedConversionQueue(ticket.lease.ownerUserId)
      const results: SchedulePushOutcome[] = []
      for (const item of ticket.items) {
        await append(SCHEDULE_META_KEYS.errors, { scheduleId: item.local.id, kind: "schedule-push", reason, submitted: item.local, serverSchedule: null })
        results.push({ id: item.local.id, kind: "error", reason })
      }
      await assertScheduleLease(ticket.lease)
      return results
    })
  },
}
/** Explicit single batch only; not exported from @/repo or connected to P2 runSync. */
export function createInternalSchedulePushCoordinator(transport: SchedulePushTransport) {
  return createSchedulePushCoordinator(port,transport)
}
