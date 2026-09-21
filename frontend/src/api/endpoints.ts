// src/api/endpoints.ts（新建）—— 每个函数只干一件事：发请求、把壳子转成 camel。
// 业务判断全部在 sync.ts，这里不写任何 if。
import { get, post } from "./request"
import type {
  PullResult,
  PushItemResult,
  PushResult,
  WireEntry,
  WireMediaMeta,
  WireMediaMetaPush,
  WireTag,
} from "./wire"

// 上行与下行的图片形状不同：上行没有 url / thumb_url（服务端才知道），
// 下行有。用同一个类型糊过去，就等于逼前端造假地址。
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

export async function pullChanges(params: { since: string; limit: number }): Promise<PullResult> {
  const d = await get<RawPull>("/sync/changes", params)
  return {
    serverTime: d.server_time,
    hasMore: Boolean(d.has_more),
    entries: d.entries ?? [],
    tags: d.tags ?? [],
    mediaMeta: d.media_meta ?? [],
  }
}
