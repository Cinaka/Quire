import { ExportSnapshotError } from "./exportSnapshot"
export type ExportOutputMode = "a5" | "spread" | "booklet"
export const EXPORT_BOOK_LIMITS = Object.freeze({ pages: 300, entries: 100, tocIterations: 8, stageMs: 20000, titleUnits: 32768 })
const fail = (code: string): never => { throw new ExportSnapshotError(code) }
export function normalizeExportBookTitle(value = "青简"): string {
  if (typeof value !== "string") fail("EXPORT_BOOK_TITLE_INVALID")
  const title = value.replace(/[\u0000-\u001f\u007f-\u009f/\\]/g, " ").trim() || "青简"
  if ([...title].length > 120) fail("EXPORT_BOOK_TITLE_LIMIT")
  return title
}
export interface ExportTocMeasurement<T> { readonly pageCount: number; readonly value: T }
export async function settleExportToc<T>(bodyStarts: readonly number[], bodyPages: number,
  measure: (labels: readonly number[]) => Promise<ExportTocMeasurement<T>>,
  options: { signal?: AbortSignal; now?: () => number; assertCurrent?: () => Promise<void> } = {}) {
  const limits = EXPORT_BOOK_LIMITS, now = options.now ?? (() => performance.now()), began = now()
  if (!Number.isSafeInteger(bodyPages) || bodyPages < 1 || bodyPages > limits.pages || !bodyStarts.length || bodyStarts.length > limits.entries || bodyStarts[0] !== 1 || bodyStarts.some((n, i) => !Number.isSafeInteger(n) || n < 1 || n > bodyPages || (i > 0 && n <= bodyStarts[i - 1]!))) fail("EXPORT_TOC_STARTS_INVALID")
  const starts = [...bodyStarts], trace: { guess: number; measured: number }[] = [], seen = new Set<number>()
  const check = () => { if (options.signal?.aborted) fail("CANCELLED"); if (now() - began > limits.stageMs) fail("EXPORT_TOC_TIMEOUT") }
  let guess = 1
  for (let i = 0; i < limits.tocIterations; i++) {
    check(); if (seen.has(guess)) fail("EXPORT_TOC_CYCLE"); seen.add(guess)
    if (1 + guess + bodyPages > limits.pages) fail("EXPORT_PAGE_LIMIT")
    const labels = Object.freeze(starts.map(n => n + 1 + guess))
    const result = await measure(labels); check(); await options.assertCurrent?.(); check()
    if (!Number.isSafeInteger(result.pageCount) || result.pageCount < 1) fail("EXPORT_TOC_COUNT_INVALID")
    if (1 + result.pageCount + bodyPages > limits.pages) fail("EXPORT_PAGE_LIMIT")
    trace.push({ guess, measured: result.pageCount })
    if (guess === result.pageCount) return Object.freeze({ tocPages: guess, labels, trace: Object.freeze(trace.map(x => Object.freeze(x))), value: result.value })
    guess = result.pageCount
  }
  return fail("EXPORT_TOC_ITERATION_LIMIT")
}
export interface ExportPaperFace { readonly panels: readonly (number | null)[]; readonly sheet: number; readonly side: "front" | "back" | "single" }
export function mapExportPages(count: number, mode: ExportOutputMode) {
  if (!Number.isSafeInteger(count) || count < 1 || count > EXPORT_BOOK_LIMITS.pages) fail("EXPORT_PAGE_LIMIT")
  const page = (n: number) => n <= count ? n : null, faces: ExportPaperFace[] = []
  if (mode === "a5") for (let i = 1; i <= count; i++) faces.push({ panels: [i], sheet: i, side: "single" })
  else if (mode === "spread") for (let i = 1; i <= count; i += 2) faces.push({ panels: [i, page(i + 1)], sheet: faces.length + 1, side: "single" })
  else if (mode === "booklet") {
    const padded = Math.ceil(count / 4) * 4
    for (let k = 0; k < padded / 4; k++) {
      faces.push({ panels: [page(padded - 2 * k), 1 + 2 * k], sheet: k + 1, side: "front" })
      faces.push({ panels: [page(2 + 2 * k), page(padded - 1 - 2 * k)], sheet: k + 1, side: "back" })
    }
  } else fail("EXPORT_OUTPUT_MODE_INVALID")
  const numbers = faces.flatMap(f => f.panels).filter((n): n is number => n !== null).sort((a, b) => a - b)
  if (numbers.length !== count || numbers.some((n, i) => n !== i + 1)) fail("EXPORT_MAPPING_COVERAGE_FAILED")
  return Object.freeze({ mode, logicalPages: count, blankPanels: faces.flatMap(f => f.panels).filter(n => n === null).length,
    paperFaces: faces.length, singleSidedSheets: faces.length, duplexSheets: Math.ceil(faces.length / 2),
    faces: Object.freeze(faces.map(f => Object.freeze({ ...f, panels: Object.freeze(f.panels) }))) })
}
