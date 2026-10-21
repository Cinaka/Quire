import { projectNotebookContent } from "@/shared/notebookContent"
import type { Entry, MediaItem } from "@/shared/types"

export interface NotebookReadLease {
  ownerUserId: string
  generation: string
  authGeneration: number
}
export type NotebookMediaResult =
  | { state: "ready"; blob: Blob; thumbnailOnly: boolean }
  | { state: "missing" | "unsupported" }
export interface NotebookReadPort {
  readEntry(id: string): Promise<Entry | undefined>
  readMedia(entry: Entry, mediaId: string): Promise<NotebookMediaResult>
  assertCurrent(): Promise<void>
  subscribe(ids: readonly string[], changed: () => void, failed: () => void): () => void
  subscribeMedia(entryId: string, mediaId: string, changed: () => void, failed: () => void): () => void
  close(): void
}
export interface NotebookReadIO {
  /** Only a read transaction. Adapter supplies no write methods. */
  read<T>(work: () => Promise<T>): Promise<T>
  owner(): Promise<{ ownerUserId: string; generation: string }>
  auth(): { subject: string; generation: number; valid: boolean }
  entry(id: string): Promise<Entry | undefined>
  media(id: string): Promise<MediaItem | undefined>
  observe(ids: readonly string[], changed: () => void, failed: () => void, mediaIds?: readonly string[]): () => void
}
const active = (entry: Entry | undefined): entry is Entry => Boolean(entry && entry.isDeleted === 0 && entry.deletedAt === null)
const image = (blob: Blob | null | undefined): blob is Blob => Boolean(blob && blob.size > 0 && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(blob.type.toLowerCase()))
const expired = () => new Error("简册登录、归属或恢复上下文已失效，请返回列表重新核验。")

/** Internal only: the P5-2 /auth/me gate must create the lease, not a view prop. */
export function createNotebookReadCore(io: NotebookReadIO, source: NotebookReadLease): NotebookReadPort {
  const lease = { ...source }
  let closed = false
  const subscriptions = new Map<() => void, () => void>()
  function auth(): void {
    const now = io.auth()
    if (closed || !lease.ownerUserId || !now.valid || now.subject !== lease.ownerUserId || now.generation !== lease.authGeneration) throw expired()
  }
  async function assertCurrent(): Promise<void> {
    auth()
    const owner = await io.owner()
    auth()
    if (owner.ownerUserId !== lease.ownerUserId || owner.generation !== lease.generation) throw expired()
  }
  async function read<T>(work: () => Promise<T>): Promise<T> {
    auth()
    const result = await io.read(async () => {
      await assertCurrent()
      const result = await work()
      await assertCurrent()
      return result
    })
    // Commit/transaction completion is also an await boundary.
    await assertCurrent()
    return result
  }
  function subscribe(ids: readonly string[], changed: () => void, failed: () => void, mediaIds: readonly string[] = []): () => void {
    auth()
    let stopped = false
    const stop = io.observe([...ids], () => { if (!stopped && !closed) changed() }, () => { if (!stopped && !closed) failed() }, mediaIds)
    const dispose = () => { if (!stopped) { stopped = true; stop(); subscriptions.delete(dispose) } }
    subscriptions.set(dispose, failed)
    return dispose
  }
  return {
    assertCurrent,
    readEntry: id => read(async () => {
      const entry = await io.entry(id)
      return active(entry) ? entry : undefined
    }),
    readMedia: (snapshot, mediaId) => read<NotebookMediaResult>(async () => {
      const current = await io.entry(snapshot.id)
      if (!active(current) || JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error("日记已变化，请重新读取后再显示图片")
      if (!projectNotebookContent(current.content).mediaIds.includes(mediaId)) throw new Error("图片不在当前日记引用中")
      const media = await io.media(mediaId)
      if (!media) return { state: "missing" }
      if (image(media.blob)) return { state: "ready", blob: media.blob, thumbnailOnly: false }
      if (image(media.thumbBlob)) return { state: "ready", blob: media.thumbBlob, thumbnailOnly: true }
      return { state: media.blob?.size || media.thumbBlob?.size ? "unsupported" : "missing" }
    }),
    subscribe,
    subscribeMedia: (entryId, mediaId, changed, failed) => subscribe([entryId], changed, failed, [mediaId]),
    close() {
      closed = true
      for (const [stop, failed] of [...subscriptions]) {
        stop()
        try { failed() } catch { /* One listener must not retain other readers. */ }
      }
    },
  }
}
