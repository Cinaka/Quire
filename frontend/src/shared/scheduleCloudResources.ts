import { conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { resourceEvidenceReferences } from "./scheduleResourceEvidence"
import { parseScheduleTerminalReview } from "./scheduleTerminalReview"
import type { ScheduleTerminalReview } from "./scheduleTerminalReview"
import { scheduleEntryId } from "./schedules"

export interface CloudImageProof {
  state: "verified" | "missing" | "unavailable" | "not_present"
  size: number | null; sha256: string | null; mime: string | null
}
export interface CloudMediaProof {
  id: string; entryId: string; sortOrder: number; width: number | null; height: number | null
  size: number | null; createdAt: string; original: CloudImageProof; thumbnail: CloudImageProof
}
export interface CloudTagProof { id: string; name: string; color: string | null; createdAt: string }
export interface ScheduleCloudResourceReview {
  readOnly: true; resolutionEnabled: false; proofScope: "current_entry_resources"
  resourceState: "verified" | "incomplete" | "unsupported" | "no_entry"; resourcesComplete: boolean
  review: ScheduleTerminalReview; mediaIds: string[]; tagIds: string[]
  media: CloudMediaProof[]; tags: CloudTagProof[]; missingMediaIds: string[]; missingTagIds: string[]
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("资源核对响应结构无效")
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(key => !keys.includes(key)) || keys.some(key => !(key in r))) throw new Error("资源核对字段未知或缺失")
  return r
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(id => typeof id !== "string" || scheduleEntryId(id) !== id) ||
      new Set(value).size !== value.length) throw new Error("核对资源ID无效")
  const sorted = [...value].sort()
  if (JSON.stringify(sorted) !== JSON.stringify(value)) throw new Error("核对资源顺序无效")
  return sorted
}
function timestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("资源创建时间无效")
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) throw new Error("资源创建时间精度不受支持")
  const digits = (match[2] ?? "").padEnd(6, "0")
  const millis = conversionUtc(`${match[1]}.${digits.slice(0, 3)}${match[3] ?? "Z"}`)
  return digits.slice(3) === "000" ? millis : `${millis.slice(0, -1)}${digits.slice(3)}Z`
}
function image(value: unknown, thumbnail: boolean): CloudImageProof {
  const r = record(value, ["state", "size", "sha256", "mime"])
  if (!["verified", "missing", "unavailable", ...(thumbnail ? ["not_present"] : [])].includes(String(r.state))) throw new Error("图片核对状态无效")
  if (r.state === "verified") {
    if (!Number.isSafeInteger(r.size) || Number(r.size) < 1 || Number(r.size) > 10 * 1024 * 1024 ||
        typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256) ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(r.mime))) throw new Error("图片摘要证明不完整")
  } else if (r.size !== null || r.sha256 !== null || r.mime !== null) throw new Error("未验证图片不能伪造摘要")
  return conversionCopy(r) as unknown as CloudImageProof
}
export function parseScheduleCloudResourceReview(raw: unknown, id: string): ScheduleCloudResourceReview {
  const r = record(raw, ["read_only", "resolution_enabled", "proof_scope", "resource_state", "resources_complete", "review",
    "media_ids", "tag_ids", "media", "tags", "missing_media_ids", "missing_tag_ids"])
  if (scheduleEntryId(id) !== id || r.read_only !== true || r.resolution_enabled !== false || r.proof_scope !== "current_entry_resources" ||
      typeof r.resources_complete !== "boolean" || !["verified", "incomplete", "unsupported", "no_entry"].includes(String(r.resource_state))) throw new Error("资源核对不是取舍或首次确认")
  const review = parseScheduleTerminalReview(r.review, id)
  const mediaIds = ids(r.media_ids), tagIds = ids(r.tag_ids), missingMediaIds = ids(r.missing_media_ids), missingTagIds = ids(r.missing_tag_ids)
  if (!Array.isArray(r.media) || !Array.isArray(r.tags) || r.media.length > 64 || r.tags.length > 64) throw new Error("资源行数量异常")
  let work = 0
  const media = r.media.map(value => {
    const m = record(value, ["id", "entry_id", "sort_order", "width", "height", "size", "created_at", "original", "thumbnail"])
    if (typeof m.id !== "string" || !mediaIds.includes(m.id) || m.entry_id !== id ||
        !Number.isSafeInteger(m.sort_order) || Number(m.sort_order) < 0 ||
        [m.width, m.height, m.size].some(v => v !== null && (!Number.isSafeInteger(v) || Number(v) < 0))) throw new Error("云端媒体身份或字段无效")
    const original = image(m.original, false), thumbnail = image(m.thumbnail, true)
    if (original.state === "verified" && original.size !== m.size) throw new Error("原图字节与元数据大小不一致")
    work += (original.size ?? 0) + (thumbnail.size ?? 0)
    return { id: m.id, entryId: id, sortOrder: m.sort_order, width: m.width, height: m.height, size: m.size,
      createdAt: timestamp(m.created_at), original, thumbnail } as CloudMediaProof
  })
  if (work > 16 * 1024 * 1024) throw new Error("资源证明工作量超限")
  const tags = r.tags.map(value => {
    const t = record(value, ["id", "name", "color", "created_at"])
    if (typeof t.id !== "string" || !tagIds.includes(t.id) || typeof t.name !== "string" || !t.name.length || t.name.length > 32 ||
        !(t.color === null || typeof t.color === "string" && t.color.length <= 16)) throw new Error("云端标签身份或字段无效")
    return { id: t.id, name: t.name, color: t.color, createdAt: timestamp(t.created_at) } as CloudTagProof
  })
  const foundMedia = ids(media.map(m => m.id)), foundTags = ids(tags.map(t => t.id))
  if (JSON.stringify(mediaIds.filter(key => !foundMedia.includes(key))) !== JSON.stringify(missingMediaIds) ||
      JSON.stringify(tagIds.filter(key => !foundTags.includes(key))) !== JSON.stringify(missingTagIds)) throw new Error("资源缺失清单不一致")
  if (r.resource_state === "no_entry" || r.resource_state === "unsupported") {
    if ((r.resource_state === "no_entry") !== (review.entry === null) || r.resources_complete ||
        mediaIds.length || tagIds.length || media.length || tags.length) throw new Error("无法核对时不能附可用资源证明")
  } else {
    if (!review.entry) throw new Error("资源证明没有当前日记")
    const refs = resourceEvidenceReferences({ source: review.schedule, entry: review.entry,
      linkedEntries: [], intentions: [], candidates: [], p2Conflicts: [] }, id)
    if (JSON.stringify(refs.mediaIds) !== JSON.stringify(mediaIds) || JSON.stringify(refs.tagIds) !== JSON.stringify(tagIds)) throw new Error("资源证明与当前日记引用不一致")
    const complete = !missingMediaIds.length && !missingTagIds.length && media.every(m => m.original.state === "verified" && ["verified", "not_present"].includes(m.thumbnail.state))
    if (r.resources_complete !== complete || (r.resource_state === "verified") !== complete) throw new Error("资源完整性标记不一致")
  }
  return conversionCopy({ readOnly: true, resolutionEnabled: false, proofScope: "current_entry_resources",
    resourceState: r.resource_state, resourcesComplete: r.resources_complete, review,
    mediaIds, tagIds, media, tags, missingMediaIds, missingTagIds }) as ScheduleCloudResourceReview
}
