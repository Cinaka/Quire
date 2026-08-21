import { db } from "./schema"
import { LOCAL_MEDIA_PREFIX } from "@/shared/text"
import {
  BACKUP_FORMAT_VERSION,
  checkBackup,
  contentTooNew,
  type BackupFile,
  type BackupMedia,
  type ImportConflict,
} from "@/shared/backup"
import { newId } from "@/shared/ids"
import { utcNow } from "@/shared/time"
import {
  CONTENT_SCHEMA_VERSION,
  type Entry,
  type MediaItem,
  type Tag,
} from "@/shared/types"

export interface ImportReport {
  entriesAdded: number
  entriesUpdated: number
  entriesSkipped: number
  /** 正文 schemaVersion 比本机新，只能跳过 */
  entriesTooNew: number
  tagsAdded: number
  tagsMerged: number
  mediaAdded: number
  mediaSkipped: number
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"))
    reader.onload = () => {
      // readAsDataURL 给的是 "data:image/png;base64,xxxx"，只留逗号后面那截
      const s = String(reader.result)
      resolve(s.slice(s.indexOf(",") + 1))
    }
    reader.readAsDataURL(blob)
  })
}

async function base64ToBlob(b64: string, mime: string): Promise<Blob> {
  // 走 fetch 解 data URL，比手写 atob + Uint8Array 少一层出错空间，
  // 也不会在大图上把主线程卡住那么久。
  const res = await fetch(`data:${mime || "application/octet-stream"};base64,${b64}`)
  return res.blob()
}

/** 正文里的图片引用是 local://media/{id}，改 id 就必须同步改正文。 */
function remapMediaRefs(content: Entry["content"], map: Map<string, string>): Entry["content"] {
  if (!content || map.size === 0) return content

  let json = JSON.stringify(content)
  for (const [from, to] of map) {
    json = json.split(`${LOCAL_MEDIA_PREFIX}${from}`).join(`${LOCAL_MEDIA_PREFIX}${to}`)
  }
  return JSON.parse(json) as Entry["content"]
}

export const localBackupRepo = {
  /**
   * 全量导出。
   *
   * media 逐条读、逐条编码，而不是一次 toArray()：
   * 后者会把所有原图同时握在内存里，几百张图直接把标签页搞崩。
   * base64 本身还有 4/3 的膨胀，两处叠加就是灾难。
   */
  async exportAll(onProgress?: (done: number, total: number) => void): Promise<BackupFile> {
    const [entries, tags, mediaIds] = await Promise.all([
      db.entries.toArray(),
      db.tags.toArray(),
      db.media.orderBy("id").primaryKeys(),
    ])

    const media: BackupMedia[] = []
    for (let i = 0; i < mediaIds.length; i++) {
      const m = await db.media.get(mediaIds[i] as string)
      if (!m) continue

      const { blob, thumbBlob, ...rest } = m
      media.push({
        ...rest,
        blobBase64: await blobToBase64(blob),
        thumbBase64: thumbBlob ? await blobToBase64(thumbBlob) : null,
      })
      onProgress?.(i + 1, mediaIds.length)
    }

    return {
      app: "quire",
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: utcNow(),
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      counts: { entries: entries.length, tags: tags.length, media: media.length },
      entries,
      tags,
      media,
    }
  },

  /** 导入。raw 是 JSON.parse 之后的结果，校验在里面做。 */
  async importAll(raw: unknown, conflict: ImportConflict = "preferNewer"): Promise<ImportReport> {
    const checked = checkBackup(raw)
    if (!checked.ok) throw new Error(checked.reason)

    const file = checked.file
    const now = utcNow()
    const report: ImportReport = {
      entriesAdded: 0,
      entriesUpdated: 0,
      entriesSkipped: 0,
      entriesTooNew: 0,
      tagsAdded: 0,
      tagsMerged: 0,
      mediaAdded: 0,
      mediaSkipped: 0,
    }

    // ── 第一段：事务外。解码 Blob、算好所有 id 映射 ──────────────

    const decoded: MediaItem[] = []
    const mediaIdMap = new Map<string, string>()

    for (const bm of file.media) {
      const { blobBase64, thumbBase64, ...rest } = bm
      const id = conflict === "asCopy" ? newId() : rest.id
      if (id !== rest.id) mediaIdMap.set(rest.id, id)

      decoded.push({
        ...rest,
        id,
        blob: await base64ToBlob(blobBase64, rest.mime),
        thumbBlob: thumbBase64 ? await base64ToBlob(thumbBase64, rest.mime) : null,
        dirty: 1,
      })
    }

    // 标签按 name 归并，不按 id。同一个「旅行」标签在两台设备上各自新建过，
    // 按 id 导入就会出现两个同名标签，用户看不出区别但筛选结果对不上。
    const localTags = await db.tags.toArray()
    const tagByName = new Map(localTags.map((t) => [t.name.trim().toLowerCase(), t.id]))
    const tagIdMap = new Map<string, string>()
    const tagsToAdd: Tag[] = []

    for (const t of file.tags) {
      const key = t.name.trim().toLowerCase()
      const exist = tagByName.get(key)
      if (exist) {
        if (exist !== t.id) tagIdMap.set(t.id, exist)
        report.tagsMerged += 1
        continue
      }
      const id = conflict === "asCopy" ? newId() : t.id
      if (id !== t.id) tagIdMap.set(t.id, id)
      tagByName.set(key, id)
      tagsToAdd.push({ ...t, id, dirty: 1 })
    }

    const incoming: Entry[] = []
    for (const e of file.entries) {
      if (contentTooNew(e, CONTENT_SCHEMA_VERSION)) {
        report.entriesTooNew += 1
        continue
      }
      incoming.push({
        ...e,
        id: conflict === "asCopy" ? newId() : e.id,
        content: remapMediaRefs(e.content, mediaIdMap),
        tagIds: (e.tagIds ?? []).map((t) => tagIdMap.get(t) ?? t),
        clientUpdatedAt: e.clientUpdatedAt ?? e.updatedAt ?? now,
        dirty: 1,
      })
    }

    // ── 第二段：纯 Dexie 事务。这里面一个非 Dexie 的 await 都不能有 ──

    await db.transaction("rw", db.entries, db.tags, db.media, async () => {
      for (const t of tagsToAdd) {
        await db.tags.put(t)
        report.tagsAdded += 1
      }

      for (const m of decoded) {
        // 图片是内容寻址式的死数据，改不了也不会冲突：同 id 就是同一张
        if (await db.media.get(m.id)) {
          report.mediaSkipped += 1
          continue
        }
        // 关联的日记若被重发了 id，图片的 entryId 也要跟着改
        await db.media.put({ ...m, entryId: m.entryId })
        report.mediaAdded += 1
      }

      for (const e of incoming) {
        const cur = await db.entries.get(e.id)

        if (!cur) {
          await db.entries.put(e)
          report.entriesAdded += 1
          continue
        }

        if (conflict === "keepLocal") {
          report.entriesSkipped += 1
          continue
        }

        // preferNewer：只有备份更新才覆盖。相等时不动，避免把 updatedAt 白刷一遍
        if (e.clientUpdatedAt > cur.clientUpdatedAt) {
          await db.entries.put(e)
          report.entriesUpdated += 1
        } else {
          report.entriesSkipped += 1
        }
      }
    })

    return report
  },
}
