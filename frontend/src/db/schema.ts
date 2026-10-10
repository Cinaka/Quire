import Dexie, { type EntityTable } from "dexie"

import type { Entry, MediaItem, Schedule, Tag } from "@/shared/types"

export interface MetaRow {
  key: string
  value: unknown
}

export class QuireDb extends Dexie {
  schedules!: EntityTable<Schedule, "id">
  entries!: EntityTable<Entry, "id">
  tags!: EntityTable<Tag, "id">
  media!: EntityTable<MediaItem, "id">
  meta!: EntityTable<MetaRow, "key">

  constructor(name = "quire") {
    super(name)

    this.version(1).stores({
      entries:
        "id, entryDate, updatedAt, isDeleted, dirty, *tagIds, [isDeleted+entryDate], [isDeleted+updatedAt]",
      tags: "id, name, dirty",
      media: "id, entryId, createdAt, dirty",
      meta: "key",
    })

    this.version(2)
      .stores({
        entries:
          "id, entryDate, updatedAt, isDeleted, dirty, *tagIds, [isDeleted+entryDate], [isDeleted+updatedAt]",
        tags: "id, name, dirty",
        media: "id, entryId, createdAt, dirty, remoteUrl",
        meta: "key",
      })
      .upgrade(async (tx) => {
        // 新增的都是非索引字段，Dexie 不会自动补默认值，读到 undefined 会让
        // "" 判断与 JSON 备份都出错，所以在 upgrade 里显式补齐。
        await tx.table("media").toCollection().modify((m) => {
          if (typeof m.remoteUrl !== "string") m.remoteUrl = ""
          if (typeof m.thumbRemoteUrl !== "string") m.thumbRemoteUrl = ""
        })
        await tx.table("entries").toCollection().modify((e) => {
          if (typeof e.serverUpdatedAt !== "string") e.serverUpdatedAt = ""
        })
      })

    // P4：只添加新表和来源索引，既有 v1/v2 定义与数据保持原样。
    this.version(3).stores({
      entries:
        "id, entryDate, updatedAt, isDeleted, dirty, *tagIds, fromScheduleId, [isDeleted+entryDate], [isDeleted+updatedAt]",
      tags: "id, name, dirty",
      media: "id, entryId, createdAt, dirty, remoteUrl",
      meta: "key",
      schedules: "id, remindDate, status, updatedAt, dirty, isDeleted, [isDeleted+status+remindDate]",
    })
  }
}



export const db = new QuireDb()
