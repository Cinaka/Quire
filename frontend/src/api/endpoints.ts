import { localUuidHex, normalizeUuidList, uuidToHex } from "@/shared/uuidHex"
import { assertEntryPush, assertMediaPush, assertTagPush, entryWire, mediaWire,
  pushAcks, tagWire, uniqueWireRows } from "./uuidWire"
import { del, get, post, put } from "./request"
import type {
  PullResult,
  PushItemResult,
  PushResult,
  WireEntry,
  WireMediaMeta,
  WireMediaMetaPush,
  WireTag,
} from "./wire"

interface PushBody {
  entries: WireEntry[]
  tags: WireTag[]
  mediaMeta: WireMediaMetaPush[]
}

interface RawPush {
  server_time: string
  entries: PushItemResult[]
  tags: PushItemResult[]
  media_meta: PushItemResult[]
}

interface RawPull {
  server_time: string
  sync_until: string
  cursor_id: string | null
  has_more: boolean
  entries: WireEntry[]
  tags: WireTag[]
  media_meta: WireMediaMeta[]
}

export async function pushBatch(body: PushBody, syncOwner?: string): Promise<PushResult> {
  body.entries.forEach(assertEntryPush)
  body.tags.forEach(assertTagPush)
  body.mediaMeta.forEach(assertMediaPush)
  for (const rows of [body.entries, body.tags, body.mediaMeta]) normalizeUuidList(rows.map(row => row.id), true)
  const d = await post<RawPush>("/sync/push", {
    entries: body.entries,
    tags: body.tags,
    media_meta: body.mediaMeta,
  }, syncOwner)
  return {
    serverTime: d.server_time,
    entries: pushAcks(d.entries, body.entries),
    tags: pushAcks(d.tags, body.tags),
    mediaMeta: pushAcks(d.media_meta, body.mediaMeta),
  }
}

export async function pullChanges(params: {
  since: string
  afterId?: string
  until?: string
  limit: number
}, syncOwner?: string): Promise<PullResult> {
  const d = await get<RawPull>("/sync/changes", {
    since: params.since,
    after_id: params.afterId ? uuidToHex(params.afterId, true) : undefined,
    until: params.until || undefined,
    limit: params.limit,
  }, syncOwner)
  if (typeof d.has_more !== "boolean" || typeof d.server_time !== "string" ||
      typeof d.sync_until !== "string") throw new Error("同步分页响应无效")
  const cursorId = d.cursor_id === null ? "" : uuidToHex(d.cursor_id, true)
  if (d.has_more && !cursorId) throw new Error("同步续页身份缺失")
  return {
    serverTime: d.server_time,
    syncUntil: d.sync_until,
    cursorId,
    hasMore: d.has_more,
    entries: uniqueWireRows(d.entries, entryWire),
    tags: uniqueWireRows(d.tags, tagWire),
    mediaMeta: uniqueWireRows(d.media_meta, mediaWire),
  }
}

export async function uploadMedia(
  id: string,
  file: Blob,
  options: {
    thumb?: Blob | null
    entryId?: string
    sortOrder?: number
    width?: number | null
    height?: number | null
  } = {},
  syncOwner?: string,
): Promise<unknown> {
  id = localUuidHex(id)
  if (options.entryId) localUuidHex(options.entryId)
  const body = new FormData()
  body.append("file", file, `${id}.${file.type.split("/")[1] || "bin"}`)
  if (options.thumb) body.append("thumb", options.thumb, `${id}_thumb.webp`)
  if (options.entryId) body.append("entry_id", options.entryId)
  body.append("sort_order", String(options.sortOrder ?? 0))
  if (options.width != null) body.append("width", String(options.width))
  if (options.height != null) body.append("height", String(options.height))
  const response = mediaWire(await post<unknown>(`/media/${id}`, body, syncOwner))
  if (response.id !== id) throw new Error("上传回执不属于本图片，未确认上传")
  return response
}

export async function listMedia(entryId?: string): Promise<unknown[]> {
  return uniqueWireRows(await get<unknown[]>("/media",
    entryId ? { entry_id: uuidToHex(entryId, true) } : undefined), mediaWire)
}

export async function putEntry(id: string, body: WireEntry): Promise<unknown> {
  id = localUuidHex(id)
  assertEntryPush(body)
  if (body.id !== id) throw new Error("日记路径与正文身份不一致")
  return put(`/entries/${id}`, body)
}

export async function deleteEntry(id: string, clientUpdatedAt: string): Promise<unknown> {
  return del(`/entries/${localUuidHex(id)}`, { client_updated_at: clientUpdatedAt })
}
