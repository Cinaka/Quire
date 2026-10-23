import type { ExportDocument, ExportDocumentNode, ExportSource } from "./exportDocument"
import { ExportSnapshotError } from "./exportSnapshot"

export const EXPORT_LAYOUT_LIMITS = Object.freeze({ pages: 300, stageMs: 20000, nodes: 200000, boundaryBytes: 32 * 1024 ** 2, probeUnits: 8192 })
export interface ExportFlowNode {
  readonly kind: "text" | "element" | "image" | "empty"
  readonly id: number; readonly start: number; readonly end: number; readonly source: ExportSource
  readonly tag?: string; readonly role?: string; readonly text?: string; readonly children?: readonly ExportFlowNode[]
  readonly listStart?: number; readonly listValue?: number
  readonly image?: Extract<ExportDocumentNode, { kind: "image" }>
}
export interface ExportEntryFlow { readonly entryId: string; readonly nodes: readonly ExportFlowNode[]; readonly units: number }
export interface ExportFlowSlice extends ExportFlowNode { readonly continued: boolean; readonly from: number; readonly to: number; readonly utf16From?: number; readonly utf16To?: number; readonly children?: readonly ExportFlowSlice[] }
const boundaries = new WeakMap<ExportFlowNode, Uint32Array>(), flows = new WeakSet<ExportEntryFlow>()
/** Private bounded grapheme index. Each text/image/hard break/empty structure has
 * coverage; slicing reconstructs ancestor marks, nested quotes and numbered lists.
 * Metadata has negative source paths, disjoint from original body paths. */
export async function compileExportFlows(document: ExportDocument, options: { check: () => void; yieldControl: () => Promise<void> }): Promise<readonly ExportEntryFlow[]> {
  if (typeof Intl.Segmenter !== "function") throw new ExportSnapshotError("EXPORT_SEGMENTER_UNAVAILABLE")
  const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" })
  let ids = 0, bytes = 0, steps = 0
  const result: ExportEntryFlow[] = []
  async function tick() { if (++steps % 1024 === 0) { options.check(); await options.yieldControl(); options.check() } }
  for (const entry of document.entries) {
    options.check(); let cursor = 0
    const source = (path: number[]): ExportSource => ({ entryId: entry.id, path })
    async function text(value: string, origin: ExportSource): Promise<ExportFlowNode> {
      const start = cursor, budget = (value.length + 1) * 4
      if ((bytes += budget) > EXPORT_LAYOUT_LIMITS.boundaryBytes) throw new ExportSnapshotError("EXPORT_FRAGMENT_MEMORY_LIMIT")
      const offsets = new Uint32Array(value.length + 1); let length = 0
      for (const part of segmenter.segment(value)) { if (part.segment.length > 8192) throw new ExportSnapshotError("EXPORT_GRAPHEME_LIMIT"); offsets[length++] = part.index; cursor++; await tick() }
      offsets[length] = value.length
      // Even empty text is an explicit source unit; no silent empty-node loss.
      if (!length) cursor++
      const node = make({ kind: "text", text: value, start, end: cursor, source: origin })
      boundaries.set(node, offsets.subarray(0, length + 1)); return node
    }
    function make(value: Omit<ExportFlowNode, "id">): ExportFlowNode {
      options.check(); if (++ids > EXPORT_LAYOUT_LIMITS.nodes) throw new ExportSnapshotError("EXPORT_FRAGMENT_NODE_LIMIT")
      return Object.freeze({ ...value, id: ids })
    }
    async function element(tag: string, children: readonly ExportFlowNode[], origin: ExportSource, start: number, extra: Partial<ExportFlowNode> = {}) {
      if (cursor === start) { cursor++; return make({ kind: "empty", tag, children, source: origin, start, end: cursor, ...extra }) }
      return make({ kind: "element", tag, children: Object.freeze([...children]), source: origin, start, end: cursor, ...extra })
    }
    async function wrap(tag: string, value: string, path: number[], role: string) {
      const start = cursor, origin = source(path); return element(tag, [await text(value, origin)], origin, start, { role })
    }
    async function build(node: ExportDocumentNode, listValue?: number): Promise<ExportFlowNode> {
      await tick(); const start = cursor
      if (node.kind === "text") return text(node.text, node.source)
      if (node.kind === "notice") return element("span", [await text(node.text, node.source)], node.source, start, { role: "notice" })
      if (node.kind === "placeholder") return element("span", [await text(`【图片占位】${[node.title, node.alt, ...node.reasons].filter(Boolean).join("；")}`, node.source)], node.source, start, { role: "placeholder" })
      if (node.kind === "image") {
        const picture = make({ kind: "image", image: node, source: node.source, start: cursor, end: ++cursor })
        const children = [picture], caption = node.title || node.alt
        if (caption) { const at = cursor; children.push(await element("span", [await text(caption, node.source)], node.source, at, { role: "caption" })) }
        return element("span", children, node.source, start, { role: "figure" })
      }
      let number = node.tag === "ol" ? node.start ?? 1 : undefined
      const children: ExportFlowNode[] = []
      for (const child of node.children) {
        const numbered = child.kind === "element" && child.tag === "li" && number !== undefined ? number++ : undefined
        children.push(await build(child, numbered))
      }
      return element(node.tag, children, node.source, start, { ...(node.start === undefined ? {} : { listStart: node.start }), ...(listValue === undefined ? {} : { listValue }) })
    }
    const nodes: ExportFlowNode[] = []
    nodes.push(await wrap("p", entry.entryDate, [-1], "date"))
    nodes.push(await wrap("h2", entry.title || "无题", [-2], "title"))
    const meta = [entry.weather, entry.mood, ...entry.tags.map(name => `#${name}`)].filter(Boolean).join("　")
    if (meta) nodes.push(await wrap("p", meta, [-3], "meta"))
    for (const [i, issue] of entry.issues.entries()) nodes.push(await wrap("p", issue.reason, [-4, i], "diagnostic"))
    for (const [i, warning] of entry.warnings.entries()) nodes.push(await wrap("p", warning, [-5, i], "diagnostic"))
    for (const node of entry.nodes) nodes.push(await build(node))
    const flow = Object.freeze({ entryId: entry.id, nodes: Object.freeze(nodes), units: cursor }); flows.add(flow); result.push(flow)
  }
  options.check(); return Object.freeze(result)
}
export function sliceExportFlow(flow: ExportEntryFlow, from: number, to: number): readonly ExportFlowSlice[] {
  if (!flows.has(flow) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > flow.units) throw new ExportSnapshotError("EXPORT_INVALID_FRAGMENT_RANGE")
  function slice(node: ExportFlowNode): ExportFlowSlice | undefined {
    if (node.end <= from || node.start >= to) return undefined
    const begin = Math.max(from, node.start), finish = Math.min(to, node.end)
    if (node.kind === "text") {
      const offsets = boundaries.get(node)!, a = offsets[begin - node.start] ?? 0, b = offsets[finish - node.start] ?? node.text!.length
      return Object.freeze({ ...node, text: node.text!.slice(a, b), from: begin, to: finish, utf16From: a, utf16To: b, continued: begin > node.start })
    }
    const children = node.children?.flatMap(child => { const value = slice(child); return value ? [value] : [] })
    return Object.freeze({ ...node, ...(children ? { children: Object.freeze(children) } : {}), from: begin, to: finish, continued: begin > node.start })
  }
  return Object.freeze(flow.nodes.flatMap(node => { const value = slice(node); return value ? [value] : [] }))
}
export interface ExportPageRange { readonly entryId: string; readonly from: number; readonly to: number }
export function assertExportPageCoverage(flows: readonly ExportEntryFlow[], pages: readonly ExportPageRange[]): void {
  let p = 0
  for (const flow of flows) {
    let cursor = 0
    while (p < pages.length && pages[p]!.entryId === flow.entryId) {
      const page = pages[p++]!
      if (page.from !== cursor || page.to <= cursor || page.to > flow.units) throw new ExportSnapshotError("EXPORT_PAGE_COVERAGE_FAILED")
      cursor = page.to
    }
    if (cursor !== flow.units) throw new ExportSnapshotError("EXPORT_PAGE_COVERAGE_FAILED")
  }
  if (p !== pages.length) throw new ExportSnapshotError("EXPORT_PAGE_COVERAGE_FAILED")
}
