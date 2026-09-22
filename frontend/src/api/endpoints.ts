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
  cursor_id: string | null
  has_more: boolean
  entries: WireEntry[]
  tags: WireTag[]
  media_meta: WireMediaMeta[]
}

export async function pushBatch(body: PushBody): Promise<PushResult> {
  const d = await post<RawPush>("/sync/push", {
    entries: body.entries,
    tags: body.tags,
    media_meta: body.mediaMeta,
  })
  return {
    serverTime: d.server_time,
    entries: d.entries ?? [],
    tags: d.tags ?? [],
    mediaMeta: d.media_meta ?? [],
  }
}

export async function pullChanges(params: {
  since: string
  afterId?: string
  limit: number
}): Promise<PullResult> {
  const d = await get<RawPull>("/sync/changes", {
    since: params.since,
    after_id: params.afterId || undefined,
    limit: params.limit,
  })
  return {
    serverTime: d.server_time,
    cursorId: d.cursor_id ?? "",
    hasMore: Boolean(d.has_more),
    entries: d.entries ?? [],
    tags: d.tags ?? [],
    mediaMeta: d.media_meta ?? [],
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
): Promise<unknown> {
  const body = new FormData()
  body.append("file", file, `${id}.${file.type.split("/")[1] || "bin"}`)
  if (options.thumb) body.append("thumb", options.thumb, `${id}_thumb.webp`)
  if (options.entryId) body.append("entry_id", options.entryId)
  body.append("sort_order", String(options.sortOrder ?? 0))
  if (options.width != null) body.append("width", String(options.width))
  if (options.height != null) body.append("height", String(options.height))
  return post<unknown>(`/media/${id}`, body)
}

export async function listMedia(entryId?: string): Promise<unknown[]> {
  return get<unknown[]>("/media", entryId ? { entry_id: entryId } : undefined)
}

export async function putEntry(id: string, body: WireEntry): Promise<unknown> {
  return put(`/entries/${id}`, body)
}

export async function deleteEntry(id: string, clientUpdatedAt: string): Promise<unknown> {
  return del(`/entries/${id}`, { client_updated_at: clientUpdatedAt })
}
