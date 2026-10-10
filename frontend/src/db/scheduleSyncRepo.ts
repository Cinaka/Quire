import { captureSyncContext } from "@/api/syncContext"
import { conversionCanonical } from "@/shared/scheduleConversionSync"
import type { ConversionLease, ConversionTransport } from "@/shared/scheduleConversionSync"
import { readScopedPullCursor } from "@/shared/schedulePull"
import type { SchedulePullTransport } from "@/shared/schedulePull"
import type { SchedulePushTransport } from "@/shared/schedulePush"
import { createScheduleSyncCoordinator } from "@/shared/scheduleSync"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"

import { createInternalScheduleConversionConsumer } from "./scheduleConversionSyncRepo"
import { createInternalSchedulePullCoordinator } from "./schedulePullRepo"
import { createInternalSchedulePushCoordinator } from "./schedulePushRepo"
import { assertScheduleLease, readCheckedConversionQueue } from "./scheduleSyncStateRepo"
import { db } from "./schema"

export interface ScheduleSyncTransports { conversion: ConversionTransport; push: SchedulePushTransport; pull: SchedulePullTransport }
async function conflicts(key: string = SCHEDULE_META_KEYS.conflicts): Promise<unknown[]> {
  const row = await db.meta.get(key)
  if (row && !Array.isArray(row.value)) throw new Error("日程冲突日志损坏")
  return (row?.value ?? []) as unknown[]
}
async function verify(lease: ConversionLease) {
  await db.transaction("r",db.meta,async()=>{ await assertScheduleLease(lease); await readCheckedConversionQueue(lease.ownerUserId); await conflicts(); await conflicts(SCHEDULE_META_KEYS.errors); await assertScheduleLease(lease) })
}
/** Explicit injected transports only. No factory creation sends a request or enables P2/diary sync. */
export function createInternalScheduleSyncCoordinator(transports: ScheduleSyncTransports) {
  const check = async (outer: ConversionLease, inner: ConversionLease) => {
    if (conversionCanonical(outer) !== conversionCanonical(inner)) throw new Error("不能重捕获新账号租约继续旧协调")
    await verify(outer)
  }
  return createScheduleSyncCoordinator({
    async capture() {
      const lease = await captureSyncContext()
      return db.transaction("r",db.meta,async()=>{
        await assertScheduleLease(lease)
        const queue = await readCheckedConversionQueue(lease.ownerUserId), candidates = await conflicts()
        await conflicts(SCHEDULE_META_KEYS.errors)
        const ids = queue.map(row=>row.scheduleId).filter(id=>!candidates.some(raw=>raw && typeof raw === "object" && "scheduleId" in raw && raw.scheduleId === id)).sort()
        // Fail before outbound work if continuation/legacy cursor isn't safe to use.
        readScopedPullCursor((await db.meta.get(SCHEDULE_META_KEYS.cursor))?.value ?? null,lease)
        await assertScheduleLease(lease)
        return { lease,ids }
      })
    },
    verify,
    async consume(id,outer) {
      const wrapped: ConversionTransport = {
        async pushSource(body,inner) { await check(outer,inner); const r=await transports.conversion.pushSource(body,inner); await check(outer,inner); return r },
        async convert(sourceId,body,inner) { await check(outer,inner); const r=await transports.conversion.convert(sourceId,body,inner); await check(outer,inner); return r },
      }
      return createInternalScheduleConversionConsumer(wrapped).consumeOne(id)
    },
    async push(outer) {
      return createInternalSchedulePushCoordinator({ async push(body,inner) {
        await check(outer,inner); const r=await transports.push.push(body,inner); await check(outer,inner); return r
      } }).runOnce()
    },
    async pull(limit,outer) {
      return createInternalSchedulePullCoordinator({ async pull(params,inner) {
        await check(outer,inner); const r=await transports.pull.pull(params,inner); await check(outer,inner); return r
      } }).runPage(limit)
    },
    async inspect(lease) {
      return db.transaction("r",db.schedules,db.meta,async()=>{
        await assertScheduleLease(lease)
        const queue = await readCheckedConversionQueue(lease.ownerUserId), candidates = await conflicts()
        await conflicts(SCHEDULE_META_KEYS.errors)
        const cursor = readScopedPullCursor((await db.meta.get(SCHEDULE_META_KEYS.cursor))?.value ?? null,lease)
        const dirty = (await db.schedules.toArray()).filter(row=>row.dirty === 1).length
        await assertScheduleLease(lease)
        return { conversions:queue.length,dirty,conflicts:candidates.length,pullContinuation:cursor.afterId !== null }
      })
    },
  })
}
