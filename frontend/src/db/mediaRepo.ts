import { db } from "./schema"
import { newId } from "@/shared/ids"
import { utcNow } from "@/shared/time"
import type { MediaItem } from "@/shared/types"
import { resizeToBlob } from "@/capabilities/image"
import { collectMediaIds } from "@/shared/text"

/** 缩略图长边。算术见本节第四小节 */
const IMAGE_MAX_EDGE = 1920
const IMAGE_QUALITY = 0.8
const THUMB_MAX_EDGE = 480
const THUMB_QUALITY = 0.8

async function measure(blob: Blob): Promise<{ width: number | null; height: number | null }> {
  if (typeof createImageBitmap !== "function") return { width: null, height: null }
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" })
    const size = { width: bmp.width, height: bmp.height }
    bmp.close()
    return size
  } catch {
    return { width: null, height: null }
  }
}

async function compressForStorage(blob: Blob): Promise<Blob> {
  // 动图不能经过 canvas，否则只剩第一帧。
  if (blob.type === "image/gif") return blob

  const compressed = await resizeToBlob(blob, {
    maxEdge: IMAGE_MAX_EDGE,
    quality: IMAGE_QUALITY,
    mime: "image/webp",
  })

  // 小图、解码失败、浏览器不支持，或转完反而更大：全部保留原图。
  return compressed && compressed.size < blob.size ? compressed : blob
}



export const localMediaRepo = {
  /** 用户粘贴或拖入图片时调用。此时还不知道会挂到哪篇日记上，entryId 留空。 */
  async add(blob: Blob): Promise<MediaItem> {
    const storedBlob = await compressForStorage(blob)
    const [{ width, height }, thumbBlob] = await Promise.all([
      measure(storedBlob),
      resizeToBlob(storedBlob, {
        maxEdge: THUMB_MAX_EDGE,
        quality: THUMB_QUALITY,
        mime: "image/webp",
      }),
    ])

    const item: MediaItem = {
      id: newId(),
      entryId: "",
      blob: storedBlob,
      thumbBlob,
      mime: storedBlob.type || blob.type || "image/png",
      width,
      height,
      size: storedBlob.size,
      sortOrder: 0,
      remoteUrl: "",
      createdAt: utcNow(),
      dirty: 1,
    }
    await db.media.add(item)
    return item
  },

  async reconcileAll(): Promise<number> {
    const entries = await db.entries.toArray()
    const mediaIds = (await db.media.orderBy("id").primaryKeys()) as string[]
    const expected = new Map<string, { entryId: string; sortOrder: number }>()

    for (const entry of entries) {
      const ids = collectMediaIds(entry.content?.doc)
      ids.forEach((id, sortOrder) => {
        if (!expected.has(id)) expected.set(id, { entryId: entry.id, sortOrder })
      })
    }

    let changed = 0
    await db.transaction("rw", db.media, async () => {
      for (const id of mediaIds) {
        const item = await db.media.get(id)
        if (!item) continue
        const next = expected.get(id) ?? { entryId: "", sortOrder: 0 }
        if (item.entryId === next.entryId && item.sortOrder === next.sortOrder) continue
        await db.media.update(id, { ...next, dirty: 1 })
        changed += 1
      }
    })
    return changed
  },

  async get(id: string): Promise<MediaItem | undefined> {
    return db.media.get(id)
  },

  async listByEntry(entryId: string): Promise<MediaItem[]> {
    const rows = await db.media.where("entryId").equals(entryId).toArray()
    return rows.sort((a, b) => a.sortOrder - b.sortOrder)
  },

  async firstByEntries(entryIds: readonly string[]): Promise<Record<string, string>> {
    if (!entryIds.length) return {}

    const entries = await db.entries.bulkGet([...entryIds])
    const refs = new Map<string, string[]>()

    for (const entry of entries) {
      if (!entry) continue
      refs.set(entry.id, collectMediaIds(entry.content?.doc))
    }

    // 只取主键判断存在；bulkGet MediaItem 会把原图 Blob 一起载入内存。
    const existing = new Set((await db.media.orderBy("id").primaryKeys()) as string[])
    const result: Record<string, string> = {}

    for (const [entryId, ids] of refs) {
      const first = ids.find((id) => existing.has(id))
      if (first) result[entryId] = first
    }
    return result
  },

  /** 保存日记时调用，把这次正文里实际用到的图片关联过去。 */
  async attach(entryId: string, mediaIds: string[]): Promise<void> {
    await db.transaction("rw", db.media, async () => {
      const keep = new Set(mediaIds)
      const attached = await db.media.where("entryId").equals(entryId).toArray()

      // 不立即物理删除：用户仍可能撤销。退回孤儿后由启动时的
      // purgeOrphans() 按既有 24 小时窗口清理。
      for (const item of attached) {
        if (!keep.has(item.id)) {
          await db.media.update(item.id, { entryId: "", sortOrder: 0, dirty: 1 })
        }
      }

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

  /**
   * 取缩略图。永远能拿到一张能显示的图（实在没有才返回 undefined）。
   *
   * 旧图（P1-1~P1-5 期间贴的）与旧备份导入的 thumbBlob 都是 null，
   * 在这里惰性补上。不在启动时批量回填：那等于启动时把全库图片
   * 解码一遍，还要跟 purgeOrphans 抢同一个启动窗口。
   */
  async getThumb(id: string): Promise<Blob | undefined> {
    const m = await db.media.get(id)
    if (!m) return undefined
    if (m.thumbBlob) return m.thumbBlob

    const t = await resizeToBlob(m.blob, {
      maxEdge: THUMB_MAX_EDGE,
      quality: THUMB_QUALITY,
    })
    // 生成不出来就不写库，下次还会再试一次。对「本来就比 480 小」的图
    // 确实是白跑一次 decode，但换来的是不必在库里再存一份几乎等大的副本
    if (t) await db.media.update(id, { thumbBlob: t, dirty: 1 })
    return t ?? m.blob
  },
}
