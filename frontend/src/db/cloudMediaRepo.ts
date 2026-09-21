import type { MediaItem } from "@/shared/types"

import { localMediaRepo } from "./mediaRepo"
import { db } from "./schema"

async function download(url: string): Promise<Blob | null> {
  if (!url || !navigator.onLine) return null
  try {
    const response = await fetch(url, { credentials: "same-origin" })
    if (!response.ok) return null
    return await response.blob()
  } catch {
    return null
  }
}

async function ensureOriginal(item: MediaItem): Promise<MediaItem> {
  if (item.blob.size > 0 || !item.remoteUrl) return item
  const blob = await download(item.remoteUrl)
  if (!blob) return item
  await db.media.update(item.id, {
    blob,
    mime: blob.type || item.mime,
    size: blob.size,
  })
  return { ...item, blob, mime: blob.type || item.mime, size: blob.size }
}

/**
 * P2 图片三级回退：本地 Blob → 云端地址并回填 → 缺图占位。
 * 页面仍只使用 mediaRepo，不需要知道图片来自本机还是服务器。
 */
export const localFirstMediaRepo = {
  ...localMediaRepo,

  async get(id: string): Promise<MediaItem | undefined> {
    const item = await localMediaRepo.get(id)
    return item ? ensureOriginal(item) : undefined
  },

  async getThumb(id: string): Promise<Blob | undefined> {
    const item = await localMediaRepo.get(id)
    if (!item) return undefined
    if (item.thumbBlob) return item.thumbBlob

    if (item.thumbRemoteUrl) {
      const thumb = await download(item.thumbRemoteUrl)
      if (thumb) {
        await db.media.update(id, { thumbBlob: thumb })
        return thumb
      }
    }

    const ready = await ensureOriginal(item)
    if (ready.blob.size === 0) return undefined
    return localMediaRepo.getThumb(id)
  },
}
