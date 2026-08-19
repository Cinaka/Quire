/** ISO 8601 UTC 时间戳，例如 "2026-08-19T08:21:34.123Z"。永远是 UTC，永远带 Z。 */
export type Iso = string

/** 本地日历日，例如 "2026-08-19"。不含时区信息，回答的是"这篇算哪一天的"。 */
export type LocalDate = string

export interface TiptapDoc {
  type: "doc"
  content?: unknown[]
}

/** 正文包装一层，带上 schemaVersion，将来编辑器节点结构变更时可以做迁移。 */
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
  /** 由 content 派生的纯文本，唯一用途是搜索。必须与 content 同一次写入。 */
  contentText: string
  mood: string | null
  weather: string | null
  /** 本地不拆中间表，直接存数组，靠 Dexie 的 multiEntry 索引查询。 */
  tagIds: string[]
  fromScheduleId: string | null
  createdAt: Iso
  updatedAt: Iso
  clientUpdatedAt: Iso
  deletedAt: Iso | null
  /** 0 或 1。IndexedDB 不索引 null，所以软删除标记必须单独用数字字段。 */
  isDeleted: 0 | 1
  /** 0 或 1。P1 恒为 1；P2 同步成功后置 0，用来找出待上传的记录。 */
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
  /** 空字符串表示还没关联到任何日记（用户刚贴图、还没保存）。 */
  entryId: string
  blob: Blob
  thumbBlob: Blob | null
  mime: string
  width: number | null
  height: number | null
  size: number
  sortOrder: number
  /** 空字符串表示还没上云。P2 上传成功后填 CDN 地址。 */
  remoteUrl: string
  createdAt: Iso
  dirty: 0 | 1
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
  tagId?: string
  dateFrom?: LocalDate
  dateTo?: LocalDate
  /** true 时只返回回收站内容 */
  onlyDeleted?: boolean
  order?: EntryOrder
}

/** 列表项不带 content，避免把大段 JSON 搬进内存。 */
export type EntryListItem = Omit<Entry, "content">

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
