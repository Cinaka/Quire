import type { MediaItem } from "@/shared/types"

import { localMediaRepo } from "./mediaRepo"
import { db } from "./schema"

function isImageBlob(blob: Blob | null | undefined): boolean {
  return Boolean(blob && blob.size > 0 && blob.type.toLowerCase().startsWith("image/"))
}

async function download(url: string): Promise<Blob | null> {
  if (!url || !navigator.onLine) return null
  try {
    const response = await fetch(url, { credentials: "same-origin" })
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
    if (!response.ok || !contentType.startsWith("image/")) return null
    const blob = await response.blob()
    return isImageBlob(blob) ? blob : null
  } catch {
    return null
  }
}

async function ensureOriginal(item: MediaItem): Promise<MediaItem> {
  if (isImageBlob(item.blob)) return item
  if (!item.remoteUrl) return item

  const blob = await download(item.remoteUrl)
  if (!blob) {
    // 旧版开发代理可能把 index.html 缓存成 text/html Blob。清掉错误缓存，
    // 保留 remoteUrl，下一次联网读取时仍会继续尝试修复。
    if (item.blob.size > 0) {
      const empty = new Blob([], { type: item.mime || "image/png" })
      await db.media.update(item.id, { blob: empty, thumbBlob: null, size: 0 })
      return { ...item, blob: empty, thumbBlob: null, size: 0 }
    }
    return item
  }

  await db.media.update(item.id, {
    blob,
    mime: blob.type || item.mime,
    size: blob.size,
  })
  return { ...item, blob, mime: blob.type || item.mime, size: blob.size }
}

/** 本地 Blob → 云端图片并回填 → 缺图占位。 */
export const localFirstMediaRepo = {
  ...localMediaRepo,

  async get(id: string): Promise<MediaItem | undefined> {
    const item = await localMediaRepo.get(id)
    return item ? ensureOriginal(item) : undefined
  },

  async getThumb(id: string): Promise<Blob | undefined> {
    const item = await localMediaRepo.get(id)
    if (!item) return undefined
    if (isImageBlob(item.thumbBlob)) return item.thumbBlob ?? undefined

    if (item.thumbRemoteUrl) {
      const thumb = await download(item.thumbRemoteUrl)
      if (thumb) {
        await db.media.update(id, { thumbBlob: thumb })
        return thumb
      }
    }

    const ready = await ensureOriginal(item)
    if (!isImageBlob(ready.blob)) return undefined
    const thumb = await localMediaRepo.getThumb(id)
    return isImageBlob(thumb) ? thumb : ready.blob
  },
}
