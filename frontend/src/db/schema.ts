import Dexie, { type EntityTable } from "dexie"

import type { Entry, MediaItem, Tag } from "@/shared/types"

export interface MetaRow {
  key: string
  value: unknown
}

export class QuireDb extends Dexie {
  entries!: EntityTable<Entry, "id">
  tags!: EntityTable<Tag, "id">
  media!: EntityTable<MediaItem, "id">
  meta!: EntityTable<MetaRow, "key">

  constructor() {
    super("quire")

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
  }
}



export const db = new QuireDb()
