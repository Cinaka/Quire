// src/api/mappers.ts（新建）—— camelCase ↔ snake_case 的唯一转换层。
// 第三节定的规矩：转换只能出现在这一个文件里。
import type { Entry, EntryContent, MediaItem, Tag } from "@/shared/types"
import type { WireEntry, WireMediaMeta, WireMediaMetaPush, WireTag } from "./wire"

/** 库里存相对路径，拼接只在这一处。换域名 / 上 CDN / 迁 OSS 都只改这里。 */
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
    // 第四节：上行只传 deletedAt，isDeleted 是本地专有字段，两个都传就会不一致。
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
    // 下行时反推：deleted_at 非空即已删（铁律 4：索引用 0/1）。
    isDeleted: w.deleted_at ? 1 : 0,
    serverUpdatedAt: w.updated_at ?? "",
    dirty: 0,
  }
}

export function fromWireTag(w: WireTag): Tag {
  return { id: w.id, name: w.name, color: w.color, createdAt: w.created_at, dirty: 0 }
}

/** 上行标签。只有 createdAt → created_at 一处差异，但差这一处就编译不过。 */
export function toWireTag(t: Tag): WireTag {
  return { id: t.id, name: t.name, color: t.color, created_at: t.createdAt }
}

/**
 * 上行图片元数据。三条硬规则，一条都不能省：
 *
 * 1. 不带 url / thumb_url —— 见 wire.ts 里 WireMediaMetaPush 的注释。
 * 2. 不带 blob / thumbBlob —— JSON.stringify(blob) 得到 {}，且不报任何错。
 *    裸传的后果是把整张原图变成一个空对象发上去，服务端存下一条 0 字节的图，
 *    而本地看起来一切正常（本地读的是 blob 字段）。这是最难发现的一种。
 * 3. 逐字段列出，不用 { ...m } 展开 —— 展开会把上面两样一起带走。
 *    以后给 MediaItem 加字段时，这里不动就自动不上行，这是想要的默认行为。
 */
export function toWireMediaMetaPush(m: MediaItem): WireMediaMetaPush {
  return {
    id: m.id,
    entry_id: m.entryId,
    sort_order: m.sortOrder,
    width: m.width,
    height: m.height,
    size: m.size,
    mime: m.mime,
    created_at: m.createdAt,
  }
}

/** 只给 mergeMediaMeta 用的元数据补丁，不包含任何 Blob。 */
export function mediaPatchFromWire(
  w: WireMediaMeta,
): Pick<MediaItem, "entryId" | "sortOrder" | "remoteUrl"> & { thumbRemoteUrl: string } {
  return {
    entryId: w.entry_id,
    sortOrder: w.sort_order,
    remoteUrl: mediaUrl(w.url),
    thumbRemoteUrl: mediaUrl(w.thumb_url),
  }
}
