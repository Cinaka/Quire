import { readPrivateMedia } from "@/api/privateMedia"
import { assertSyncContext, captureSyncContext, type SyncContext } from "@/api/syncContext"
import { accessTokenSubject, tokenGeneration } from "@/api/tokenStore"
import type { MediaItem } from "@/shared/types"

import { localMediaRepo } from "./mediaRepo"
import { db } from "./schema"

function isImageBlob(blob: Blob | null | undefined): boolean {
  return Boolean(blob && blob.size > 0 && blob.type.toLowerCase().startsWith("image/"))
}

async function assertMediaContext(context: SyncContext): Promise<void> {
  await assertSyncContext(context)
  // Recheck auth after the final awaited owner read, not only before it.
  if (accessTokenSubject() !== context.ownerUserId || tokenGeneration() !== context.tokenGeneration) {
    throw new Error("图片读取会话已变化")
  }
}

async function download(id: string, variant: "original" | "thumbnail"): Promise<{
  blob: Blob; context: SyncContext
} | null> {
  if (!navigator.onLine) return null
  try {
    const context = await captureSyncContext()
    const blob = await readPrivateMedia(id, variant, context)
    await assertMediaContext(context)
    return { blob, context }
  } catch {
    return null // Leave local bytes and dirty state untouched on 401/404/429/network failure.
  }
}

async function fillMissing(item: MediaItem, variant: "original" | "thumbnail"): Promise<MediaItem | undefined> {
  const downloaded = await download(item.id, variant)
  if (!downloaded) return undefined
  const { blob, context } = downloaded
  return db.transaction("rw", db.media, db.meta, async () => {
    await assertMediaContext(context)
    const current = await db.media.get(item.id)
    if (!current) return undefined // Never recreate a deleted row after a late response.
    if (variant === "thumbnail") {
      if (isImageBlob(current.thumbBlob)) return current
      await db.media.update(item.id, { thumbBlob: blob })
      await assertMediaContext(context)
      return { ...current, thumbBlob: blob }
    }
    if (isImageBlob(current.blob)) return current
    await db.media.update(item.id, { blob, mime: blob.type, size: blob.size })
    await assertMediaContext(context)
    return { ...current, blob, mime: blob.type, size: blob.size }
  })
}

/** Local bytes first; only explicit cloud reads use authenticated, ID-bound API requests. */
export const localFirstMediaRepo = {
  ...localMediaRepo,

  async get(id: string): Promise<MediaItem | undefined> {
    const item = await localMediaRepo.get(id)
    if (!item || isImageBlob(item.blob) || !item.remoteUrl) return item
    try { return await fillMissing(item, "original") } catch { return undefined }
  },

  async getThumb(id: string): Promise<Blob | undefined> {
    const item = await localMediaRepo.get(id)
    if (!item) return undefined
    if (isImageBlob(item.thumbBlob)) return item.thumbBlob ?? undefined
    if (item.thumbRemoteUrl) {
      try {
        const filled = await fillMissing(item, "thumbnail")
        if (filled && isImageBlob(filled.thumbBlob)) return filled.thumbBlob ?? undefined
      } catch { return undefined }
    }
    // Do not use the pre-await item across an account/restore boundary.
    if (isImageBlob(item.blob) && !item.thumbRemoteUrl) return localMediaRepo.getThumb(id)
    try {
      const ready = await fillMissing(item, "original")
      return ready && isImageBlob(ready.blob) ? ready.blob : undefined
    } catch { return undefined }
  },
}
