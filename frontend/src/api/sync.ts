import { db } from "@/db/schema"
import { pullChanges, pushBatch, uploadMedia } from "@/api/endpoints"
import { fromWireEntry, fromWireTag, mediaPatchFromWire, toWireEntry, toWireMediaMetaPush, toWireTag } from "@/api/mappers"
import type { WireMediaMeta, WireTag } from "@/api/wire"
import { utcNow } from "@/shared/time"
import type { Entry } from "@/shared/types"

const BATCH = 50
const MAX_ERRORS = 3
let running = false

async function meta(key: string): Promise<string> {
  const row = await db.meta.get(key)
  return typeof row?.value === "string" ? row.value : ""
}

async function pushAll(): Promise<{ serverTime: string; complete: boolean }> {
  let serverTime = ""
  for (;;) {
    const entries = await db.entries.where("dirty").equals(1).limit(BATCH).toArray()
    const tags = await db.tags.where("dirty").equals(1).limit(BATCH).toArray()
    const mediaMeta = await db.media.where("dirty").equals(1).limit(BATCH).toArray()
    if (!entries.length && !tags.length && !mediaMeta.length) return { serverTime, complete: true }

    const uploadFailed = new Set<string>()
    for (const media of mediaMeta) {
      if (media.blob.size === 0) continue
      try {
        await uploadMedia(media.id, media.blob, {
          thumb: media.thumbBlob,
          entryId: media.entryId || undefined,
          sortOrder: media.sortOrder,
          width: media.width,
          height: media.height,
        })
      } catch (error) {
        uploadFailed.add(media.id)
        await noteError("media", media.id, (error as Error).message)
      }
    }

    const sendableMedia = mediaMeta.filter((item) => !uploadFailed.has(item.id))
    const result = await pushBatch({
      entries: entries.map(toWireEntry),
      tags: tags.map(toWireTag),
      mediaMeta: sendableMedia.map(toWireMediaMetaPush),
    })
    serverTime = result.serverTime
    await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
      for (const item of result.entries) {
        if (item.status === "applied") await db.entries.update(item.id, { dirty: 0 })
        else if (item.status === "error") await noteError("entry", item.id, item.message)
      }
      for (const item of result.tags) if (item.status === "applied") await db.tags.update(item.id, { dirty: 0 })
      for (const item of result.mediaMeta) if (item.status === "applied") await db.media.update(item.id, { dirty: 0 })
    })
    const progressed = result.entries.some((item) => item.status === "applied") || result.tags.some((item) => item.status === "applied") || result.mediaMeta.some((item) => item.status === "applied")
    if (!progressed) return { serverTime, complete: false }
  }
}

async function pullAll(since: string): Promise<void> {
  let cursor = since
  for (;;) {
    const result = await pullChanges({ since: cursor, limit: 200 })
    await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
      for (const wire of result.entries) {
        const incoming: Entry = fromWireEntry(wire)
        const local = await db.entries.get(incoming.id)
        if (!local) await db.entries.put({ ...incoming, dirty: 0 })
        else if (local.dirty === 1) await stashConflict(incoming)
        else if (incoming.clientUpdatedAt > local.clientUpdatedAt) await db.entries.put({ ...incoming, dirty: 0 })
      }
      await mergeTags(result.tags)
      await mergeMediaMeta(result.mediaMeta)
    })
    cursor = result.serverTime
    if (!result.hasMore) break
  }
  await db.meta.put({ key: "lastSyncAt", value: cursor })
}

export async function runSync(): Promise<void> {
  if (running || !(await meta("ownerUserId"))) return
  running = true
  try {
    const pushed = await pushAll()
    if (!pushed.complete) return
    const since = await meta("lastSyncAt")
    if (!since) {
      if (!pushed.serverTime) return
      await db.meta.put({ key: "lastSyncAt", value: pushed.serverTime })
      return
    }
    await pullAll(since)
  } finally {
    running = false
  }
}

async function noteError(kind: string, id: string, message?: string): Promise<void> {
  const row = await db.meta.get("syncErrors")
  const list = Array.isArray(row?.value) ? (row.value as Array<Record<string, unknown>>) : []
  const hit = list.find((item) => item.id === id)
  const count = typeof hit?.count === "number" ? hit.count + 1 : 1
  const next = list.filter((item) => item.id !== id)
  if (count <= MAX_ERRORS) next.push({ kind, id, message, count, at: utcNow() })
  await db.meta.put({ key: "syncErrors", value: next })
}

async function stashConflict(incoming: Entry): Promise<void> {
  const row = await db.meta.get("conflicts")
  const list = Array.isArray(row?.value) ? (row.value as unknown[]) : []
  list.push({ at: utcNow(), server: incoming })
  await db.meta.put({ key: "conflicts", value: list.slice(-100) })
}

async function mergeTags(rows: WireTag[]): Promise<void> {
  for (const wire of rows) {
    if (await db.tags.get(wire.id)) continue
    if (await db.tags.where("name").equals(wire.name).first()) continue
    await db.tags.put(fromWireTag(wire))
  }
}

async function mergeMediaMeta(rows: WireMediaMeta[]): Promise<void> {
  for (const wire of rows) {
    const patch = mediaPatchFromWire(wire)
    const local = await db.media.get(wire.id)
    if (local) await db.media.update(wire.id, patch)
    else await db.media.put({
      id: wire.id, blob: new Blob([], { type: wire.mime }), thumbBlob: null,
      mime: wire.mime, width: wire.width, height: wire.height, size: wire.size,
      createdAt: wire.created_at, dirty: 0, orphanedAt: null, ...patch,
    })
  }
}
