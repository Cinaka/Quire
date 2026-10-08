import { newId } from "@/shared/ids"
import {
  assertNewScheduleDate,
  assertScheduleBody,
  assertScheduleDate,
  nextScheduleRevision,
} from "@/shared/schedules"
import { toPlainText } from "@/shared/text"
import { utcNow } from "@/shared/time"
import type {
  Paged, Schedule, ScheduleCreateDto, ScheduleListParams, ScheduleUpdateDto,
} from "@/shared/types"

import { db } from "./schema"

/** 内部数据层；备份/认领/同步保护未完成前不从 @/repo 导出，不接 UI。 */
export interface IScheduleRepo {
  list(params?: ScheduleListParams): Promise<Paged<Schedule>>
  get(id: string): Promise<Schedule | undefined>
  create(dto: ScheduleCreateDto): Promise<Schedule>
  update(id: string, dto: ScheduleUpdateDto): Promise<Schedule>
  remove(id: string): Promise<void>
  restore(id: string): Promise<void>
}

function pageNumber(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("预简分页参数无效")
  return result
}

async function setDeleted(id: string, deleted: boolean): Promise<void> {
  await db.transaction("rw", db.schedules, async () => {
    const row = await db.schedules.get(id)
    if (!row) throw new Error("预简不存在")
    const flag: 0 | 1 = deleted ? 1 : 0
    if (row.isDeleted === flag) return
    const now = nextScheduleRevision(row.clientUpdatedAt, utcNow())
    await db.schedules.put({
      ...row, isDeleted: flag, deletedAt: deleted ? now : null,
      updatedAt: now, clientUpdatedAt: now, dirty: 1,
    })
  })
}

export const localScheduleRepo: IScheduleRepo = {
  async list(params = {}) {
    const page = pageNumber(params.page, 1)
    const pageSize = Math.min(pageNumber(params.pageSize, 20), 100)
    if (params.dateFrom !== undefined) assertScheduleDate(params.dateFrom)
    if (params.dateTo !== undefined) assertScheduleDate(params.dateTo)
    if (params.dateFrom && params.dateTo && params.dateFrom > params.dateTo) {
      throw new Error("预简日期区间无效")
    }
    if (params.status !== undefined && !["pending", "converted"].includes(params.status)) {
      throw new Error("预简筛选状态无效")
    }
    const flag: 0 | 1 = params.onlyDeleted ? 1 : 0
    let rows = await db.schedules.where("isDeleted").equals(flag).toArray()
    rows = rows.filter((row) =>
      (!params.status || row.status === params.status) &&
      (!params.dateFrom || row.remindDate >= params.dateFrom) &&
      (!params.dateTo || row.remindDate <= params.dateTo),
    )
    rows.sort((a, b) => a.remindDate.localeCompare(b.remindDate) || a.id.localeCompare(b.id))
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize }
  },

  async get(id) { return db.schedules.get(id) },

  async create(dto) {
    assertNewScheduleDate(dto.remindDate)
    const title = (dto.title ?? "").slice(0, 255)
    const content = dto.content ?? null
    assertScheduleBody(title, content)
    const now = utcNow()
    const row: Schedule = {
      id: newId(), remindDate: dto.remindDate, title, content,
      contentText: toPlainText(content), status: "pending", convertedEntryId: null,
      convertedAt: null, createdAt: now, updatedAt: now, clientUpdatedAt: now,
      serverUpdatedAt: "", deletedAt: null, isDeleted: 0, dirty: 1,
    }
    await db.schedules.add(row)
    return row
  },

  async update(id, dto) {
    return db.transaction("rw", db.schedules, async () => {
      const row = await db.schedules.get(id)
      if (!row) throw new Error("预简不存在")
      if (row.status !== "pending") throw new Error("已转简预简不能修改")
      if (row.isDeleted) throw new Error("请先恢复预简再修改")
      const next: Schedule = { ...row }
      if (dto.remindDate !== undefined) {
        assertScheduleDate(dto.remindDate)
        next.remindDate = dto.remindDate
      }
      if (dto.title !== undefined) next.title = dto.title.slice(0, 255)
      if (dto.content !== undefined) {
        next.content = dto.content
        next.contentText = toPlainText(dto.content)
      }
      assertScheduleBody(next.title, next.content)
      const now = nextScheduleRevision(row.clientUpdatedAt, utcNow())
      next.updatedAt = now
      next.clientUpdatedAt = now
      next.dirty = 1
      await db.schedules.put(next)
      return next
    })
  },

  async remove(id) { await setDeleted(id, true) },
  async restore(id) { await setDeleted(id, false) },
}
