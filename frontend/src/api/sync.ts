// src/api/sync.ts —— 唯一的同步入口。上层只调 runSync()，不碰内部函数。
import { db } from "@/db/schema"
import { pullChanges, pushBatch } from "@/api/endpoints"
import {
  fromWireEntry,
  fromWireTag,
  mediaPatchFromWire,
  toWireEntry,
  toWireMediaMetaPush,
  toWireTag,
} from "@/api/mappers"
import type { WireMediaMeta, WireTag } from "@/api/wire"
import { utcNow } from "@/shared/time"
import type { Entry } from "@/shared/types"

const BATCH = 50
const MAX_ERRORS = 3

let running = false

async function meta(key: string): Promise<string> {
  const row = await db.meta.get(key)
  return typeof row?.value === "string" ? row.value : ""
}

/** 上行：把所有 dirty=1 的记录分批推上去。返回服务端时间。 */
async function pushAll(): Promise<string> {
  let serverTime = ""
  for (;;) {
    const entries = await db.entries.where("dirty").equals(1).limit(BATCH).toArray()
    const tags = await db.tags.where("dirty").equals(1).limit(BATCH).toArray()
    const mediaMeta = await db.media.where("dirty").equals(1).limit(BATCH).toArray()
    if (!entries.length && !tags.length && !mediaMeta.length) break

    // 三类都要过映射层。裸传本地行会撞两件事：字段名是 camel 的（Tag.createdAt
    // 对不上 created_at），以及 MediaItem 里带 blob / thumbBlob。
    const res = await pushBatch({
      entries: entries.map(toWireEntry),
      tags: tags.map(toWireTag),
      mediaMeta: mediaMeta.map(toWireMediaMetaPush),
    })
    serverTime = res.serverTime

    // 逐条处理：只有 applied 才清 dirty。stale 留给随后的 pull 仲裁。
    await db.transaction("rw", db.entries, db.tags, db.media, async () => {
      for (const r of res.entries) {
        if (r.status === "applied") await db.entries.update(r.id, { dirty: 0 })
        else if (r.status === "error") await noteError("entry", r.id, r.message)
      }
      for (const r of res.tags) {
        if (r.status === "applied") await db.tags.update(r.id, { dirty: 0 })
      }
      for (const r of res.mediaMeta) {
        if (r.status === "applied") await db.media.update(r.id, { dirty: 0 })
      }
    })

    // 全批都不是 applied 说明没有推进，跳出避免死循环。
    // 必须三类一起看：只看 entries 的话，「只有标签脏了」的那一轮会被误判成没推进。
    const progressed =
      res.entries.some((r) => r.status === "applied") ||
      res.tags.some((r) => r.status === "applied") ||
      res.mediaMeta.some((r) => r.status === "applied")
    if (!progressed) break
  }
  return serverTime
}

/** 下行：拉增量。dirty=1 的本地记录一律不覆盖。 */
async function pullAll(since: string): Promise<string> {
  let cursor = since
  for (;;) {
    const res = await pullChanges({ since: cursor, limit: 200 })

    await db.transaction("rw", db.entries, db.tags, db.media, db.meta, async () => {
      for (const wire of res.entries) {
        const incoming: Entry = fromWireEntry(wire)
        const local = await db.entries.get(incoming.id)

        if (!local) {
          await db.entries.put({ ...incoming, dirty: 0 })
          continue
        }
        // 规则 3：本地有未同步改动，服务端版本只进冲突缓冲。
        if (local.dirty === 1) {
          await stashConflict(incoming)
          continue
        }
        // 规则 1 与 2：client_updated_at 大的赢；相等则本地赢（不写）。
        if (incoming.clientUpdatedAt > local.clientUpdatedAt) {
          await db.entries.put({ ...incoming, dirty: 0 })
        }
      }
      // tags 只新增不删；media 只更新元数据与 remoteUrl，Blob 永不被下行覆盖。
      await mergeTags(res.tags)
      await mergeMediaMeta(res.mediaMeta)
    })

    cursor = res.serverTime
    if (!res.hasMore) break
  }
  await db.meta.put({ key: "lastSyncAt", value: cursor })
  return cursor
}

export async function runSync(): Promise<void> {
  if (running) return
  if (!(await meta("ownerUserId"))) return // 游客态不同步
  running = true
  try {
    const serverTime = await pushAll()
    const since = await meta("lastSyncAt")

    // 硬约束第 1 条：bootstrap（lastSyncAt 为空）这一轮只 push。
    // 游标先写成本次 push 的服务端时间，下一轮才开始 pull。
    if (!since) {
      await db.meta.put({ key: "lastSyncAt", value: serverTime || utcNow() })
      return
    }
    await pullAll(since)
  } finally {
    running = false
  }
}

async function noteError(kind: string, id: string, message?: string): Promise<void> {
  const row = await db.meta.get("syncErrors")
  const list = Array.isArray(row?.value) ? (row.value as Array<Record<string, unknown>>) : []
  const hit = list.find((x) => x.id === id)
  const count = typeof hit?.count === "number" ? hit.count + 1 : 1
  const next = list.filter((x) => x.id !== id)
  if (count <= MAX_ERRORS) next.push({ kind, id, message, count, at: utcNow() })
  await db.meta.put({ key: "syncErrors", value: next })
}

async function stashConflict(incoming: Entry): Promise<void> {
  const row = await db.meta.get("conflicts")
  const list = Array.isArray(row?.value) ? (row.value as unknown[]) : []
  list.push({ at: utcNow(), server: incoming })
  await db.meta.put({ key: "conflicts", value: list.slice(-100) })
}

/**
 * 标签：只新增，永不删、永不改名（《数据模型字段详解》第四节）。
 * 所以同 id 就是同一条，不需要比时间、也不需要 update。
 */
async function mergeTags(rows: WireTag[]): Promise<void> {
  for (const w of rows) {
    if (await db.tags.get(w.id)) continue
    // 同名不同 id：不在下行里处理。它由 push 的 409 分支做归并（第三节 4 小节），
    // 因为只有那里才知道要把本地哪些 entry 的 tagIds 改指向。
    if (await db.tags.where("name").equals(w.name).first()) continue
    await db.tags.put(fromWireTag(w))
  }
}

/**
 * 图片：只写元数据与远端地址，blob / thumbBlob 一个字节都不动。
 * 下行覆盖本地 Blob 等于用网络图换掉原图，既慢又可能降质。
 */
async function mergeMediaMeta(rows: WireMediaMeta[]): Promise<void> {
  for (const w of rows) {
    const patch = mediaPatchFromWire(w)
    const local = await db.media.get(w.id)
    if (local) {
      await db.media.update(w.id, patch)
      continue
    }
    // 本地没有这张（新设备）：先只落元数据占位，真正的 Blob 由
    // LocalImageView 的三级回退按需回填（第五节）。0 字节 = 尚未回填。
    await db.media.put({
      id: w.id,
      blob: new Blob([], { type: w.mime }),
      thumbBlob: null,
      mime: w.mime,
      width: w.width,
      height: w.height,
      size: w.size,
      createdAt: w.created_at,
      dirty: 0,
      ...patch,
    })
  }
}
