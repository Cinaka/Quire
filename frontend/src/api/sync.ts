import { pullChanges, pushBatch, uploadMedia } from "@/api/endpoints"
import {
  fromWireEntry,
  fromWireTag,
  mediaPatchFromWire,
  toWireEntry,
  toWireMediaMetaPush,
  toWireTag,
} from "@/api/mappers"
import type { PushItemResult, WireMediaMeta, WireTag } from "@/api/wire"
import { db } from "@/db/schema"
import { utcNow } from "@/shared/time"
import type { Entry, MediaItem, Tag } from "@/shared/types"

const BATCH = 50
const MAX_ERRORS = 3
const FULL_PULL_CURSOR = "1970-01-01T00:00:00.000Z"
const DUPLICATE_TAG_PREFIX = "duplicate_tag:"
let running = false

interface ConflictRecord {
  entryId: string
  at: string
  local: Entry
  server?: Entry
}

interface ErrorRecord {
  kind: string
  id: string
  message?: string
  count: number
  at: string
  paused: boolean
}

async function meta(key: string): Promise<string> {
  const row = await db.meta.get(key)
  return typeof row?.value === "string" ? row.value : ""
}

async function errorRecords(): Promise<ErrorRecord[]> {
  const row = await db.meta.get("syncErrors")
  return Array.isArray(row?.value) ? (row.value as ErrorRecord[]) : []
}

async function pendingPurgeIds(): Promise<Set<string>> {
  const row = await db.meta.get("pendingPurges")
  return new Set(Array.isArray(row?.value) ? (row.value as string[]) : [])
}

async function clearPendingPurges(ids: Set<string>): Promise<void> {
  if (!ids.size) return
  const current = await pendingPurgeIds()
  for (const id of ids) current.delete(id)
  await db.meta.put({ key: "pendingPurges", value: [...current] })
}

async function blockedIds(): Promise<Record<string, Set<string>>> {
  const blocked: Record<string, Set<string>> = {
    entry: new Set<string>(), tag: new Set<string>(), media: new Set<string>(),
  }
  for (const item of await errorRecords()) {
    if (item.paused && blocked[item.kind]) blocked[item.kind].add(item.id)
  }
  return blocked
}

function sameEntryRevision(current: Entry | undefined, sent: Entry | undefined): boolean {
  return Boolean(current && sent && current.clientUpdatedAt === sent.clientUpdatedAt)
}

function sameTagRevision(current: Tag | undefined, sent: Tag | undefined): boolean {
  return Boolean(
    current && sent
      && current.name === sent.name
      && current.color === sent.color
      && current.createdAt === sent.createdAt,
  )
}

function sameMediaRevision(current: MediaItem | undefined, sent: MediaItem | undefined): boolean {
  return Boolean(
    current && sent
      && current.entryId === sent.entryId
      && current.sortOrder === sent.sortOrder
      && current.width === sent.width
      && current.height === sent.height
      && current.size === sent.size
      && current.mime === sent.mime
      && current.blob.size === sent.blob.size
      && current.blob.type === sent.blob.type
      && current.thumbBlob?.size === sent.thumbBlob?.size
      && current.thumbBlob?.type === sent.thumbBlob?.type,
  )
}

function conflictId(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const row = value as { entryId?: unknown; local?: Entry; server?: Entry }
  if (typeof row.entryId === "string") return row.entryId
  return row.local?.id ?? row.server?.id ?? ""
}

async function stashConflict(local: Entry, server?: Entry): Promise<void> {
  const row = await db.meta.get("conflicts")
  const list = Array.isArray(row?.value) ? (row.value as Array<Record<string, unknown>>) : []
  const old = list.find((item) => conflictId(item) === local.id) as { server?: Entry } | undefined
  const next: ConflictRecord = {
    entryId: local.id, at: utcNow(), local: { ...local, dirty: 0 }, server: server ?? old?.server,
  }
  await db.meta.put({
    key: "conflicts",
    value: [...list.filter((item) => conflictId(item) !== local.id), next].slice(-100),
  })
}

async function attachServerConflict(server: Entry): Promise<void> {
  const row = await db.meta.get("conflicts")
  const list = Array.isArray(row?.value) ? (row.value as Array<Record<string, unknown>>) : []
  const index = list.findIndex((item) => conflictId(item) === server.id)
  if (index < 0) return
  list[index] = { ...list[index], entryId: server.id, server }
  await db.meta.put({ key: "conflicts", value: list })
}

async function pushAll(): Promise<{ serverTime: string; complete: boolean; hadWork: boolean }> {
  let serverTime = ""
  let hadWork = false
  for (;;) {
    const blocked = await blockedIds()
    const [allEntries, allTags, allMedia] = await Promise.all([
      db.entries.where("dirty").equals(1).toArray(),
      db.tags.where("dirty").equals(1).toArray(),
      db.media.where("dirty").equals(1).toArray(),
    ])
    const entries = allEntries.filter((item) => !blocked.entry.has(item.id)).slice(0, BATCH)
    const tags = allTags.filter((item) => !blocked.tag.has(item.id)).slice(0, BATCH)
    const mediaMeta = allMedia.filter((item) => !blocked.media.has(item.id)).slice(0, BATCH)
    if (!entries.length && !tags.length && !mediaMeta.length) {
      return { serverTime, complete: true, hadWork }
    }
    hadWork = true

    const uploadFailed = new Set<string>()
    for (const media of mediaMeta) {
      if (!media.entryId || media.blob.size === 0) continue
      try {
        await uploadMedia(media.id, media.blob, {
          thumb: media.thumbBlob,
          entryId: media.entryId,
          sortOrder: media.sortOrder,
          width: media.width,
          height: media.height,
        })
      } catch (error) {
        uploadFailed.add(media.id)
        await noteError("media", media.id, (error as Error).message)
      }
    }

    const result = await pushBatch({
      entries: entries.map(toWireEntry),
      tags: tags.map(toWireTag),
      mediaMeta: mediaMeta.filter((item) => !uploadFailed.has(item.id)).map(toWireMediaMetaPush),
    })
    serverTime = result.serverTime
    const sentEntries = new Map(entries.map((item) => [item.id, item]))
    const sentTags = new Map(tags.map((item) => [item.id, item]))
    const sentMedia = new Map(mediaMeta.map((item) => [item.id, item]))
    let reconciledDuplicate = false
    let superseded = false

    await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
      const currentPurges = await pendingPurgeIds()
      for (const item of result.entries) {
        const local = await db.entries.get(item.id)
        if (!sameEntryRevision(local, sentEntries.get(item.id))) {
          superseded = true
          continue
        }
        if (item.status === "applied") {
          if (currentPurges.has(item.id) && local?.isDeleted === 1) await db.entries.delete(item.id)
          else await db.entries.update(item.id, { dirty: 0 })
          await clearError("entry", item.id)
        } else if (item.status === "stale") {
          if (local) {
            await stashConflict(local)
            await db.entries.update(item.id, { dirty: 0 })
          }
          await clearPendingPurges(new Set([item.id]))
          await clearError("entry", item.id)
        } else if (item.status === "error") {
          await noteError("entry", item.id, item.message)
        }
      }
      for (const item of result.tags) {
        const local = await db.tags.get(item.id)
        if (!sameTagRevision(local, sentTags.get(item.id))) {
          superseded = true
          continue
        }
        if (item.status === "applied") {
          await db.tags.update(item.id, { dirty: 0 })
          await clearError("tag", item.id)
        } else if (await reconcileDuplicateTag(item)) {
          reconciledDuplicate = true
          await clearError("tag", item.id)
        } else if (item.status === "error") {
          await noteError("tag", item.id, item.message)
        }
      }
      for (const item of result.mediaMeta) {
        const local = await db.media.get(item.id)
        if (!sameMediaRevision(local, sentMedia.get(item.id))) {
          superseded = true
          continue
        }
        if (item.status === "applied") {
          await db.media.update(item.id, { dirty: 0 })
          await clearError("media", item.id)
        } else if (item.status === "error") {
          await noteError("media", item.id, item.message)
        }
      }
    })

    const progressed = superseded || reconciledDuplicate
      || result.entries.some((item) => item.status === "applied" || item.status === "stale")
      || result.tags.some((item) => item.status === "applied")
      || result.mediaMeta.some((item) => item.status === "applied")
    if (!progressed && uploadFailed.size === 0) return { serverTime, complete: false, hadWork }
  }
}

async function reconcileDuplicateTag(item: PushItemResult): Promise<boolean> {
  if (item.status !== "error" || !item.message?.startsWith(DUPLICATE_TAG_PREFIX)) return false
  const canonicalId = item.message.slice(DUPLICATE_TAG_PREFIX.length)
  if (!canonicalId || canonicalId === item.id) return false
  const affected = await db.entries.where("tagIds").equals(item.id).toArray()
  for (const entry of affected) {
    const now = utcNow()
    await db.entries.update(entry.id, {
      tagIds: [...new Set(entry.tagIds.map((id) => (id === item.id ? canonicalId : id)))],
      updatedAt: now, clientUpdatedAt: now, dirty: 1,
    })
  }
  await db.tags.delete(item.id)
  return true
}

async function pullAll(since: string): Promise<void> {
  let cursor = since
  let afterId = ""
  const purges = await pendingPurgeIds()
  for (;;) {
    const result = await pullChanges({ since: cursor, afterId: afterId || undefined, limit: 200 })
    await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
      for (const wire of result.entries) {
        if (purges.has(wire.id)) continue
        const incoming: Entry = fromWireEntry(wire)
        const local = await db.entries.get(incoming.id)
        if (!local) {
          await db.entries.put({ ...incoming, dirty: 0 })
          continue
        }
        if (local.dirty === 1) {
          if (incoming.clientUpdatedAt > local.clientUpdatedAt) {
            await stashConflict(local, incoming)
            await db.entries.put({ ...incoming, dirty: 0 })
          }
          continue
        }
        await attachServerConflict(incoming)
        if (incoming.clientUpdatedAt > local.clientUpdatedAt) {
          if (incoming.isDeleted === 0) await stashConflict(local, incoming)
          await db.entries.put({ ...incoming, dirty: 0 })
        }
      }
      await mergeTags(result.tags)
      await mergeMediaMeta(result.mediaMeta)
    })
    cursor = result.serverTime
    afterId = result.cursorId
    if (!result.hasMore) break
  }
  await db.meta.put({ key: "lastSyncAt", value: cursor })
  await clearPendingPurges(purges)
}

export async function runSync(): Promise<void> {
  if (running || !(await meta("ownerUserId"))) return
  running = true
  try {
    const pushed = await pushAll()
    if (!pushed.complete) return
    const since = await meta("lastSyncAt")
    if (!since) {
      if (pushed.hadWork) {
        await db.meta.put({ key: "lastSyncAt", value: FULL_PULL_CURSOR })
        return
      }
      await pullAll(FULL_PULL_CURSOR)
      return
    }
    await pullAll(since)
  } finally {
    running = false
  }
}

async function noteError(kind: string, id: string, message?: string): Promise<void> {
  const list = await errorRecords()
  const hit = list.find((item) => item.kind === kind && item.id === id)
  const count = (hit?.count ?? 0) + 1
  const next = list.filter((item) => item.kind !== kind || item.id !== id)
  next.push({ kind, id, message, count, at: utcNow(), paused: count >= MAX_ERRORS })
  await db.meta.put({ key: "syncErrors", value: next })
}

async function clearError(kind: string, id: string): Promise<void> {
  const list = await errorRecords()
  const next = list.filter((item) => item.kind !== kind || item.id !== id)
  if (next.length !== list.length) await db.meta.put({ key: "syncErrors", value: next })
}

async function mergeTags(rows: WireTag[]): Promise<void> {
  for (const wire of rows) {
    const incoming = fromWireTag(wire)
    const local = await db.tags.get(wire.id)
    if (local) {
      if (local.dirty === 0) await db.tags.put(incoming)
      continue
    }
    if (await db.tags.where("name").equals(wire.name).first()) continue
    await db.tags.put(incoming)
  }
}

async function mergeMediaMeta(rows: WireMediaMeta[]): Promise<void> {
  for (const wire of rows) {
    const patch = mediaPatchFromWire(wire)
    const local = await db.media.get(wire.id)
    if (local) {
      if (local.dirty === 1) {
        await db.media.update(wire.id, {
          remoteUrl: patch.remoteUrl,
          thumbRemoteUrl: patch.thumbRemoteUrl,
        })
      } else {
        await db.media.update(wire.id, patch)
      }
    } else {
      await db.media.put({
        id: wire.id,
        blob: new Blob([], { type: wire.mime }),
        thumbBlob: null,
        mime: wire.mime,
        width: wire.width,
        height: wire.height,
        size: wire.size,
        createdAt: wire.created_at,
        dirty: 0,
        orphanedAt: null,
        ...patch,
      })
    }
  }
}
