import type { NotebookNode, NotebookTag } from "./notebookContent"
import type { ExportCheckedSnapshot } from "./exportPreflightTask"
import { assertExportContentMode, type ExportContentMode, type ExportReviewIssue } from "./exportReviewPolicy"
import { ExportSnapshotError, freezeExportValue } from "./exportSnapshot"

const ELEMENTS = new Set<string>(["div", "p", "h1", "h2", "h3", "ul", "ol", "li", "blockquote", "pre", "code", "br", "strong", "em", "s"])

export interface ExportSource { readonly entryId: string; readonly path: readonly number[] }
export type ExportDocumentNode =
  | { readonly kind: "text"; readonly text: string; readonly source: ExportSource }
  | { readonly kind: "notice"; readonly text: string; readonly source: ExportSource }
  | { readonly kind: "element"; readonly tag: NotebookTag; readonly start?: number; readonly children: readonly ExportDocumentNode[]; readonly source: ExportSource }
  | { readonly kind: "image"; readonly mediaId: string; readonly width: number; readonly height: number; readonly alt: string; readonly title: string; readonly thumbnailOnly: boolean; readonly source: ExportSource }
  | { readonly kind: "placeholder"; readonly mediaId: string; readonly alt: string; readonly title: string; readonly reasons: readonly string[]; readonly source: ExportSource }
export interface ExportDocument {
  readonly entries: readonly {
    readonly id: string; readonly entryDate: string; readonly title: string; readonly mood: string | null; readonly weather: string | null
    readonly tags: readonly string[]; readonly issues: readonly ExportReviewIssue[]; readonly warnings: readonly string[]; readonly nodes: readonly ExportDocumentNode[]
  }[]
  readonly contentMode: ExportContentMode
  readonly completeOutputReady: false
}
/** Pure presentation copy, not authorization. Only the current preflight task can
 * supply a live handoff; downstream must recheck after every asynchronous stage.
 * No DOM, arbitrary HTML/URL, raw Entry, owner, timestamps or Blob in this model. */
export function createExportDocument(value: ExportCheckedSnapshot & { readonly contentMode: ExportContentMode }): ExportDocument {
  assertExportContentMode(value.review, value.contentMode, value.degradedConfirmed)
  const images = new Map(value.images.items.map(item => [item.id, item]))
  const media = new Map(value.snapshot.media.map(item => [item.id, item]))
  let count = 0
  const entries = value.snapshot.entries.map(entry => {
    const issues = value.review.issues.filter(issue => issue.entryId === entry.id)
    function copy(node: NotebookNode, path: number[], depth: number): ExportDocumentNode {
      if (++count > 200000 || depth > 128) throw new ExportSnapshotError("EXPORT_DOCUMENT_LIMIT")
      const source = { entryId: entry.id, path }
      if (node.kind === "text" || node.kind === "notice") return { kind: node.kind, text: node.text, source }
      if (node.kind === "element") {
        if (!ELEMENTS.has(node.tag) || (node.start !== undefined && (node.tag !== "ol" || !Number.isSafeInteger(node.start) || node.start < 1 || node.start > 1000000))) throw new ExportSnapshotError("EXPORT_DOCUMENT_INVALID_NODE")
        return { kind: "element", tag: node.tag, ...(node.start === undefined ? {} : { start: node.start }),
          children: node.children.map((child, i) => copy(child, [...path, i], depth + 1)), source }
      }
      if (node.kind !== "image") throw new ExportSnapshotError("EXPORT_DOCUMENT_INVALID_NODE")
      const image = images.get(node.mediaId), ref = media.get(node.mediaId)
      if (!ref) throw new ExportSnapshotError("EXPORT_DOCUMENT_INVALID_MEDIA")
      if (image) return { kind: "image", mediaId: image.id, width: image.width, height: image.height,
        alt: node.alt, title: node.title, thumbnailOnly: ref.thumbnailOnly, source }
      const reasons = issues.filter(issue => issue.resourceId === node.mediaId && issue.code !== "TAG_MISSING").map(issue => issue.reason)
      if (!reasons.length || value.contentMode !== "degraded") throw new ExportSnapshotError("EXPORT_DOCUMENT_UNDIAGNOSED_MEDIA")
      return { kind: "placeholder", mediaId: node.mediaId, alt: node.alt, title: node.title, reasons: [...new Set(reasons)], source }
    }
    return { id: entry.id, entryDate: entry.entryDate, title: entry.title, mood: entry.mood, weather: entry.weather,
      tags: entry.tags.map(tag => tag.name), issues: issues.map(issue => ({ ...issue })), warnings: [...entry.content.warnings],
      nodes: entry.content.nodes.map((node, i) => copy(node, [i], 0)) }
  })
  return freezeExportValue({ entries, contentMode: value.contentMode, completeOutputReady: false as const })
}
/** Bounded unique scalar text for font selection, including generated diagnostics.
 * Never logged, persisted, sent to a server or stored in the public catalog. */
export function collectExportFontText(document: ExportDocument): string {
  const chars = new Set<string>(); let units = 0
  function add(text: string): void {
    units += text.length
    if (units > 6 * 1024 ** 2) throw new ExportSnapshotError("EXPORT_FONT_TEXT_LIMIT")
    for (const char of text) chars.add(char)
  }
  add("青简 杀青 目录 目录·续 第 页 缩略图 图片占位 正文诊断 无题【】；#　 0123456789—：")
  for (const entry of document.entries) {
    add(entry.entryDate); add(entry.title); add(entry.mood ?? ""); add(entry.weather ?? "")
    for (const tag of entry.tags) add(tag)
    for (const issue of entry.issues) add(issue.reason)
    for (const warning of entry.warnings) add(warning)
    const stack = [...entry.nodes]
    while (stack.length) {
      const node = stack.pop()!
      if (node.kind === "element") { for (const child of node.children) stack.push(child) }
      else if (node.kind === "text" || node.kind === "notice") add(node.text)
      else { add(node.alt); add(node.title); if (node.kind === "placeholder") for (const reason of node.reasons) add(reason) }
    }
  }
  return [...chars].join("")
}
