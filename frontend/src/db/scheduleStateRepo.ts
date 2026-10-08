import { newId } from "@/shared/ids"
import { SCHEDULE_META_KEYS } from "@/shared/schedules"
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
export async function protectedConversions(): Promise<{ entryIds: Set<string>; mediaIds: Set<string> }> {
  const entryIds = new Set<string>()
  const mediaIds = new Set<string>()
  const queued = await readScheduleConversions()
  for (const item of queued) {
    if (typeof item?.scheduleId === "string") entryIds.add(item.scheduleId)
    if (typeof item?.entry?.id === "string") entryIds.add(item.entry.id)
    for (const id of collectMediaIds(item?.entry?.content?.doc)) mediaIds.add(id)
  }
  // 意图损坏或旧v3恢复遗漏时仍保守保护未确认终态，不允许P2绕过专用转换。
  const sources = await db.schedules.where("status").equals("converted").toArray()
  for (const source of sources) {
    if (source.dirty === 1 || !source.serverUpdatedAt) entryIds.add(source.id)
  }
  for (const id of entryIds) {
    const entry = await db.entries.get(id)
    for (const mediaId of collectMediaIds(entry?.content?.doc)) mediaIds.add(mediaId)
  }
  return { entryIds, mediaIds }
}
export async function holdConversionServerEntry(entry: Entry): Promise<void> {
  const key = SCHEDULE_META_KEYS.conflicts
  const row = await db.meta.get(key)
  const records = Array.isArray(row?.value) ? row.value as Array<{ scheduleId?: string }> : []
  await db.meta.put({ key, value: [
    ...records.filter(item => item.scheduleId !== entry.id),
    { scheduleId: entry.id, kind: "conversion-entry", localEntry: await db.entries.get(entry.id), serverEntry: entry },
  ] })
}
