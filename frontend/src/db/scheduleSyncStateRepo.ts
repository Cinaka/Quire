import { assertSyncContext } from "@/api/syncContext"
import { accessTokenSubject, tokenGeneration } from "@/api/tokenStore"
import { isBackupConversion, isBackupSchedule } from "@/shared/scheduleBackup"
import { conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"
import type { Schedule, ScheduleConversion } from "@/shared/types"

import { OWNER_GENERATION_KEY } from "./scheduleStateRepo"
import { db } from "./schema"

export const SCHEDULE_SERVER_STATE_PREFIX = "scheduleServerState:"
export async function assertScheduleLease(lease: ConversionLease): Promise<void> {
  const owner = await db.meta.get("ownerUserId"), epoch = await db.meta.get(OWNER_GENERATION_KEY)
  if (!owner || typeof owner.value !== "string" || (epoch && typeof epoch.value !== "string")) throw new Error("本地归属或恢复代际标记损坏")
  await assertSyncContext(lease)
  if (accessTokenSubject() !== lease.ownerUserId || tokenGeneration() !== lease.tokenGeneration) throw new Error("旧登录租约已失效")
}
export async function readCheckedConversionQueue(owner: string): Promise<ScheduleConversion[]> {
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
/** Runtime-only, epoch-scoped proof of a validated cloud revision; never guessed from local clocks. */
export async function readScheduleServerState(lease: ConversionLease, id: string): Promise<Schedule | undefined> {
  const stored = await db.meta.get(SCHEDULE_SERVER_STATE_PREFIX + id)
  if (!stored) return undefined
  const raw = stored.value as { ownerUserId?: unknown; generation?: unknown; source?: unknown } | null
  if (!raw || typeof raw !== "object") throw new Error("日程云端基线损坏")
  if (raw.ownerUserId !== lease.ownerUserId || raw.generation !== lease.generation) return undefined
  if (!isBackupSchedule(raw.source) || raw.source.id !== id || raw.source.dirty !== 0 || !raw.source.serverUpdatedAt ||
      conversionUtc(raw.source.updatedAt) !== conversionUtc(raw.source.serverUpdatedAt)) throw new Error("日程云端基线结构无效")
  return conversionCopy(raw.source)
}
/** Caller must hold the meta transaction and verify lease again before it completes. */
export async function rememberScheduleServerState(lease: ConversionLease, source: Schedule): Promise<void> {
  if (!isBackupSchedule(source) || source.dirty !== 0 || !source.serverUpdatedAt ||
      conversionUtc(source.updatedAt) !== conversionUtc(source.serverUpdatedAt)) throw new Error("未验证的云端修订不能作为CAS基线")
  const current = await readScheduleServerState(lease, source.id)
  if (current && conversionUtc(current.serverUpdatedAt) > conversionUtc(source.serverUpdatedAt)) throw new Error("云端基线水位不能倒退")
  await db.meta.put({ key: SCHEDULE_SERVER_STATE_PREFIX + source.id,
    value: { ownerUserId: lease.ownerUserId, generation: lease.generation, source: conversionCopy(source) } })
}
