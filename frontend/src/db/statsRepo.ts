import { db } from "./schema"
import type { LocalStats } from "@/shared/types"

export const localStatsRepo = {
  async load(): Promise<LocalStats> {
    const [entries, deleted, tags, media] = await Promise.all([
      db.entries.where("isDeleted").equals(0).count(),
      db.entries.where("isDeleted").equals(1).count(),
      db.tags.count(),
      db.media.count(),
    ])

    // 用 each 逐条累加，不用 toArray()。
    // toArray() 会把所有原图 Blob 同时留在数组里；each 走游标，
    // 每条用完即可回收，只是免不了逐条反序列化。
    let mediaBytes = 0
    await db.media.each((m) => {
      mediaBytes += m.size || m.blob.size
    })

    return { entries, deleted, tags, media, mediaBytes }
  },
}
