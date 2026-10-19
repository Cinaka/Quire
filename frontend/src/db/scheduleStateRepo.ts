import { newId } from "@/shared/ids"
import { isBackupConversion } from "@/shared/scheduleBackup"
import { conversionCanonical, conversionCopy } from "@/shared/scheduleConversionSync"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { sharedTagCopyArchivePlans } from "@/shared/scheduleSharedTagCopy"
import { collectMediaIds } from "@/shared/text"
import type { Entry, ScheduleConversion } from "@/shared/types"

import { db } from "./schema"

export const OWNER_GENERATION_KEY = "ownerGeneration"
export interface LocalOwnerSnapshot { ownerUserId: string; generation: string }
export async function localOwnerSnapshot(): Promise<LocalOwnerSnapshot> {
  const owner = await db.meta.get("ownerUserId")
  const epoch = await db.meta.get(OWNER_GENERATION_KEY)
  return {
    ownerUserId: typeof owner?.value === "string" ? owner.value : "",
    generation: typeof epoch?.value === "string" ? epoch.value : "",
  }
}
export async function assertLocalOwner(snapshot: LocalOwnerSnapshot): Promise<void> {
  const current = await localOwnerSnapshot()
  if (snapshot.ownerUserId !== current.ownerUserId || snapshot.generation !== current.generation) {
    throw new Error("本地账号或恢复批次已变化，旧操作已停止")
  }
}
/** 必须放在与认领/清库/恢复相同的meta事务里。 */
export async function rotateOwnerGeneration(): Promise<void> {
  await db.meta.put({ key: OWNER_GENERATION_KEY, value: newId() })
}
export async function readScheduleConversions(): Promise<ScheduleConversion[]> {
  const row = await db.meta.get(SCHEDULE_META_KEYS.conversions)
  return Array.isArray(row?.value) ? row.value as ScheduleConversion[] : []
}
/** 调用方须与正文/媒体修改同事务包含schedules/meta；只增长保护关联，不改首次快照。 */
export async function retainConversionMedia(entryId: string, ids: string[]): Promise<void> {
  if (!ids.length) return
  if (ids.some(id => typeof id !== "string" || !id)) throw new Error("转简图片保护ID无效")
  const row = await db.meta.get(SCHEDULE_META_KEYS.conversions)
  const queued = Array.isArray(row?.value) ? row.value as ScheduleConversion[] : []
  const matches = queued.filter(item => item?.scheduleId === entryId || item?.entry?.id === entryId)
  if (!matches.length) {
    const source = await db.schedules.get(entryId)
    if (source?.status === "converted" && !source.serverUpdatedAt) {
      throw new Error("未确认转简缺少恢复意图，已停止移除图片关联")
    }
    return
  }
  const item = matches[0]!
  const owner = await localOwnerSnapshot()
  if (matches.length !== 1 || !isBackupConversion(item) || item.ownerUserId !== owner.ownerUserId) {
    throw new Error("转简图片保护队列结构或归属异常")
  }
  const held = new Set(item.protectedMediaIds ?? [])
  const before = held.size
  for (const id of ids) held.add(id)
  if (held.size === before) return
  await db.meta.put({
    key: SCHEDULE_META_KEYS.conversions,
    value: queued.map(current => current === item ? { ...item, protectedMediaIds: [...held] } : current),
  })
}
export async function protectedConversions(): Promise<{ entryIds: Set<string>; mediaIds: Set<string>; tagIds: Set<string> }> {
  const entryIds = new Set<string>()
  const mediaIds = new Set<string>()
  const tagIds = new Set<string>()
  const holdTags = (value: unknown): void => {
    if (value == null) return
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new Error("转简标签候选损坏，已停止同步或清理")
    }
    const ids = (value as { tagIds?: unknown }).tagIds
    if (ids === undefined) return // 旧候选可能不含标签字段；不推断标签定义。
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim())) {
      throw new Error("转简标签保护索引损坏，已停止同步或清理")
    }
    for (const id of ids) tagIds.add(id)
  }
  const queued = await readScheduleConversions()
  for (const item of queued) {
    if (typeof item?.scheduleId === "string") entryIds.add(item.scheduleId)
    if (typeof item?.entry?.id === "string") entryIds.add(item.entry.id)
    for (const id of collectMediaIds(item?.entry?.content?.doc)) mediaIds.add(id)
    holdTags(item?.entry)
    const held = item?.protectedMediaIds
    if (held !== undefined && (!Array.isArray(held) || held.some(id => typeof id !== "string" || !id))) {
      throw new Error("转简图片保护索引损坏，已停止同步或清理")
    }
    for (const id of held ?? []) mediaIds.add(id)
  }
  // 意图损坏或旧v3恢复遗漏时仍保守保护未确认终态，不允许P2绕过专用转换。
  const sources = await db.schedules.where("status").equals("converted").toArray()
  for (const source of sources) {
    if (source.dirty === 1 || !source.serverUpdatedAt) entryIds.add(source.id)
  }
  for (const id of entryIds) {
    const entry = await db.entries.get(id)
    for (const mediaId of collectMediaIds(entry?.content?.doc)) mediaIds.add(mediaId)
    holdTags(entry)
  }
  const candidates = await db.meta.get(SCHEDULE_META_KEYS.conflicts)
  if (candidates && !Array.isArray(candidates.value)) {
    throw new Error("转换候选记录损坏，已停止同步或清理")
  }
  for (const value of (candidates?.value ?? []) as Array<Record<string, unknown>>) {
    if (!value || typeof value.scheduleId !== "string" || !entryIds.has(value.scheduleId)) continue
    holdTags(value.localEntry)
    holdTags(value.serverEntry)
    if (value.firstIntent != null) {
      if (typeof value.firstIntent !== "object" || Array.isArray(value.firstIntent)) {
        throw new Error("转简首次候选损坏，已停止同步或清理")
      }
      holdTags((value.firstIntent as { entry?: unknown }).entry)
    }
  }
  // Unpublished independent names are not tags yet. Their reservation must never let P2
  // publish new definitions, overwrite originals, remap duplicate names or purge the target.
  const archive = await db.meta.get(SCHEDULE_CONFLICT_ARCHIVE)
  if (archive && !Array.isArray(archive.value)) throw new Error("独立标签保护留档损坏")
  const owner = (await localOwnerSnapshot()).ownerUserId
  for (const plan of sharedTagCopyArchivePlans(archive?.value ?? [])) {
    if (plan.ownerUserId !== owner || plan.state !== "prepared") continue
    // A restore epoch invalidates old writes, not the original definitions' safety hold.
    entryIds.add(plan.scheduleId)
    for (const id of plan.originalTagIds) tagIds.add(id)
    for (const copy of plan.copies) tagIds.add(copy.tag.id)
    for (const id of plan.evidence.local.mediaIds) mediaIds.add(id)
    for (const item of plan.evidence.cloudMedia) mediaIds.add(item.id)
  }
  return { entryIds, mediaIds, tagIds }
}
export async function holdConversionServerEntry(entry: Entry): Promise<void> {
  const key = SCHEDULE_META_KEYS.conflicts
  const row = await db.meta.get(key)
  if (row && !Array.isArray(row.value)) throw new Error("转换候选记录损坏，未替换")
  const records = (row?.value ?? []) as unknown[]
  const candidate = { scheduleId: entry.id, kind: "conversion-entry",
    localEntry: await db.entries.get(entry.id) ?? null, serverEntry: conversionCopy(entry) }
  if (!records.some(item => conversionCanonical(item) === conversionCanonical(candidate))) {
    await db.meta.put({ key, value: [...records, candidate] })
  }
}
