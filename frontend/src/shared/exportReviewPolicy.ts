import { ExportSnapshotError, freezeExportValue, type ExportSnapshot } from "./exportSnapshot"
import { EXPORT_IMAGE_PLACEHOLDER_CODES, type ExportImageIssue } from "./exportMediaReview"

const REASONS = Object.freeze({
  CONTENT_UNSUPPORTED: "正文版本、结构或样式不受支持；仅保留安全兼容内容",
  TAG_MISSING: "引用的标签缺失",
  IMAGE_MISSING: "本机引用图片缺失",
  IMAGE_THUMBNAIL_ONLY: "仅有现存缩略图，非原图",
  IMAGE_TYPE_UNSUPPORTED: "图片类型不支持",
  INVALID_IMAGE_HEADER: "图片头损坏或与类型不符",
  UNSUPPORTED_JPEG_HEADER: "JPEG图片头不受支持",
  UNSUPPORTED_IMAGE_TYPE: "图片类型不支持",
  ANIMATED_IMAGE_UNSUPPORTED: "动画图片未纳入可复现的静态印刷支持",
  INVALID_DIMENSIONS: "图片尺寸无效",
  IMAGE_DIMENSION_LIMIT: "单图最长边超过保护上限",
  IMAGE_PIXEL_LIMIT: "单图像素超过保护上限",
  IMAGE_DECODE_FAILED: "浏览器未能解码图片",
  INVALID_BITMAP: "解码未返回可用位图",
  DECODE_DIMENSION_MISMATCH: "解码实际尺寸与图片头不符",
})
export type ExportReviewCode = keyof typeof REASONS
export interface ExportReviewIssue { readonly code: ExportReviewCode; readonly entryId: string; readonly resourceId?: string; readonly reason: string }
export interface ExportReview {
  readonly state: "empty-selection" | "full-content-available" | "requires-degraded-confirmation"
  readonly issueCount: number
  readonly affectedEntryCount: number
  readonly affectedImageCount: number
  readonly issues: readonly ExportReviewIssue[]
  readonly entries: readonly { readonly entryId: string; readonly entryDate: string; readonly title: string; readonly issues: readonly ExportReviewIssue[] }[]
  readonly groups: readonly { readonly code: ExportReviewCode; readonly reason: string; readonly issueCount: number; readonly entryCount: number; readonly imageCount: number }[]
  readonly completeOutputReady: false
}
export type ExportContentMode = "full" | "degraded"
/** Private, current-snapshot review; plain text only, never HTML, logs or storage.
 * Count unique (entry, code, resource) issues; a shared image may affect many entries. */
export function createExportReview(snapshot: ExportSnapshot, mediaIssues: readonly ExportImageIssue[]): ExportReview {
  const entries = new Map(snapshot.entries.map(entry => [entry.id, entry]))
  const media = new Set(snapshot.media.map(item => item.id)), seen = new Set<string>(), issues: ExportReviewIssue[] = []
  function add(code: string, entryId: string, resourceId?: string): void {
    if (!Object.hasOwn(REASONS, code) || !entries.has(entryId)) throw new ExportSnapshotError("EXPORT_INVALID_REVIEW")
    const key = JSON.stringify([entryId, code, resourceId ?? null]); if (seen.has(key)) return; seen.add(key)
    const issue: ExportReviewIssue = { code: code as ExportReviewCode, entryId, reason: REASONS[code as ExportReviewCode], ...(resourceId === undefined ? {} : { resourceId }) }
    issues.push(issue)
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.code.startsWith("IMAGE_") && (!diagnostic.resourceId || !media.has(diagnostic.resourceId) || !entries.get(diagnostic.entryId)?.content.mediaIds.includes(diagnostic.resourceId))) throw new ExportSnapshotError("EXPORT_INVALID_REVIEW")
    add(diagnostic.code, diagnostic.entryId, diagnostic.resourceId)
  }
  for (const diagnostic of mediaIssues) {
    if (!(EXPORT_IMAGE_PLACEHOLDER_CODES as readonly string[]).includes(diagnostic.code) || !media.has(diagnostic.resourceId)) throw new ExportSnapshotError("EXPORT_INVALID_REVIEW")
    let found = false
    for (const entry of snapshot.entries) if (entry.content.mediaIds.includes(diagnostic.resourceId)) { found = true; add(diagnostic.code, entry.id, diagnostic.resourceId) }
    if (!found) throw new ExportSnapshotError("EXPORT_INVALID_REVIEW")
  }
  const affected = snapshot.entries.flatMap(entry => {
    const list = issues.filter(issue => issue.entryId === entry.id)
    return list.length ? [{ entryId: entry.id, entryDate: entry.entryDate, title: entry.title, issues: list }] : []
  })
  const imageIds = (list: readonly ExportReviewIssue[]) => new Set(list.flatMap(issue => issue.resourceId && issue.code !== "TAG_MISSING" ? [issue.resourceId] : []))
  const codes = [...new Set(issues.map(issue => issue.code))]
  return freezeExportValue<ExportReview>({
    state: !snapshot.entries.length ? "empty-selection" : issues.length ? "requires-degraded-confirmation" : "full-content-available",
    issueCount: issues.length, affectedEntryCount: affected.length, affectedImageCount: imageIds(issues).size,
    issues, entries: affected, groups: codes.map(code => { const list = issues.filter(issue => issue.code === code); return {
      code, reason: REASONS[code], issueCount: list.length, entryCount: new Set(list.map(issue => issue.entryId)).size, imageCount: imageIds(list).size,
    } }), completeOutputReady: false,
  })
}
/** Content-policy gate ONLY. No fonts/pagination/output capability, no persisted
 * permission and no claim that the user saw a UI; formal confirmation comes P6-3. */
export function assertExportContentMode(review: ExportReview, mode: ExportContentMode, confirmed: boolean): void {
  if (review.state === "empty-selection") throw new ExportSnapshotError("EXPORT_EMPTY_SELECTION")
  if (mode !== "full" && mode !== "degraded") throw new ExportSnapshotError("EXPORT_INVALID_CONTENT_MODE")
  if (mode === "full" && review.issueCount) throw new ExportSnapshotError("EXPORT_FULL_CONTENT_BLOCKED")
  if (mode === "degraded" && !review.issueCount) throw new ExportSnapshotError("EXPORT_DEGRADED_NOT_NEEDED")
  if (mode === "degraded" && !confirmed) throw new ExportSnapshotError("EXPORT_DEGRADED_CONFIRMATION_REQUIRED")
}
