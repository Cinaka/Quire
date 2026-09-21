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
import { normalizeTagName } from "@/shared/tags"
import { utcNow } from "@/shared/time"
import { CONTENT_SCHEMA_VERSION, type Entry, type MediaItem, type Tag } from "@/shared/types"

import { localMediaRepo } from "./mediaRepo"
import { db } from "./schema"

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
    reader.onerror = () => {
      reject(reader.error ?? new Error("读取图片失败"))
    }
    reader.onload = () => {
      // readAsDataURL 给的是 "data:image/png;base64,xxxx"，只保留逗号后面那段。
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

/**
 * 根据图片文件头识别真实 MIME。
 *
 * 主要用于兼容 v1 备份：v1 没有 thumbMime，
 * 因此缩略图不能简单使用原图的 rest.mime。
 */
function detectImageMime(b64: string, fallback: string): string {
  const raw = atob(b64.slice(0, 32))
  const bytes = Array.from(raw, (char) => char.charCodeAt(0))

  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  // PNG
  if (bytes.slice(0, 4).join(",") === "137,80,78,71") {
    return "image/png"
  }
  // GIF
  const head = raw.slice(0, 6)
  if (head === "GIF87a" || head === "GIF89a") {
    return "image/gif"
  }
  // WebP
  if (raw.slice(0, 4) === "RIFF" && raw.slice(8, 12) === "WEBP") {
    return "image/webp"
  }
  return fallback || "application/octet-stream"
}

/** 正文里的图片引用是 local://media/{id}，改 id 就必须同步改正文。 */
function remapMediaRefs(content: Entry["content"], map: Map<string, string>): Entry["content"] {
  if (!content || map.size === 0) {
    return content
  }
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
   *
   * P2-0 之后这里一行不用改：...rest 会自动带上新增的 remoteUrl /
   * thumbRemoteUrl（BackupMedia 是 Omit<MediaItem, "blob" | "thumbBlob"> 的派生），
   * entries 的 serverUpdatedAt 同理。所以 formatVersion 不升（J1）。
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
      if (!m) {
        continue
      }
      const { blob, thumbBlob, ...rest } = m
      media.push({
        ...rest,
        // 原图
        blobBase64: await blobToBase64(blob),
        // 缩略图。同时保存 thumbMime，避免导入时错误使用原图 MIME。
        thumbBase64: thumbBlob ? await blobToBase64(thumbBlob) : null,
        thumbMime: thumbBlob?.type || null,
      })
      onProgress?.(i + 1, mediaIds.length)
    }

    return {
      app: "quire",
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: utcNow(),
      contentSchemaVersion: CONTENT_SCHEMA_VERSION,
      counts: {
        entries: entries.length,
        tags: tags.length,
        media: media.length,
      },
      entries,
      tags,
      media,
    }
  },

  /** 导入。raw 是 JSON.parse 之后的结果，校验在里面做。 */
  async importAll(raw: unknown, conflict: ImportConflict = "preferNewer"): Promise<ImportReport> {
    const checked = checkBackup(raw)
    if (!checked.ok) {
      throw new Error(checked.reason)
    }
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

    // ──────────────────────────────────────────
    // 第一段：事务外。先建立 Entry ID 映射。
    //
    // asCopy 时 Entry 和 Media 必须用同一份 entryIdMap，否则
    //   Entry -> 新 ID，Media -> 原 Entry ID
    // 复制出来的图片会仍然挂在原条目上。
    // ──────────────────────────────────────────
    const entryIdMap = new Map<string, string>()
    for (const entry of file.entries) {
      entryIdMap.set(entry.id, conflict === "asCopy" ? newId() : entry.id)
    }

    // ──────────────────────────────────────────
    // Media ID 映射。asCopy 时图片也必须生成新 id，
    // 同时正文中的 local://media/{id} 要同步替换。
    // ──────────────────────────────────────────
    const mediaIdMap = new Map<string, string>()
    const decoded: MediaItem[] = []

    for (const bm of file.media) {
      const { blobBase64, thumbBase64, thumbMime, ...rest } = bm
      const id = conflict === "asCopy" ? newId() : rest.id
      if (id !== rest.id) {
        mediaIdMap.set(rest.id, id)
      }

      // 原图 MIME 直接用备份里的 mime。
      const blob = await base64ToBlob(blobBase64, rest.mime)

      // 缩略图：新版本优先用 thumbMime；v1 没有它，按文件头识别，
      // 不能直接用 rest.mime。
      const thumbBlob = thumbBase64
        ? await base64ToBlob(
          thumbBase64,
          thumbMime || detectImageMime(thumbBase64, rest.mime),
        )
        : null

      decoded.push({
        ...rest,
        id,
        blob,
        thumbBlob,
        dirty: 1,
        // asCopy 时必须用和 Entry 相同的 entryIdMap，否则
        // 新 Entry -> newEntryId、新 Media -> oldEntryId，
        // 图片仍然挂在原条目上。
        entryId: rest.entryId ? (entryIdMap.get(rest.entryId) ?? rest.entryId) : "",

        // ── P2-0 改动 1/4 ──────────────────────────────────────────────
        // v1 / v2 旧备份没有这两个字段，在这里补空串。不能留 undefined：
        // remoteUrl 在 Dexie version 2 里是索引，undefined 会让整行不进索引，
        // 于是「找出未上云的图」那个查询永远看不见它（铁律 4）。
        //
        // 补在这里而不是事务里的 put()：一是 rest 只在本循环里存在，
        // 二是 decoded 的类型是 MediaItem[]，漏字段会当场编译不过。
        //
        // 导入旧备份后这两个空串的含义是「这张图得重新上传一次」，
        // 下一轮 dirty 上行时会自己补回来——正是想要的语义。
        remoteUrl: rest.remoteUrl ?? "",
        thumbRemoteUrl: rest.thumbRemoteUrl ?? "",
      })
    }

    // ──────────────────────────────────────────
    // 标签按 name 归并，不按 id。
    // 同一个「旅行」标签在两台设备上各自新建过，
    // 按 id 导入就会出现两个同名标签。
    // ──────────────────────────────────────────
    const localTags = await db.tags.toArray()
    const tagByName = new Map(localTags.map((t) => [normalizeTagName(t.name), t.id]))

    const tagIdMap = new Map<string, string>()
    const tagsToAdd: Tag[] = []

    for (const t of file.tags) {
      const key = normalizeTagName(t.name)
      const exist = tagByName.get(key)
      if (exist) {
        if (exist !== t.id) {
          tagIdMap.set(t.id, exist)
        }
        report.tagsMerged += 1
        continue
      }
      const id = conflict === "asCopy" ? newId() : t.id
      if (id !== t.id) {
        tagIdMap.set(t.id, id)
      }
      tagByName.set(key, id)
      tagsToAdd.push({ ...t, id, dirty: 1 })
    }

    // ──────────────────────────────────────────
    // 构造最终 Entry。id 必须从 entryIdMap 取，
    // 不能在这里再 newId()，否则 Media 用的 entryIdMap 又失效。
    // ──────────────────────────────────────────
    const incoming: Entry[] = []
    for (const e of file.entries) {
      if (contentTooNew(e, CONTENT_SCHEMA_VERSION)) {
        report.entriesTooNew += 1
        continue
      }
      incoming.push({
        ...e,
        // asCopy 时用预先建立好的 Entry ID。
        id: entryIdMap.get(e.id) ?? e.id,
        // 正文中的 local://media/{oldId} 同步改成新的 media id。
        content: remapMediaRefs(e.content, mediaIdMap),
        // 标签 ID 用归并后的 ID；多个同名来源标签可能映射到同一 ID，必须去重。
        tagIds: [...new Set((e.tagIds ?? []).map((t) => tagIdMap.get(t) ?? t))],
        clientUpdatedAt: e.clientUpdatedAt ?? e.updatedAt ?? now,

        // ── P2-0 改动 3/4 ──────────────────────────────────────────────
        // 旧备份没有这个字段，补空串。
        //
        // asCopy 必须硬置 ""：副本是一个全新的 id，服务端压根不知道它。
        // 把原条的 serverUpdatedAt 拄过来，之后排查时会看到一个从未同步过
        // 的行冒出一个服务端时间戳，直接把人带错方向。
        //
        // 它不参与任何仲裁（仲裁只看 clientUpdatedAt），所以这里怎么填
        // 都不影响同步正确性，只影响可读性。
        serverUpdatedAt: conflict === "asCopy" ? "" : (e.serverUpdatedAt ?? ""),

        dirty: 1,
      })
    }

    // ──────────────────────────────────────────
    // 第二段：纯 Dexie 事务。里面一个非 Dexie 的 await 都不能有。
    // ──────────────────────────────────────────
    await db.transaction("rw", db.entries, db.tags, db.media, async () => {
      // ── Tags ──
      for (const t of tagsToAdd) {
        await db.tags.put(t)
        report.tagsAdded += 1
      }

      // ── Media ──
      for (const m of decoded) {
        // 图片是内容寻址式的死数据，改不了也不会冲突：同 id 就是同一张。
        if (await db.media.get(m.id)) {
          report.mediaSkipped += 1
          continue
        }
        // ── P2-0 改动 2/4 ────────────────────────────────────────────
        // m 已经是事务外造好的完整 MediaItem（含 entryId 映射、
        // remoteUrl / thumbRemoteUrl 兜底）。这里什么都不要拼：
        // rest / blob / thumbBlob 那三个变量不在本作用域，拉进来就是 TS2304。
        await db.media.put(m)
        report.mediaAdded += 1
      }

      // ── Entries ──
      for (const e of incoming) {
        const cur = await db.entries.get(e.id)
        if (!cur) {
          // 改动 4/4：不动。e 已经是造好的 Entry，含 serverUpdatedAt。
          await db.entries.put(e)
          report.entriesAdded += 1
          continue
        }
        if (conflict === "keepLocal") {
          report.entriesSkipped += 1
          continue
        }
        // preferNewer：只有备份更新才覆盖。相等时不动，避免把 updatedAt 白刷一遍。
        if (e.clientUpdatedAt > cur.clientUpdatedAt) {
          await db.entries.put(e)
          report.entriesUpdated += 1
        } else {
          report.entriesSkipped += 1
        }
      }
    })

    // ──────────────────────────────────────────
    // 第三段：事务外对账。必须在 Dexie transaction 结束之后。
    //
    // reconcileAll 会按最终落库的 Entry JSON 校正 media.entryId / sortOrder，
    // 这样导入完成后立刻执行彻底删除，也不会因为旧的 media.entryId 关联
    // 而误删原条目或副本条目的图片。
    // ──────────────────────────────────────────
    await localMediaRepo.reconcileAll()

    return report
  },
}
