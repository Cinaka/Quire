import { ExportSnapshotError } from "./exportSnapshot"

/** Production promotion of P6-0 bounded header/serial-decoder contracts.
 * No DB, network, URLs or retained bitmaps. Limits are guards, not device capacity. */
export const RESOURCE_LIMITS = Object.freeze({ imageBytes: 12 * 1024 ** 2, mediaBytes: 64 * 1024 ** 2,
  imagePixels: 8000000, totalPixels: 24000000, dimension: 8192, images: 100,
  decodeConcurrency: 1, stageMs: 20000 })
const fail = (code: string): never => { throw new ExportSnapshotError(code) }
const valid = (n: number): boolean => Number.isSafeInteger(n) && n > 0
export interface ExportImageRecord { readonly id: string; readonly blob: Blob }
export interface ExportImageInfo extends ExportImageRecord { readonly width: number; readonly height: number; readonly pixels: number; readonly mime: string }
export interface ExportImagePlan { readonly items: readonly ExportImageInfo[]; readonly bytes: number; readonly pixels: number }
const approvedPlans = new WeakSet<ExportImagePlan>()
export function assertPixels(width: number, height: number) {
  if (!valid(width) || !valid(height)) fail('INVALID_DIMENSIONS')
  if (width > RESOURCE_LIMITS.dimension || height > RESOURCE_LIMITS.dimension) fail('IMAGE_DIMENSION_LIMIT')
  const pixels = width * height
  if (!Number.isSafeInteger(pixels) || pixels > RESOURCE_LIMITS.imagePixels) fail('IMAGE_PIXEL_LIMIT')
  return pixels
}
// Read bounded bytes before asking the browser decoder to allocate pixels.
// This is not a full image validator: CRC/entropy/EXIF etc. remain decoder work.
export function inspectHeader(buffer: ArrayBuffer, mime: string) {
  const a = new Uint8Array(buffer)
  if (a.byteLength > RESOURCE_LIMITS.imageBytes) fail('IMAGE_BYTE_LIMIT')
  const v = new DataView(a.buffer, a.byteOffset, a.byteLength)
  const need = (offset: number, size: number) => { if (offset < 0 || size < 0 || offset + size > a.length) fail('INVALID_IMAGE_HEADER') }
  const byte = (offset: number): number => { need(offset, 1); return v.getUint8(offset) }
  const word = (offset: number, size: number) => { need(offset, size); return String.fromCharCode(...a.subarray(offset, offset + size)) }
  let width: number | undefined, height: number | undefined
  if (mime === 'image/png') {
    need(0, 33)
    if (byte(0) !== 137 || word(1, 3) !== 'PNG' || word(4, 4) !== '\r\n\x1a\n' || v.getUint32(8) !== 13 || word(12, 4) !== 'IHDR') fail('INVALID_IMAGE_HEADER')
    width = v.getUint32(16); height = v.getUint32(20); assertPixels(width, height)
    let offset = 8, chunks = 0, ended = false
    while (offset < a.length) {
      if (++chunks > 2048) fail('IMAGE_HEADER_WORK_LIMIT')
      need(offset, 12); const length = v.getUint32(offset), type = word(offset + 4, 4); need(offset, length + 12)
      if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('ANIMATED_IMAGE_UNSUPPORTED')
      if (type === 'IHDR' && offset !== 8) fail('INVALID_IMAGE_HEADER')
      offset += length + 12
      if (type === 'IEND') { if (length || offset !== a.length) fail('INVALID_IMAGE_HEADER'); ended = true; break }
    }
    if (!ended) fail('INVALID_IMAGE_HEADER')
  } else if (mime === 'image/jpeg') {
    need(0, 4); if (byte(0) !== 255 || byte(1) !== 216) fail('INVALID_IMAGE_HEADER')
    let offset = 2, segments = 0
    while (offset < a.length) {
      if (++segments > 2048) fail('IMAGE_HEADER_WORK_LIMIT')
      need(offset, 2); if (byte(offset++) !== 255) fail('INVALID_IMAGE_HEADER')
      while (byte(offset) === 255) { offset++; need(offset, 1) }
      const marker = byte(offset++)
      if ([0, 216, 217, 218].includes(marker)) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      need(offset, 2); const length = v.getUint16(offset); if (length < 2) fail('INVALID_IMAGE_HEADER'); need(offset, length)
      if ([192, 193, 194].includes(marker)) { if (length < 8) fail('INVALID_IMAGE_HEADER'); height = v.getUint16(offset + 3); width = v.getUint16(offset + 5); break }
      offset += length
    }
    if (width === undefined) fail('UNSUPPORTED_JPEG_HEADER')
  } else if (mime === 'image/webp') {
    need(0, 20); if (word(0, 4) !== 'RIFF' || word(8, 4) !== 'WEBP' || v.getUint32(4, true) + 8 !== a.length) fail('INVALID_IMAGE_HEADER')
    let offset = 12, chunks = 0, canvas: [number, number] | undefined, frame: [number, number] | undefined
    while (offset < a.length) {
      if (++chunks > 2048) fail('IMAGE_HEADER_WORK_LIMIT')
      need(offset, 8); const type = word(offset, 4), length = v.getUint32(offset + 4, true), p = offset + 8; need(p, length)
      if (['ANIM', 'ANMF'].includes(type)) fail('ANIMATED_IMAGE_UNSUPPORTED')
      if (type === 'VP8X') {
        if (canvas || length !== 10) fail('INVALID_IMAGE_HEADER')
        if (byte(p) & 2) fail('ANIMATED_IMAGE_UNSUPPORTED')
        const u24 = (i: number) => byte(i) + 256 * byte(i + 1) + 65536 * byte(i + 2)
        canvas = [u24(p + 4) + 1, u24(p + 7) + 1]; assertPixels(canvas[0], canvas[1])
      } else if (type === 'VP8 ') {
        if (frame || length < 10 || (byte(p) & 1) || word(p + 3, 3) !== '\x9d\x01\x2a') fail('INVALID_IMAGE_HEADER')
        frame = [v.getUint16(p + 6, true) & 16383, v.getUint16(p + 8, true) & 16383]
      } else if (type === 'VP8L') {
        if (frame || length < 5 || byte(p) !== 47) fail('INVALID_IMAGE_HEADER')
        const bits = v.getUint32(p + 1, true); frame = [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1]
      }
      offset = p + length + (length & 1); need(offset, 0)
    }
    if (!frame || (canvas && (canvas[0] !== frame[0] || canvas[1] !== frame[1]))) throw new ExportSnapshotError('INVALID_IMAGE_HEADER')
    ;[width, height] = frame
  } else fail('UNSUPPORTED_IMAGE_TYPE') // GIF/SVG/animation are explicit blockers, not omitted content.
  if (width === undefined || height === undefined) throw new ExportSnapshotError("INVALID_IMAGE_HEADER")
  return Object.freeze({ width, height, pixels: assertPixels(width, height), mime })
}

function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) fail("CANCELLED") }
export async function preflightImages(records: readonly ExportImageRecord[], { signal, assertCurrent = async () => {} }:
  { signal?: AbortSignal; assertCurrent?: () => Promise<void> } = {}): Promise<ExportImagePlan> {
  if (!Array.isArray(records) || records.length > 20000) fail("IMAGE_REFERENCE_LIMIT")
  const seen = new Map<string, Blob>(), unique: ExportImageRecord[] = []
  let bytes = 0, pixels = 0
  const began = performance.now()
  const check = () => { checkSignal(signal); if (performance.now() - began > RESOURCE_LIMITS.stageMs) fail("MEDIA_PREFLIGHT_TIMEOUT") }
  for (const record of records) {
    check()
    if (typeof record?.id !== "string" || !record.id || record.id.length > 128 || !(record.blob instanceof Blob)) fail("INVALID_IMAGE_REFERENCE")
    if (seen.has(record.id)) { if (seen.get(record.id) !== record.blob) fail("AMBIGUOUS_IMAGE_REFERENCE"); continue }
    seen.set(record.id, record.blob); unique.push({ id: record.id, blob: record.blob })
    if (unique.length > RESOURCE_LIMITS.images) fail("IMAGE_COUNT_LIMIT")
    if (!record.blob.size || record.blob.size > RESOURCE_LIMITS.imageBytes) fail("IMAGE_BYTE_LIMIT")
    if (!["image/png", "image/jpeg", "image/webp"].includes(record.blob.type.toLowerCase())) fail("UNSUPPORTED_IMAGE_TYPE")
    bytes += record.blob.size; if (bytes > RESOURCE_LIMITS.mediaBytes) fail("MEDIA_BYTE_LIMIT")
  }
  const items: ExportImageInfo[] = []
  for (const record of unique) {
    check(); await assertCurrent(); check()
    const buffer = await record.blob.arrayBuffer(); check(); await assertCurrent(); check()
    const header = inspectHeader(buffer, record.blob.type.toLowerCase())
    pixels += header.pixels; if (pixels > RESOURCE_LIMITS.totalPixels) fail("TOTAL_PIXEL_LIMIT")
    items.push(Object.freeze({ id: record.id, blob: record.blob, ...header }))
  }
  check(); await assertCurrent(); check()
  const result: ExportImagePlan = Object.freeze({ items: Object.freeze(items), bytes, pixels })
  approvedPlans.add(result); return result
}
/** Derived single-item view of a fully budgeted branded plan; cannot forge approval. */
export function selectExportImagePlan(plan: ExportImagePlan, id: string): ExportImagePlan {
  if (!approvedPlans.has(plan)) fail("UNVERIFIED_IMAGE_PLAN")
  const item = plan.items.find(item => item.id === id)
  if (!item) throw new ExportSnapshotError("EXPORT_LAYOUT_IMAGE_MISSING")
  const selected = Object.freeze({ items: Object.freeze([item]), bytes: item.blob.size, pixels: item.pixels })
  approvedPlans.add(selected); return selected
}
export interface ExportBitmap { readonly width: number; readonly height: number; close(): void }
export type ExportDecode = (blob: Blob) => Promise<ExportBitmap>
async function decodeExportBitmap(blob: Blob): Promise<ExportBitmap> {
  if (typeof createImageBitmap !== "function") throw new ExportSnapshotError("IMAGE_DECODE_UNAVAILABLE")
  return createImageBitmap(blob)
}
/** Shared across replacement jobs. A cancelled native decode retains its only slot
 * until the late bitmap is closed. Neither abort nor timeout hard-stops the browser. */
export class SerialImageDecoder {
  #busy = false
  get busy(): boolean { return this.#busy }
  /** Explicit HTML-image preparation shares the native slot with ImageBitmap.
   * DOM/URL ownership stays with the layout lease, NOT a pretend bitmap.close().
   * Browser painting/caches are not measurable or hard-cancellable through this API. */
  async verifyDomImage(plan: ExportImagePlan, options: { signal?: AbortSignal; load: () => Promise<{ width: number; height: number }>; discard: () => void; assertCurrent: () => Promise<void>; timeoutMs?: number }): Promise<{ width: number; height: number }> {
    if (this.#busy) fail("DECODER_BUSY")
    if (!approvedPlans.has(plan) || plan.items.length !== 1) fail("UNVERIFIED_IMAGE_PLAN")
    const timeout = options.timeoutMs ?? RESOURCE_LIMITS.stageMs
    if (!valid(timeout) || timeout > RESOURCE_LIMITS.stageMs) fail("INVALID_DECODE_TIMEOUT")
    checkSignal(options.signal); this.#busy = true
    const deadline = performance.now() + timeout
    let detached = false, settled = false, timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    const raw = Promise.resolve().then(async () => { await options.assertCurrent(); checkSignal(options.signal); return options.load() })
    void raw.then(() => { settled = true }, () => { settled = true })
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(new ExportSnapshotError("CANCELLED"))
      options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort()
      timer = setTimeout(() => reject(new ExportSnapshotError("DECODE_TIMEOUT")), timeout)
    })
    try {
      const size = await Promise.race([raw, stopped]); checkSignal(options.signal)
      assertPixels(size.width, size.height)
      const item = plan.items[0]!, same = size.width === item.width && size.height === item.height
      if (!same && !(item.mime === "image/jpeg" && size.width === item.height && size.height === item.width)) fail("DECODE_DIMENSION_MISMATCH")
      await options.assertCurrent(); checkSignal(options.signal)
      if (performance.now() > deadline) fail("DECODE_TIMEOUT")
      return Object.freeze({ width: size.width, height: size.height })
    } catch (error) {
      try { options.discard() } catch { /* still release slot */ }
      if (!settled) {
        detached = true
        void raw.then(() => { try { options.discard() } finally { this.#busy = false } }, () => { this.#busy = false }).catch(() => {})
      }
      throw error instanceof ExportSnapshotError ? error : new ExportSnapshotError("IMAGE_DECODE_FAILED")
    } finally { clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort); if (!detached) this.#busy = false }
  }
  async run(plan: ExportImagePlan, { signal, decode = decodeExportBitmap, assertCurrent = async () => {}, timeoutMs = RESOURCE_LIMITS.stageMs }:
    { signal?: AbortSignal; decode?: ExportDecode; assertCurrent?: () => Promise<void>; timeoutMs?: number } = {}): Promise<{ completed: number; concurrency: 1 }> {
    if (this.#busy) fail("DECODER_BUSY")
    if (!approvedPlans.has(plan)) fail("UNVERIFIED_IMAGE_PLAN")
    if (!valid(timeoutMs) || timeoutMs > RESOURCE_LIMITS.stageMs) fail("INVALID_DECODE_TIMEOUT")
    checkSignal(signal); this.#busy = true
    let detached = false, completed = 0
    const deadline = performance.now() + timeoutMs
    try {
      for (const item of plan.items) {
        await assertCurrent(); checkSignal(signal)
        const remaining = deadline - performance.now(); if (remaining <= 0) fail("DECODE_TIMEOUT")
        let consumed = false
        let bitmap: ExportBitmap | undefined, timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined
        const raw = Promise.resolve().then(() => { checkSignal(signal); return decode(item.blob) })
        const stopped = new Promise<never>((_, reject) => {
          onAbort = () => reject(new ExportSnapshotError("CANCELLED"))
          signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort()
          timer = setTimeout(() => reject(new ExportSnapshotError("DECODE_TIMEOUT")), remaining)
        })
        try {
          bitmap = await Promise.race([raw, stopped]); checkSignal(signal)
          if (performance.now() > deadline) fail("DECODE_TIMEOUT")
          if (!bitmap || !valid(bitmap.width) || !valid(bitmap.height) || typeof bitmap.close !== "function") fail("INVALID_BITMAP")
          assertPixels(bitmap.width, bitmap.height)
          const same = bitmap.width === item.width && bitmap.height === item.height
          const rotated = item.mime === "image/jpeg" && bitmap.width === item.height && bitmap.height === item.width
          if (!same && !rotated) fail("DECODE_DIMENSION_MISMATCH")
          // No consumer retains pixels. Close BEFORE another auth await or decode.
          bitmap.close(); consumed = true; bitmap = undefined
          await assertCurrent(); checkSignal(signal)
          if (performance.now() > deadline) fail("DECODE_TIMEOUT")
          completed++
        } catch (error) {
          if (!bitmap && !consumed) {
            detached = true
            void raw.then(late => { try { late?.close?.() } finally { this.#busy = false } }, () => { this.#busy = false }).catch(() => {})
          }
          throw error instanceof ExportSnapshotError ? error : new ExportSnapshotError("IMAGE_DECODE_FAILED")
        } finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); bitmap?.close?.() }
      }
      return { completed, concurrency: 1 }
    } finally { if (!detached) this.#busy = false }
  }
}
/** Per-realm production queue; never recreate it per task or on cancellation. */
export const exportImageDecoder = new SerialImageDecoder()
