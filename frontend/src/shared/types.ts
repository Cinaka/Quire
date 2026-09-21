/** ISO 8601 UTC 时间戳，例如 "2026-08-19T08:21:34.123Z"。永远是 UTC，永远带 Z。 */
export type Iso = string

/** 本地日历日，例如 "2026-08-19"。 */
export type LocalDate = string

export interface TiptapDoc {
  type: "doc"
  content?: unknown[]
}

export interface EntryContent {
  schemaVersion: number
  doc: TiptapDoc
}

export const CONTENT_SCHEMA_VERSION = 1

export interface Entry {
  id: string
  entryDate: LocalDate
  sortOrder: number
  title: string
  content: EntryContent | null
  contentText: string
  mood: string | null
  weather: string | null
  tagIds: string[]
  fromScheduleId: string | null
  createdAt: Iso
  updatedAt: Iso
  clientUpdatedAt: Iso
  serverUpdatedAt: Iso | ""
  deletedAt: Iso | null
  isDeleted: 0 | 1
  dirty: 0 | 1
}

export interface Tag {
  id: string
  name: string
  color: string | null
  createdAt: Iso
  dirty: 0 | 1
}

export interface MediaItem {
  id: string
  entryId: string
  blob: Blob
  thumbBlob: Blob | null
  mime: string
  width: number | null
  height: number | null
  size: number
  sortOrder: number
  remoteUrl: string
  /** 旧行与尚未上云的新行允许暂缺；Dexie v2 upgrade 会统一补成空串。 */
  thumbRemoteUrl?: string
  createdAt: Iso
  dirty: 0 | 1
  orphanedAt?: Iso | null
}

export interface EntryCreateDto {
  entryDate?: LocalDate
  title?: string
  content?: EntryContent | null
  mood?: string | null
  weather?: string | null
  tagIds?: string[]
  fromScheduleId?: string | null
}

export type EntryUpdateDto = Omit<EntryCreateDto, "fromScheduleId">
export type EntryOrder = "entryDateDesc" | "entryDateAsc" | "updatedAtDesc"

export interface EntryListParams {
  page?: number
  pageSize?: number
  keyword?: string
  tagIds?: string[]
  dateFrom?: LocalDate
  dateTo?: LocalDate
  hasImage?: boolean
  onlyDeleted?: boolean
  order?: EntryOrder
}

export type EntryListItem = Omit<Entry, "content">

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface LocalStats {
  entries: number
  deleted: number
  tags: number
  media: number
  mediaBytes: number
}
