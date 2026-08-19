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
  }
}

export const db = new QuireDb()
