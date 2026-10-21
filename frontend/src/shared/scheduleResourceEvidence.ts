import { assertKnownConflictSchedule } from "./scheduleConflict"
import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { assertTerminalTextEntry, terminalVersionKey } from "./scheduleTerminalConflict"
import { assertScheduleDate, scheduleEntryId } from "./schedules"
import type { Entry, Schedule, Tag } from "./types"

export const RESOURCE_EVIDENCE_MAX_BYTES = 64 * 1024 * 1024
export const RESOURCE_EVIDENCE_MAX_BINARY = 16 * 1024 * 1024
export interface ResourceEvidenceState {
  source: Schedule | null; entry: Entry | null; linkedEntries: Entry[]
  intentions: unknown[]; candidates: unknown[]; p2Conflicts: unknown[]
}
export interface ResourceEvidenceMedia {
  id: string; entryId: string; mime: string; width: number | null; height: number | null
  size: number; sortOrder: number; createdAt: string; dirty: 0 | 1; orphanedAt: string | null
  hadRemoteLink: boolean; hadThumbRemoteLink: boolean
  blobBase64: string; thumbBase64: string | null; thumbMime: string | null
}
export interface ScheduleResourceEvidence {
  app: "quire"; format: "terminal-local-resource-evidence"; formatVersion: 1
  exportedAt: string; scheduleId: string; state: ResourceEvidenceState
  mediaIds: string[]; tagIds: string[]; media: ResourceEvidenceMedia[]; tags: Tag[]
  missingMediaIds: string[]; missingTagIds: string[]; completeLocalResources: boolean
  entryPendingPurge: boolean; resolutionEnabled: false; meaning: "local_snapshot_not_cloud_confirmation_or_restore"
}
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("资源证据结构无效")
  return raw as Record<string, unknown>
}
function fields(raw: unknown, allowed: string[], required = allowed) {
  const row = record(raw)
  if (Object.keys(row).some(key => !allowed.includes(key)) || required.some(key => !(key in row))) {
    throw new Error("资源证据含未知或缺失字段，未丢字段")
  }
  return row
}
function ids(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some(id => typeof id !== "string" || scheduleEntryId(id) !== id) || new Set(raw).size !== raw.length) throw new Error("资源ID无效或重复")
  return raw as string[]
}
function richEntry(raw: unknown, id: string, linked = false): Entry {
  const r = record(raw) as unknown as Entry
  if (scheduleEntryId(r.id) !== r.id || r.fromScheduleId !== id || (!linked && r.id !== id)) throw new Error("日记证据身份不一致")
  ids(r.tagIds)
  // Reuse strict DTO clocks/fields, without discarding the original rich content or tag links.
  assertTerminalTextEntry({ ...r, id, fromScheduleId: id, content: null, tagIds: [] }, id)
  if (r.content !== null) {
    const body = fields(r.content, ["schemaVersion", "doc"])
    if (body.schemaVersion !== 1 || record(body.doc).type !== "doc") throw new Error("未知正文版本保留保护")
  }
  return r
}
function references(content: unknown, media: Set<string>) {
  const stack = [{ value: content, depth: 0 }]; let count = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++count > 100000 || depth > 64) throw new Error("正文过深或过大")
    if (!value || typeof value !== "object") continue
    const node = value as Record<string, unknown>
    if (node.type === "image") {
      const src = record(node.attrs).src
      if (typeof src !== "string" || !src.startsWith("local://media/")) throw new Error("图片必须是本机媒体引用，不抓取外部地址")
      const id = src.slice("local://media/".length)
      if (scheduleEntryId(id) !== id) throw new Error("图片引用无效")
      media.add(id)
    }
    for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 })
  }
}
export function resourceEvidenceReferences(raw: ResourceEvidenceState, id: string) {
  if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
  fields(raw, ["source", "entry", "linkedEntries", "intentions", "candidates", "p2Conflicts"])
  if (![raw.linkedEntries, raw.intentions, raw.candidates, raw.p2Conflicts].every(Array.isArray)) throw new Error("证据数组无效")
  const media = new Set<string>(), tags = new Set<string>()
  const source = (value: unknown) => { if (value !== null) assertKnownConflictSchedule(value, id) }
  const entry = (value: unknown, linked = false) => { if (value !== null) { const r = richEntry(value, id, linked); references(r.content, media); r.tagIds.forEach(tag => tags.add(tag)) } }
  const intent = (value: unknown) => {
    const r = fields(value, ["scheduleId", "source", "entry", "queuedAt", "protectedMediaIds"], ["scheduleId", "source", "entry", "queuedAt"])
    if (r.scheduleId !== id || record(r.source).status !== "pending" || record(r.source).isDeleted !== 0) throw new Error("首次意图身份不一致")
    source(r.source); entry(r.entry); conversionUtc(r.queuedAt)
    ids(r.protectedMediaIds ?? []).forEach(item => media.add(item))
  }
  source(raw.source); entry(raw.entry); raw.linkedEntries.forEach(row => entry(row, true)); raw.intentions.forEach(intent)
  const shapes: Record<string, string[]> = {
    "conversion-entry": ["scheduleId", "kind", "localEntry", "serverEntry"],
    "conversion-ack": ["scheduleId", "kind", "reason", "firstIntent", "serverSchedule", "serverEntry"],
    "conversion-transport": ["scheduleId", "kind", "firstIntent", "stage", "reason", "serverSchedule", "serverEntry", "firstEntryDate", "firstEntryDeleted"],
    "schedule-pull-conflict": ["scheduleId", "kind", "reason", "localSchedule", "serverSchedule"],
    "schedule-push": ["scheduleId", "kind", "reason", "submitted", "expectedServerRevision", "serverSchedule"],
  }
  for (const value of raw.candidates) {
    const r = record(value), keys = typeof r.kind === "string" ? shapes[r.kind] : undefined
    if (!keys || r.scheduleId !== id) throw new Error("未知候选保留保护")
    fields(r, keys, keys.filter(key => !(r.kind === "conversion-entry" && key === "localEntry")))
    for (const key of ["localSchedule", "serverSchedule", "submitted"]) if (key in r) source(r[key])
    for (const key of ["localEntry", "serverEntry"]) if (key in r) entry(r[key])
    if ("firstIntent" in r) intent(r.firstIntent)
    if ("expectedServerRevision" in r && r.expectedServerRevision !== null) conversionUtc(r.expectedServerRevision)
    if ("reason" in r && (typeof r.reason !== "string" || !["identity", "server_entry_changed", "identity_conflict", "invalid_state", "source_deleted", "source_revision", "conversion_revision", "source_content", "source_snapshot", "receipt_unknown", "intent_conflict", "stale", "conflict", "terminal", "not_terminal", "echo_mismatch", "dirty_conflict", "terminal_regression", "terminal_source_changed", "same_revision_conflict", "revision_regression", "entry_identity_conflict", "retry", "network", "unauthorized", "not_found", "invalid_request", "invalid_response", "storage", "aborted", "unsupported_content", "invalid_local", "unknown_local_fields", "server_revision_conflict"].includes(r.reason))) throw new Error("候选原因字段无效")
    if ("firstEntryDate" in r && r.firstEntryDate !== null) { if (typeof r.firstEntryDate !== "string") throw new Error("首次日期无效"); assertScheduleDate(r.firstEntryDate) }
    if ("firstEntryDeleted" in r && r.firstEntryDeleted !== null && typeof r.firstEntryDeleted !== "boolean") throw new Error("首次删除状态无效")
    if ("stage" in r && !["source", "convert"].includes(String(r.stage))) throw new Error("候选阶段无效")
  }
  for (const value of raw.p2Conflicts) {
    const r = fields(value, ["entryId", "at", "local", "server"], ["entryId", "at", "local"])
    if (r.entryId !== id) throw new Error("普通日记冲突身份无效")
    terminalVersionKey(r.at as string); entry(r.local); if ("server" in r) entry(r.server)
  }
  return { mediaIds: [...media].sort(), tagIds: [...tags].sort() }
}
function base64Size(raw: unknown): number {
  if (typeof raw !== "string" || (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw))) throw new Error("媒体编码损坏")
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  if (raw.endsWith("==") && (alphabet.indexOf(raw.at(-3)!) & 15) !== 0 || raw.endsWith("=") && !raw.endsWith("==") && (alphabet.indexOf(raw.at(-2)!) & 3) !== 0) throw new Error("媒体编码尾位损坏")
  return raw.length / 4 * 3 - (raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0)
}
export function checkScheduleResourceEvidence(raw: unknown): ScheduleResourceEvidence {
  const r = fields(raw, ["app", "format", "formatVersion", "exportedAt", "scheduleId", "state", "mediaIds", "tagIds", "media", "tags", "missingMediaIds", "missingTagIds", "completeLocalResources", "entryPendingPurge", "resolutionEnabled", "meaning"])
  if (r.app !== "quire" || r.format !== "terminal-local-resource-evidence" || r.formatVersion !== 1 || typeof r.entryPendingPurge !== "boolean" || r.resolutionEnabled !== false || r.meaning !== "local_snapshot_not_cloud_confirmation_or_restore") throw new Error("资源证据不能作为确认或恢复命令")
  if (typeof r.exportedAt !== "string" || conversionUtc(r.exportedAt) !== r.exportedAt) throw new Error("导出时间无效")
  const refs = resourceEvidenceReferences(r.state as ResourceEvidenceState, r.scheduleId as string)
  const mediaIds = ids(r.mediaIds), tagIds = ids(r.tagIds)
  if (refs.mediaIds.some(id => !mediaIds.includes(id)) || conversionCanonical(tagIds.slice().sort()) !== conversionCanonical(refs.tagIds)) throw new Error("资源引用清单不完整")
  if (!Array.isArray(r.media) || !Array.isArray(r.tags)) throw new Error("资源数组无效")
  const gotMedia = new Set<string>(), gotTags = new Set<string>(); let binary = 0
  for (const value of r.media) {
    const m = fields(value, ["id", "entryId", "mime", "width", "height", "size", "sortOrder", "createdAt", "dirty", "orphanedAt", "hadRemoteLink", "hadThumbRemoteLink", "blobBase64", "thumbBase64", "thumbMime"])
    if (typeof m.id !== "string" || !mediaIds.includes(m.id) || gotMedia.has(m.id) || ![r.scheduleId, ""].includes(m.entryId as string)) throw new Error("媒体身份或归属无效")
    const length = base64Size(m.blobBase64)
    if (length === 0 || m.size !== length || typeof m.mime !== "string" || !m.mime || ![0, 1].includes(Number(m.dirty)) || typeof m.dirty !== "number" || typeof m.hadRemoteLink !== "boolean" || typeof m.hadThumbRemoteLink !== "boolean") throw new Error("媒体大小或字段无效")
    for (const dimension of [m.width, m.height]) if (dimension !== null && (!Number.isSafeInteger(dimension) || Number(dimension) < 0)) throw new Error("媒体尺寸无效")
    if (!Number.isSafeInteger(m.sortOrder) || Number(m.sortOrder) < 0) throw new Error("媒体排序无效")
    terminalVersionKey(m.createdAt as string); if (m.orphanedAt !== null) terminalVersionKey(m.orphanedAt as string)
    if (m.thumbBase64 === null ? m.thumbMime !== null : typeof m.thumbMime !== "string" || !m.thumbMime) throw new Error("缩略图MIME无效")
    binary += length + (m.thumbBase64 === null ? 0 : base64Size(m.thumbBase64)); gotMedia.add(m.id)
  }
  if (binary > RESOURCE_EVIDENCE_MAX_BINARY) throw new Error("资源证据超过16MiB二进制限制")
  for (const value of r.tags) {
    const tag = fields(value, ["id", "name", "color", "createdAt", "dirty"])
    if (typeof tag.id !== "string" || !tagIds.includes(tag.id) || gotTags.has(tag.id) || typeof tag.name !== "string" || !(tag.color === null || typeof tag.color === "string") || typeof tag.dirty !== "number" || ![0, 1].includes(tag.dirty)) throw new Error("标签证据字段无效")
    terminalVersionKey(tag.createdAt as string); gotTags.add(tag.id)
  }
  const missingMedia = mediaIds.filter(id => !gotMedia.has(id)).sort(), missingTags = tagIds.filter(id => !gotTags.has(id)).sort()
  if (conversionCanonical(ids(r.missingMediaIds).slice().sort()) !== conversionCanonical(missingMedia) || conversionCanonical(ids(r.missingTagIds).slice().sort()) !== conversionCanonical(missingTags) || r.completeLocalResources !== (!missingMedia.length && !missingTags.length)) throw new Error("缺失清单或完整性标记不一致")
  return conversionCopy(r) as unknown as ScheduleResourceEvidence
}
export function parseScheduleResourceEvidence(text: string): ScheduleResourceEvidence {
  if (typeof text !== "string" || !text.length || text.length > RESOURCE_EVIDENCE_MAX_BYTES) throw new Error("资源证据文件为空或超限")
  let raw: unknown; try { raw = JSON.parse(text) } catch { throw new Error("资源证据JSON损坏") }
  const stack = [{ value: raw, depth: 0 }]; let count = 0
  while (stack.length) { const { value, depth } = stack.pop()!; if (++count > 100000 || depth > 64) throw new Error("资源证据过深或过大"); if (value && typeof value === "object") for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 }) }
  return checkScheduleResourceEvidence(raw)
}
export function serializeScheduleResourceEvidence(value: ScheduleResourceEvidence): string {
  return `${JSON.stringify(parseScheduleResourceEvidence(JSON.stringify(value)))}\n`
}
