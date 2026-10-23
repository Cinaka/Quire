import type { NotebookProjection } from "./notebookContent"
import type { ExportSelectionPlan } from "./exportScope"

export const EXPORT_SNAPSHOT_LIMITS = Object.freeze({
  entries: 100, bodyBytes: 4 * 1024 ** 2, bodyNodes: 20000, depth: 64,
  mediaBytes: 64 * 1024 ** 2, imageBytes: 12 * 1024 ** 2, images: 100,
  // Scan guards protect discarded candidates too; not device capacity claims.
  scanRows: 10000, scanBytes: 16 * 1024 ** 2, scanNodes: 200000,
  metadataBytes: 1024 ** 2, tagReferences: 1000, stageMs: 20000,
})
export class ExportSnapshotError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.code = code; this.name = "ExportSnapshotError" }
}
export type ExportDiagnosticCode = "CONTENT_UNSUPPORTED" | "TAG_MISSING" | "IMAGE_MISSING" | "IMAGE_THUMBNAIL_ONLY" | "IMAGE_TYPE_UNSUPPORTED"
export interface ExportDiagnostic { readonly code: ExportDiagnosticCode; readonly entryId: string; readonly resourceId?: string }
export interface ExportSnapshotEntry {
  readonly id: string; readonly entryDate: string; readonly sortOrder: number
  readonly title: string; readonly mood: string | null; readonly weather: string | null
  readonly updatedAt: string
  readonly content: NotebookProjection
  readonly tags: readonly { readonly id: string; readonly name: string; readonly color: string | null }[]
}
export interface ExportSnapshotMedia {
  readonly id: string
  readonly blob: Blob | null
  readonly thumbnailOnly: boolean
}
export interface ExportSnapshot {
  readonly selection: ExportSelectionPlan
  readonly capturedAt: number
  readonly entries: readonly ExportSnapshotEntry[]
  readonly media: readonly ExportSnapshotMedia[]
  readonly diagnostics: readonly ExportDiagnostic[]
  /** False until outside-transaction header/decode/font preflight is completed. */
  readonly completeOutputReady: false
  readonly counts: Readonly<{ scannedRows: number; scanBytes: number; bodyBytes: number; bodyNodes: number; metadataBytes: number; mediaBytes: number }>
}
/** Deep freeze plain presentation values without recursive stack overflow; Blobs are
 * immutable byte references, not Object URLs. Never persist this model. */
export function freezeExportValue<T>(root: T): T {
  const stack: unknown[] = [root], seen = new Set<object>()
  while (stack.length) {
    const value = stack.pop()
    if (!value || typeof value !== "object" || seen.has(value) || (typeof Blob !== "undefined" && value instanceof Blob)) continue
    seen.add(value)
    for (const child of Object.values(value)) stack.push(child)
    Object.freeze(value)
  }
  return root
}
/** Synchronous, bounded UTF-8 JSON accounting: safe inside an IDB request chain.
 * No serialization copy, yielding timers, Blob reads, DOM or network awaits. */
export function createExportJsonMeter(byteLimit: number, nodeLimit: number, check: () => void) {
  let bytes = 0, nodes = 0
  const fail = (code: string): never => { throw new ExportSnapshotError(code) }
  function add(n: number): void { bytes += n; if (bytes > byteLimit) fail("EXPORT_JSON_BYTE_LIMIT") }
  function string(value: string): void {
    if (value.length > byteLimit - bytes) fail("EXPORT_JSON_BYTE_LIMIT")
    add(2)
    for (let i = 0; i < value.length; i++) {
      if (i % 256 === 0) check()
      const c = value.charCodeAt(i)
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) add(2)
      else if (c < 32) add(6)
      else if (c < 128) add(1)
      else if (c < 2048) add(2)
      else if (c >= 0xd800 && c <= 0xdbff) {
        const next = value.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) { add(4); i++ } else add(6)
      } else if (c >= 0xdc00 && c <= 0xdfff) add(6)
      else add(3)
    }
  }
  function measure(value: unknown, depth: number, ancestors: Set<object>): void {
    check(); if (++nodes > nodeLimit) fail("EXPORT_JSON_NODE_LIMIT")
    if (depth > EXPORT_SNAPSHOT_LIMITS.depth) fail("EXPORT_JSON_DEPTH_LIMIT")
    if (value === null) { add(4); return }
    if (typeof value === "string") { string(value); return }
    if (typeof value === "boolean") { add(value ? 4 : 5); return }
    if (typeof value === "number" && Number.isFinite(value)) { add(String(value).length); return }
    if (!value || typeof value !== "object") fail("EXPORT_JSON_UNSUPPORTED")
    const object = value as object
    if (ancestors.has(object)) fail("EXPORT_JSON_CYCLE")
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("EXPORT_JSON_UNSUPPORTED")
    ancestors.add(object); add(2)
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (i) add(1)
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("EXPORT_JSON_UNSUPPORTED")
        measure(descriptor!.value, depth + 1, ancestors)
      }
    } else {
      const names = Object.keys(object)
      for (let i = 0; i < names.length; i++) {
        if (i) add(1)
        string(names[i]!); add(1)
        const descriptor = Object.getOwnPropertyDescriptor(object, names[i]!)
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("EXPORT_JSON_UNSUPPORTED")
        measure(descriptor!.value, depth + 1, ancestors)
      }
    }
    ancestors.delete(object)
  }
  return { measure(value: unknown): void { measure(value, 0, new Set()); check() }, counts: () => ({ bytes, nodes }) }
}
