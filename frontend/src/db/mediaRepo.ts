import { db } from "./schema"
import { newId } from "@/shared/ids"
import { utcNow } from "@/shared/time"
import type { MediaItem } from "@/shared/types"

/** 编辑器里图片节点的 src 用这个协议，绝不存 blob: 开头的临时地址。 */
export const LOCAL_MEDIA_PREFIX = "local://media/"

export function toLocalSrc(mediaId: string): string {
  return `${LOCAL_MEDIA_PREFIX}${mediaId}`
}

export function parseLocalSrc(src: string): string | null {
  return src.startsWith(LOCAL_MEDIA_PREFIX) ? src.slice(LOCAL_MEDIA_PREFIX.length) : null
}

async function measure(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  if (typeof createImageBitmap !== "function") return { width: null, height: null }
  try {
    const bmp = await createImageBitmap(blob)
    const size = { width: bmp.width, height: bmp.height }
    bmp.close()
    return size
  } catch {
    return { width: null, height: null }
  }
}

export const localMediaRepo = {
  /** 用户粘贴或拖入图片时调用。此时还不知道会挂到哪篇日记上，entryId 留空。 */
  async add(blob: Blob): Promise<MediaItem> {
    const { width, height } = await measure(blob)
    const item: MediaItem = {
      id: newId(),
      entryId: "",
      blob,
      thumbBlob: null,
      mime: blob.type || "image/png",
      width,
      height,
      size: blob.size,
      sortOrder: 0,
      remoteUrl: "",
      createdAt: utcNow(),
      dirty: 1,
    }
    await db.media.add(item)
    return item
  },

  async get(id: string): Promise<MediaItem | undefined> {
    return db.media.get(id)
  },

  async listByEntry(entryId: string): Promise<MediaItem[]> {
    const rows = await db.media.where("entryId").equals(entryId).toArray()
    return rows.sort((a, b) => a.sortOrder - b.sortOrder)
  },

  /** 保存日记时调用，把这次正文里实际用到的图片关联过去。 */
  async attach(entryId: string, mediaIds: string[]): Promise<void> {
    await db.transaction("rw", db.media, async () => {
      for (let i = 0; i < mediaIds.length; i++) {
        await db.media.update(mediaIds[i], { entryId, sortOrder: i, dirty: 1 })
      }
    })
  },

  /**
   * 清理孤儿图片：用户贴了图但最后没保存，或者贴完又删掉了。
   * 建议在应用启动时跑一次，只清超过 24 小时的，避免误删正在编辑的内容。
   */
  async purgeOrphans(olderThanHours = 24): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString()
    const orphans = await db.media.where("entryId").equals("").toArray()
    const stale = orphans.filter((m) => m.createdAt < cutoff).map((m) => m.id)
    if (stale.length) await db.media.bulkDelete(stale)
    return stale.length
  },
}
