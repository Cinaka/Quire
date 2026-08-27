import { db } from "./schema"
import { newId } from "@/shared/ids"
import { normalizeTagName } from "@/shared/tags"
import { utcNow } from "@/shared/time"
import type { Tag } from "@/shared/types"

export interface ITagRepo {
  list(): Promise<Tag[]>
  getMany(ids: readonly string[]): Promise<Tag[]>
  getOrCreate(name: string): Promise<Tag>
}

export const localTagRepo: ITagRepo = {
  async list() {
    const rows = await db.tags.toArray()
    return rows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
  },

  async getMany(ids) {
    const rows = await db.tags.bulkGet([...ids])
    return rows.filter((row): row is Tag => Boolean(row))
  },

  async getOrCreate(name) {
    const normalized = name.trim()
    if (!normalized) throw new Error("标签不能为空")
    if ([...normalized].length > 32) throw new Error("标签不能超过 32 个字符")

    return db.transaction("rw", db.tags, async () => {
      const wanted = normalizeTagName(normalized)
      const rows = await db.tags.toArray()
      const existed = rows.find((tag) => normalizeTagName(tag.name) === wanted)
      if (existed) return existed

      const tag: Tag = {
        id: newId(),
        name: normalized,
        color: null,
        createdAt: utcNow(),
        dirty: 1,
      }
      await db.tags.add(tag)
      return tag
    })
  },
}
