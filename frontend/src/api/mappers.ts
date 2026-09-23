import type { Entry, EntryContent, MediaItem, Tag } from "@/shared/types"
import type { WireEntry, WireMediaMeta, WireMediaMetaPush, WireTag } from "./wire"

export function mediaUrl(path: string): string {
  if (!path) return ""
  if (path.startsWith("http://") || path.startsWith("https://")) return path
  return `${import.meta.env.VITE_MEDIA_BASE_URL ?? ""}${path}`
}

export function toWireEntry(e: Entry): WireEntry {
  return {
    id: e.id,
    entry_date: e.entryDate,
    sort_order: e.sortOrder,
    title: e.title,
    content: e.content,
    content_text: e.contentText,
    mood: e.mood,
    weather: e.weather,
    tag_ids: e.tagIds,
    from_schedule_id: e.fromScheduleId,
    client_updated_at: e.clientUpdatedAt,
    deleted_at: e.deletedAt,
  }
}

export function fromWireEntry(w: WireEntry): Entry {
  return {
    id: w.id,
    entryDate: w.entry_date,
    sortOrder: w.sort_order,
    title: w.title,
    content: (w.content as EntryContent | null) ?? null,
    contentText: w.content_text ?? "",
    mood: w.mood,
    weather: w.weather,
    tagIds: w.tag_ids ?? [],
    fromScheduleId: w.from_schedule_id,
    createdAt: w.client_updated_at,
    updatedAt: w.client_updated_at,
    clientUpdatedAt: w.client_updated_at,
    deletedAt: w.deleted_at,
    isDeleted: w.deleted_at ? 1 : 0,
    serverUpdatedAt: w.updated_at ?? "",
    dirty: 0,
  }
}

export function fromWireTag(w: WireTag): Tag {
  return { id: w.id, name: w.name, color: w.color, createdAt: w.created_at, dirty: 0 }
}

export function toWireTag(t: Tag): WireTag {
  return { id: t.id, name: t.name, color: t.color, created_at: t.createdAt }
}

export function toWireMediaMetaPush(m: MediaItem): WireMediaMetaPush {
  return {
    id: m.id,
    entry_id: m.entryId || null,
    sort_order: m.sortOrder,
    width: m.width,
    height: m.height,
    size: m.size,
    mime: m.mime,
    created_at: m.createdAt,
  }
}

export function mediaPatchFromWire(
  w: WireMediaMeta,
): Pick<MediaItem, "entryId" | "sortOrder" | "remoteUrl"> & { thumbRemoteUrl: string } {
  return {
    entryId: w.entry_id ?? "",
    sortOrder: w.sort_order,
    remoteUrl: mediaUrl(w.url),
    thumbRemoteUrl: mediaUrl(w.thumb_url),
  }
}
