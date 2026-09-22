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
  url: string
  thumb_url: string
  created_at: string
}

export type WireMediaMetaPush = Omit<WireMediaMeta, "url" | "thumb_url">
export type PushStatus = "applied" | "stale" | "error"

export interface PushItemResult {
  id: string
  status: PushStatus
  message?: string
  server_client_updated_at?: string
}

export interface PushResult {
  serverTime: string
  entries: PushItemResult[]
  tags: PushItemResult[]
  mediaMeta: PushItemResult[]
}

export interface PullResult {
  serverTime: string
  cursorId: string
  hasMore: boolean
  entries: WireEntry[]
  tags: WireTag[]
  mediaMeta: WireMediaMeta[]
}
