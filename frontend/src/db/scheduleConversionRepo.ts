import { isBackupConversion, isBackupSchedule } from "@/shared/scheduleBackup"
import {
  assertConvertibleSchedule,
  assertScheduleBody,
  assertScheduleDate,
  nextScheduleRevision,
  scheduleEntryId,
  SCHEDULE_META_KEYS,
} from "@/shared/schedules"
import { toPlainText } from "@/shared/text"
import { todayLocal, utcNow } from "@/shared/time"
import type {
  Entry, Schedule, ScheduleConversion, ScheduleConvertDto, ScheduleConvertResult,
} from "@/shared/types"

import { assertLocalOwner, localOwnerSnapshot } from "./scheduleStateRepo"
import { db } from "./schema"

function copy<T>(value: T): T {
  // 已校验为可持久化的正文/业务结构；分别复制来源、候选和返回值，避免共享可变引用。
  return JSON.parse(JSON.stringify(value)) as T
}

async function conversionQueue(ownerUserId: string): Promise<ScheduleConversion[]> {
  const row = await db.meta.get(SCHEDULE_META_KEYS.conversions)
  if (!row) return []
  if (!Array.isArray(row.value)) throw new Error("转简恢复队列损坏，请先备份并检查")
  const ids = new Set<string>()
  const result: ScheduleConversion[] = []
  for (const raw of row.value) {
    const runtimeOwner = (raw as Partial<ScheduleConversion> | null)?.ownerUserId
    if (!isBackupConversion(raw) || typeof runtimeOwner !== "string" ||
      runtimeOwner !== ownerUserId || ids.has(raw.scheduleId)) {
      throw new Error("转简恢复队列结构或归属异常，请先备份并检查")
    }
    ids.add(raw.scheduleId)
    result.push(raw as ScheduleConversion)
  }
  return result
}

async function existingConversion(
  row: Schedule, entry: Entry | undefined, queued: ScheduleConversion[],
): Promise<ScheduleConvertResult> {
  const purges = await db.meta.get("pendingPurges")
  const purged = !entry || (Array.isArray(purges?.value) && purges.value.includes(row.id))
  return {
    schedule: row, entry: purged ? undefined : entry, created: false,
    entryState: purged ? "purged" : entry!.isDeleted ? "deleted" : "active",
    pendingConfirmation: queued.some(item => item.scheduleId === row.id) ||
      row.dirty === 1 || !row.serverUpdatedAt,
  }
}

/** 只做本地原子转换；服务端确认/重放由后续独立日程同步负责。 */
export async function convertLocalSchedule(
  id: string, dto: ScheduleConvertDto,
): Promise<ScheduleConvertResult> {
  const entryId = scheduleEntryId(id)
  if (entryId !== id) throw new Error("预简来源ID格式异常")
  if (!dto || typeof dto.expectedClientUpdatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(dto.expectedClientUpdatedAt) ||
    !Number.isFinite(Date.parse(dto.expectedClientUpdatedAt))) {
    throw new Error("转简需要已保存的来源修订")
  }
  const owner = await db.transaction("r", db.meta, () => localOwnerSnapshot())
  return db.transaction("rw", db.schedules, db.entries, db.meta, async () => {
    await assertLocalOwner(owner)
    const row = await db.schedules.get(id)
    if (!row) throw new Error("预简不存在")
    if (!isBackupSchedule(row)) throw new Error("预简结构或转换关系异常，请先备份并检查")
    const queued = await conversionQueue(owner.ownerUserId)
    const entry = await db.entries.get(entryId)
    const linked = await db.entries.where("fromScheduleId").equals(id).toArray()
    if (linked.length > 1 || linked.some(item => item.id !== entryId) ||
      (entry && entry.fromScheduleId !== id)) {
      throw new Error("转简来源或日记主键冲突，未覆盖已有内容")
    }
    // 幂等读取优先于修订/到期检查：旧点击不能覆盖后来编辑、删除或弃去的同一篇。
    if (row.status === "converted") return existingConversion(row, entry, queued)
    const today = todayLocal()
    assertConvertibleSchedule(row, today)
    if (row.clientUpdatedAt !== dto.expectedClientUpdatedAt) {
      throw new Error("预简已被修改，请重新读取后转简")
    }
    if (entry || queued.some(item => item.scheduleId === id)) {
      throw new Error("预简与转简记录关系不完整，未覆盖已有内容")
    }
    const entryDate = dto.entryDate ?? row.remindDate
    assertScheduleDate(entryDate)
    assertScheduleDate(today)
    if (entryDate > today) throw new Error("转简日期不能是未来日期")
    assertScheduleBody(row.title, row.content)
    const sameDay = await db.entries.where("[isDeleted+entryDate]").equals([0, entryDate]).toArray()
    const sortOrder = sameDay.length ? Math.max(...sameDay.map(item => item.sortOrder)) + 1 : 0
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0) throw new Error("同日日记排序异常")
    const now = nextScheduleRevision(row.clientUpdatedAt, utcNow())
    const source: Schedule = {
      ...copy(row), contentText: toPlainText(row.content),
    }
    const created: Entry = {
      id: entryId, fromScheduleId: id, entryDate, sortOrder,
      title: row.title, content: copy(row.content), contentText: toPlainText(row.content),
      mood: null, weather: null, tagIds: [],
      createdAt: now, updatedAt: now, clientUpdatedAt: now, serverUpdatedAt: "",
      isDeleted: 0, deletedAt: null, dirty: 1,
    }
    const converted: Schedule = {
      ...source, status: "converted", convertedEntryId: entryId, convertedAt: now,
      updatedAt: now, clientUpdatedAt: now, dirty: 1,
    }
    const intent: ScheduleConversion = {
      scheduleId: id, source: copy(source), entry: copy(created),
      queuedAt: now, ownerUserId: owner.ownerUserId,
    }
    await db.entries.add(created)
    await db.schedules.put(converted)
    await db.meta.put({ key: SCHEDULE_META_KEYS.conversions, value: [...queued, intent] })
    return {
      schedule: converted, entry: created, created: true,
      entryState: "active", pendingConfirmation: true,
    }
  })
}