import { resizeToBlob } from "@/capabilities/image"
import { newId } from "@/shared/ids"
import { collectMediaIds } from "@/shared/text"
import { utcNow } from "@/shared/time"
import type { MediaItem } from "@/shared/types"

import { db } from "./schema"

/** 原图入库上限。算术见 E1 第一小节 */
const IMAGE_MAX_EDGE = 1920
const IMAGE_QUALITY = 0.8
/** 缩略图长边。算术见批次 B 第四小节 */
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
      // 刚贴进来就是孤儿：窗口从此刻起算，与 createdAt 同值。
      // 写成显式字段而不依赖 undefined 回退，是为了新数据不再进 ?? 分支。
      orphanedAt: utcNow(),
      dirty: 1,
    }
    await db.media.add(item)
    return item
  },

  /**
   * 全库对账：以全部 Entry 正文 JSON 为唯一真相，校正 entryId / sortOrder，
   * 并维护 orphanedAt。包含在册与断简：断简图片仍保持关联，恢复不丢。
   *
   * 启动时先 reconcileAll() 再 purgeOrphans()（见 main.ts）：对账只负责
   * “打上变孤儿的时刻”，真正删除至少要等 24 小时后的下一次启动。
   */
  async reconcileAll(): Promise<number> {
    const entries = await db.entries.toArray()
    const mediaIds = (await db.media.orderBy("id").primaryKeys()) as string[]
    const expected = new Map<string, { entryId: string; sortOrder: number }>()

    for (const entry of entries) {
      const ids = collectMediaIds(entry.content?.doc)
      ids.forEach((id, sortOrder) => {
        // 同一张图被两篇引用时只归第一篇。已知、可接受：P1 不做多对多，
        // 且两篇正文都仍能按 id 正常显示图片。
        if (!expected.has(id)) expected.set(id, { entryId: entry.id, sortOrder })
      })
    }

    let changed = 0
    await db.transaction("rw", db.media, async () => {
      for (const id of mediaIds) {
        const item = await db.media.get(id)
        if (!item) continue

        const next = expected.get(id)
        const wantEntryId = next?.entryId ?? ""
        const wantSortOrder = next?.sortOrder ?? 0
        // 已经是孤儿的保持原有 orphanedAt，不要每次启动都刷新时间戳，
        // 否则窗口永远走不完，孤儿永不被清。?? item.createdAt 是历史数据
        // （E1 上线前已是孤儿、无 orphanedAt）的入口，行为与今天一致。
        const wantOrphanedAt = next ? null : (item.orphanedAt ?? item.createdAt)

        if (
          item.entryId === wantEntryId &&
          item.sortOrder === wantSortOrder &&
          (item.orphanedAt ?? null) === (wantOrphanedAt ?? null)
        ) {
          continue
        }

        await db.media.update(id, {
          entryId: wantEntryId,
          sortOrder: wantSortOrder,
          orphanedAt: wantOrphanedAt,
          dirty: 1,
        })
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

      // 不立即物理删除：用户仍可能撤销。退回孤儿时才写 orphanedAt，
      // 窗口从此刻起算（而不是从当初贴图起算）。
      for (const item of attached) {
        if (!keep.has(item.id)) {
          await db.media.update(item.id, {
            entryId: "",
            sortOrder: 0,
            orphanedAt: utcNow(),
            dirty: 1,
          })
        }
      }

      for (let i = 0; i < mediaIds.length; i++) {
        await db.media.update(mediaIds[i], {
          entryId,
          sortOrder: i,
          orphanedAt: null,
          dirty: 1,
        })
      }
    })
  },

  /**
   * 清理孤儿图片：用户贴了图但最后没保存，或者贴完又删掉了。
   * 建议在应用启动时跑一次，只清超过 24 小时的，避免误删正在编辑的内容。
   *
   * 判据是 orphanedAt（变成孤儿的时刻），不是 createdAt。两者在 E 之前等价；
   * E1 对账与 E2 attach 引入“追溯性变孤儿”后，继续用 createdAt 会把一周前
   * 贴、今天刚从正文删掉的图在下次启动就直接删光，撤销窗口为零。
   */
  async purgeOrphans(olderThanHours = 24): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanHours * 3600_000).toISOString()
    const orphans = await db.media.where("entryId").equals("").toArray()
    const stale = orphans
      .filter((m) => (m.orphanedAt ?? m.createdAt) < cutoff)
      .map((m) => m.id)
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

  /**
   * 按 Entry 批量统计正文里的图片张数，给列表 / 首页的数量徽标用。
   *
   * 与 firstByEntries 同口径：以正文 JSON 为唯一真相，不信任 media.entryId
   * （E2 之前删过图但没重存的旧数据可能仍有脏关联）；并且只数 media 表里
   * 确实还在的 id，让徽标数字与实际能显示出来的图片一致。
   */
  async countByEntries(entryIds: readonly string[]): Promise<Record<string, number>> {
    if (!entryIds.length) return {}

    const entries = await db.entries.bulkGet([...entryIds])
    // 只取主键判断存在，绝不 bulkGet MediaItem（那会把原图 Blob 一起载入内存）。
    const existing = new Set((await db.media.orderBy("id").primaryKeys()) as string[])
    const result: Record<string, number> = {}

    for (const entry of entries) {
      if (!entry) continue
      result[entry.id] = collectMediaIds(entry.content?.doc).filter((id) =>
        existing.has(id),
      ).length
    }
    return result
  },
}
