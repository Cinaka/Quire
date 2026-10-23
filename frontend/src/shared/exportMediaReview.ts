import { ExportSnapshotError } from "./exportSnapshot"
import { RESOURCE_LIMITS, preflightImages, exportImageDecoder, type ExportImagePlan, type ExportImageRecord, type ExportImageInfo, type ExportDecode, type SerialImageDecoder } from "./exportImageResources"

/** These failures concern one image only. Cancellation, identity, queue busy,
 * aggregate budgets/timeouts, allocation/read failures and unknown errors STOP. */
export const EXPORT_IMAGE_PLACEHOLDER_CODES = Object.freeze([
  "INVALID_IMAGE_HEADER", "UNSUPPORTED_JPEG_HEADER", "UNSUPPORTED_IMAGE_TYPE", "ANIMATED_IMAGE_UNSUPPORTED",
  "INVALID_DIMENSIONS", "IMAGE_DIMENSION_LIMIT", "IMAGE_PIXEL_LIMIT", "IMAGE_DECODE_FAILED", "INVALID_BITMAP", "DECODE_DIMENSION_MISMATCH",
] as const)
export type ExportImageIssueCode = typeof EXPORT_IMAGE_PLACEHOLDER_CODES[number]
export interface ExportImageIssue { readonly code: ExportImageIssueCode; readonly resourceId: string }
export interface ExportMediaReview { readonly images: ExportImagePlan; readonly issues: readonly ExportImageIssue[] }
const fail = (code: string): never => { throw new ExportSnapshotError(code) }
const perImage = (error: unknown): error is ExportSnapshotError & { code: ExportImageIssueCode } =>
  error instanceof ExportSnapshotError && (EXPORT_IMAGE_PLACEHOLDER_CODES as readonly string[]).includes(error.code)

/** Outside-transaction only. All byte/count/header/pixel checks precede ANY decode.
 * Broken/unsupported individual resources yield explicit placeholders, never silent
 * omission. Aggregate budgets are not bypassed by calling this in degraded mode. */
export async function reviewExportImages(records: readonly ExportImageRecord[], options:
  { signal?: AbortSignal; assertCurrent: () => Promise<void>; decoder?: SerialImageDecoder; decode?: ExportDecode; now?: () => number }): Promise<ExportMediaReview> {
  const now = options.now ?? (() => performance.now()), decoder = options.decoder ?? exportImageDecoder
  let stageStart = now()
  const check = (code: string) => {
    if (options.signal?.aborted) fail("CANCELLED")
    if (now() - stageStart > RESOURCE_LIMITS.stageMs) fail(code)
  }
  // Detach IDs and immutable byte references before awaiting; count all unique bytes,
  // including an image later diagnosed as broken. Do not retry a failed decode.
  if (!Array.isArray(records) || records.length > 20000) fail("IMAGE_REFERENCE_LIMIT")
  const seen = new Map<string, Blob>(), unique: ExportImageRecord[] = []
  let bytes = 0, pixels = 0
  for (const record of records) {
    check("MEDIA_PREFLIGHT_TIMEOUT")
    if (typeof record?.id !== "string" || !record.id || record.id.length > 128 || !(record.blob instanceof Blob)) fail("INVALID_IMAGE_REFERENCE")
    if (seen.has(record.id)) { if (seen.get(record.id) !== record.blob) fail("AMBIGUOUS_IMAGE_REFERENCE"); continue }
    seen.set(record.id, record.blob); unique.push({ id: record.id, blob: record.blob })
    if (unique.length > RESOURCE_LIMITS.images) fail("IMAGE_COUNT_LIMIT")
    if (!record.blob.size || record.blob.size > RESOURCE_LIMITS.imageBytes) fail("IMAGE_BYTE_LIMIT")
    bytes += record.blob.size; if (bytes > RESOURCE_LIMITS.mediaBytes) fail("MEDIA_BYTE_LIMIT")
  }
  const plans: ExportImagePlan[] = [], issues: ExportImageIssue[] = [], passed: ExportImageInfo[] = []
  const note = (resourceId: string, error: ExportSnapshotError & { code: ExportImageIssueCode }) => { issues.push(Object.freeze({ resourceId, code: error.code })) }
  for (const record of unique) {
    check("MEDIA_PREFLIGHT_TIMEOUT")
    // Identity failures are NOT converted into an image diagnostic.
    await options.assertCurrent(); check("MEDIA_PREFLIGHT_TIMEOUT")
    try {
      const plan = await preflightImages([record], { signal: options.signal, assertCurrent: options.assertCurrent })
      check("MEDIA_PREFLIGHT_TIMEOUT")
      pixels += plan.pixels
      if (pixels > RESOURCE_LIMITS.totalPixels) throw new ExportSnapshotError("TOTAL_PIXEL_LIMIT")
      plans.push(plan)
    } catch (error) { if (!perImage(error)) throw error; note(record.id, error) }
  }
  check("MEDIA_PREFLIGHT_TIMEOUT"); await options.assertCurrent(); check("MEDIA_PREFLIGHT_TIMEOUT")
  stageStart = now()
  for (const plan of plans) {
    check("DECODE_TIMEOUT"); await options.assertCurrent(); check("DECODE_TIMEOUT")
    const remaining = Math.floor(RESOURCE_LIMITS.stageMs - (now() - stageStart))
    if (remaining <= 0) fail("DECODE_TIMEOUT")
    try {
      await decoder.run(plan, { signal: options.signal, assertCurrent: options.assertCurrent,
        timeoutMs: Math.min(RESOURCE_LIMITS.stageMs, remaining), ...(options.decode ? { decode: options.decode } : {}) })
      check("DECODE_TIMEOUT"); passed.push(...plan.items)
    } catch (error) {
      if (!perImage(error)) throw error
      const item = plan.items[0]
      if (!item) throw new ExportSnapshotError("INVALID_IMAGE_REFERENCE")
      note(item.id, error)
      // Native rejection releases its slot in the decoder's own settlement handler.
      // Yield a microtask; never force-clear/recreate the queue or wait on a timeout.
      await Promise.resolve()
    }
  }
  check("DECODE_TIMEOUT"); await options.assertCurrent(); check("DECODE_TIMEOUT")
  // Presentation metadata only; unlike individual plans this aggregate is not a
  // branded decoder capability and cannot be fed back to run() to skip preflight.
  return Object.freeze({ images: Object.freeze({ items: Object.freeze(passed), bytes, pixels }), issues: Object.freeze(issues) })
}
