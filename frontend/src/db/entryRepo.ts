import { db } from "./schema"
import { newId } from "@/shared/ids"
import { collectMediaIds, toPlainText } from "@/shared/text"
import { todayLocal, utcNow } from "@/shared/time"
import type {
  Entry,
  EntryCreateDto,
  EntryListItem,
  EntryListParams,
  EntryOrder,
  EntryUpdateDto,
  Paged,
} from "@/shared/types"

export interface IEntryRepo {
  list(params?: EntryListParams): Promise<Paged<EntryListItem>>
  get(id: string): Promise<Entry | undefined>
  create(dto: EntryCreateDto): Promise<Entry>
  update(id: string, dto: EntryUpdateDto): Promise<Entry>
  /** 软删除，进回收站 */
  remove(id: string): Promise<void>
  restore(id: string): Promise<void>
  /** 彻底删除，连带清掉图片 */
  purge(id: string): Promise<void>
  countByDate(from: string, to: string): Promise<Record<string, number>>
}

function stripContent(e: Entry): EntryListItem {
  const { content: _omit, ...rest } = e
  return rest
}

function comparator(order: EntryOrder): (a: Entry, b: Entry) => number {
  return (a, b) => {
    if (order === "updatedAtDesc") return b.updatedAt.localeCompare(a.updatedAt)
    const d =
      order === "entryDateAsc"
        ? a.entryDate.localeCompare(b.entryDate)
        : b.entryDate.localeCompare(a.entryDate)
    // 同一天多篇时，按 sortOrder 倒序（新写的在上面）
    return d !== 0 ? d : b.sortOrder - a.sortOrder
  }
}

async function nextSortOrder(entryDate: string): Promise<number> {
  const same = await db.entries.where("[isDeleted+entryDate]").equals([0, entryDate]).toArray()
  return same.length === 0 ? 0 : Math.max(...same.map((e) => e.sortOrder)) + 1
}

export const localEntryRepo: IEntryRepo = {
  async list(params = {}) {
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.max(1, params.pageSize ?? 20)
    const flag: 0 | 1 = params.onlyDeleted ? 1 : 0

    let coll =
      params.dateFrom || params.dateTo
        ? db.entries
          .where("[isDeleted+entryDate]")
          .between(
            [flag, params.dateFrom ?? "0000-01-01"],
            [flag, params.dateTo ?? "9999-12-31"],
            true,
            true,
          )
        : db.entries.where("isDeleted").equals(flag)

    if (params.tagIds?.length) {
      const wanted = [...new Set(params.tagIds)]
      coll = coll.and((entry) => wanted.every((id) => entry.tagIds.includes(id)))
    }

    if (params.hasImage !== undefined) {
      coll = coll.and(
        (entry) => (collectMediaIds(entry.content?.doc).length > 0) === params.hasImage,
      )
    }

    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      coll = coll.and(
        (e) => e.title.toLowerCase().includes(kw) || e.contentText.toLowerCase().includes(kw),
      )
    }

    // P1 阶段直接全部取出再排序分页。个人日记量级（几千条）下完全够用，
    // 而且能保证排序语义和 P2 的服务端实现完全一致。数据量真的变大是 P2 之后的事。
    const all = await coll.toArray()
    all.sort(comparator(params.order ?? "entryDateDesc"))

    return {
      items: all.slice((page - 1) * pageSize, page * pageSize).map(stripContent),
      total: all.length,
      page,
      pageSize,
    }
  },

  async get(id) {
    return db.entries.get(id)
  },

  async create(dto) {
    const now = utcNow()
    const content = dto.content ?? null
    const entryDate = dto.entryDate ?? todayLocal()

    const entry: Entry = {
      id: newId(),
      entryDate,
      sortOrder: await nextSortOrder(entryDate),
      title: (dto.title ?? "").slice(0, 255),
      content,
      contentText: toPlainText(content),
      mood: dto.mood ?? null,
      weather: dto.weather ?? null,
      tagIds: dto.tagIds ?? [],
      fromScheduleId: dto.fromScheduleId ?? null,
      createdAt: now,
      updatedAt: now,
      clientUpdatedAt: now,
      deletedAt: null,
      isDeleted: 0,
      dirty: 1,
    }

    await db.entries.add(entry)
    return entry
  },

  async update(id, dto) {
    return db.transaction("rw", db.entries, async () => {
      const cur = await db.entries.get(id)
      if (!cur) throw new Error(`entry not found: ${id}`)

      const next: Entry = { ...cur }

      // 逐字段判断，不用对象展开。因为 dto 里显式传 undefined 的字段
      // 会在展开时覆盖掉原值，导致"只想改标题却把正文清空"。
      if (dto.entryDate !== undefined) next.entryDate = dto.entryDate
      if (dto.title !== undefined) next.title = dto.title.slice(0, 255)
      if (dto.mood !== undefined) next.mood = dto.mood
      if (dto.weather !== undefined) next.weather = dto.weather
      if (dto.tagIds !== undefined) next.tagIds = dto.tagIds
      if (dto.content !== undefined) {
        next.content = dto.content
        // 这一行是整个存储层最重要的不变量：
        // contentText 只能由 content 派生，且必须同一次写入。
        // 漏掉它不会报任何错，只会让搜索结果永远停留在旧内容上。
        next.contentText = toPlainText(dto.content)
      }

      next.updatedAt = utcNow()
      next.clientUpdatedAt = next.updatedAt
      next.dirty = 1

      await db.entries.put(next)
      return next
    })
  },

  async remove(id) {
    const now = utcNow()
    await db.entries.update(id, {
      isDeleted: 1,
      deletedAt: now,
      updatedAt: now,
      clientUpdatedAt: now,
      dirty: 1,
    })
  },

  async restore(id) {
    const now = utcNow()
    await db.entries.update(id, {
      isDeleted: 0,
      deletedAt: null,
      updatedAt: now,
      clientUpdatedAt: now,
      dirty: 1,
    })
  },

  async purge(id) {
    await db.transaction("rw", db.entries, db.media, async () => {
      await db.media.where("entryId").equals(id).delete()
      await db.entries.delete(id)
    })
  },

  async countByDate(from, to) {
    const rows = await db.entries
      .where("[isDeleted+entryDate]")
      .between([0, from], [0, to], true, true)
      .toArray()

    const map: Record<string, number> = {}
    for (const r of rows) map[r.entryDate] = (map[r.entryDate] ?? 0) + 1
    return map
  },
}
