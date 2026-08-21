import type { Entry, MediaItem, Tag } from "./types"

/**
 * 备份文件格式版本。注意它和正文的 CONTENT_SCHEMA_VERSION 是两件事：
 *   formatVersion         —— 备份文件的外壳结构（有哪些顶层字段、media 怎么编码）
 *   contentSchemaVersion  —— 每篇日记正文的 Tiptap 节点结构
 * 两者独立升级。导入时都要校验，但拒绝的粒度不同：
 * 外壳版本太新 → 整份拒绝；正文版本太新 → 只跳过那几篇。
 */
export const BACKUP_FORMAT_VERSION = 1

/** media 的 Blob 在 JSON 里存 base64（不含 data URL 前缀）。 */
export interface BackupMedia extends Omit<MediaItem, "blob" | "thumbBlob"> {
  blobBase64: string
  thumbBase64: string | null
}

export interface BackupFile {
  app: "quire"
  formatVersion: number
  /** 导出时刻，UTC */
  exportedAt: string
  contentSchemaVersion: number
  counts: { entries: number; tags: number; media: number }
  /** 含回收站里的条目：备份就该是全量，否则「导出后清空重装」会丢断简 */
  entries: Entry[]
  tags: Tag[]
  media: BackupMedia[]
}

/**
 * 同 id 已存在时怎么办。
 *   preferNewer —— 比 clientUpdatedAt，备份里更新才覆盖（默认，适合换设备 / 恢复）
 *   keepLocal   —— 本地优先，已存在的一律跳过（适合只想补回丢掉的那几篇）
 *   asCopy      —— 全部重新发 id 落成副本（适合把别人的备份并进自己的库）
 */
export type ImportConflict = "preferNewer" | "keepLocal" | "asCopy"

export type BackupCheck =
  | { ok: true; file: BackupFile }
  | { ok: false; reason: string }

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

/**
 * 校验一份解析后的 JSON 是不是本项目的备份。
 *
 * 这里挡的不是恶意文件，而是最常见的三种误操作：选错文件、
 * 用了未来版本的备份、文件被编辑器截断。三种都要给人话提示，
 * 不能让 JSON.parse 成功之后在写库时才崩。
 */
export function checkBackup(raw: unknown): BackupCheck {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "不是有效的 JSON 对象" }

  const f = raw as Partial<BackupFile>

  if (f.app !== "quire") return { ok: false, reason: "这不是青简的备份文件" }

  if (typeof f.formatVersion !== "number" || f.formatVersion < 1) {
    return { ok: false, reason: "缺少或非法的 formatVersion" }
  }
  if (f.formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      reason: `备份来自更新的版本（格式 v${f.formatVersion}，本机支持到 v${BACKUP_FORMAT_VERSION}），请先升级应用再导入`,
    }
  }

  if (!isArray(f.entries) || !isArray(f.tags) || !isArray(f.media)) {
    return { ok: false, reason: "文件结构不完整，可能已损坏或被截断" }
  }

  return { ok: true, file: f as BackupFile }
}

/** 正文版本比本机新 → 不能导入这一篇，否则编辑器会用不认识的节点开文档。 */
export function contentTooNew(entry: Entry, current: number): boolean {
  const v = entry.content?.schemaVersion
  return typeof v === "number" && v > current
}

/** quire-backup-20260821-1152.json。用本地时间命名，用户才认得出是哪天导的。 */
export function backupFileName(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
  return `quire-backup-${day}-${pad(d.getHours())}${pad(d.getMinutes())}.json`
}
