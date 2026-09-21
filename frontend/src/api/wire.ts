// src/api/wire.ts（新建）—— 线上形状，snake_case。只有 src/api/ 能看见这些类型。
export interface WireEntry {
  id: string
  entry_date: string
  sort_order: number
  title: string
  content: unknown | null
  content_text: string
  mood: string | null
  weather: string | null
  tag_ids: string[]
  from_schedule_id: string | null
  client_updated_at: string
  deleted_at: string | null
  /** 服务端写的，只下行、不上行；不参与仲裁，只用于排查。 */
  updated_at?: string
}

export interface WireTag {
  id: string
  name: string
  color: string | null
  created_at: string
}

export interface WireMediaMeta {
  id: string
  entry_id: string
  sort_order: number
  width: number | null
  height: number | null
  size: number
  mime: string
  /** 相对路径，如 /media/2026/09/{id}.jpg（第五节：不存绑域名的绝对地址）。 */
  url: string
  thumb_url: string
  created_at: string
}

/**
 * 上行专用：没有 url / thumb_url。
 *
 * 这两个地址是服务端落盘之后才存在的，客户端手上只有 local://media/{id}。
 * 让上行也带这两个字段，唯一的结果是前端得凭空造一个假地址，
 * 而 POST /media/{id} 的响应又会把真地址覆盖回来 —— 中间那一段假值
 * 有机会被写进库并进备份，之后再也分不清哪条是真的。
 */
export type WireMediaMetaPush = Omit<WireMediaMeta, "url" | "thumb_url">

export type PushStatus = "applied" | "stale" | "error"

export interface PushItemResult {
  id: string
  status: PushStatus
  message?: string
  server_client_updated_at?: string
}

/** 壳子已在 endpoints.ts 里转成 camelCase，所以这两个结果类型是 camel 的。 */
export interface PushResult {
  serverTime: string
  entries: PushItemResult[]
  tags: PushItemResult[]
  mediaMeta: PushItemResult[]
}

export interface PullResult {
  serverTime: string
  hasMore: boolean
  entries: WireEntry[]
  tags: WireTag[]
  mediaMeta: WireMediaMeta[]
}
