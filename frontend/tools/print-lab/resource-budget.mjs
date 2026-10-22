// P6-0 experiments only; no production imports or DB access.
import { LIMITS, PrintLabError } from './print-guards.mjs'
export const RESOURCE_LIMITS = Object.freeze({ imageBytes: 12 * 1024 ** 2, imagePixels: 8000000, totalPixels: 24000000, dimension: 8192, images: 100, decodeConcurrency: 1, depth: 64, stageMs: 20000 })
const approvedPlans = new WeakSet()
const fail = code => { throw new PrintLabError(code) }
const valid = n => Number.isSafeInteger(n) && n > 0
export function assertPixels(width, height) {
  if (!valid(width) || !valid(height)) fail('INVALID_DIMENSIONS')
  if (width > RESOURCE_LIMITS.dimension || height > RESOURCE_LIMITS.dimension) fail('IMAGE_DIMENSION_LIMIT')
  const pixels = width * height
  if (!Number.isSafeInteger(pixels) || pixels > RESOURCE_LIMITS.imagePixels) fail('IMAGE_PIXEL_LIMIT')
  return pixels
}
// Read bounded bytes before asking the browser decoder to allocate pixels.
// This is not a full image validator: CRC/entropy/EXIF etc. remain decoder work.
export function inspectHeader(buffer, mime) {
  const a = new Uint8Array(buffer)
  if (a.byteLength > RESOURCE_LIMITS.imageBytes) fail('IMAGE_BYTE_LIMIT')
  const v = new DataView(a.buffer, a.byteOffset, a.byteLength)
  const need = (offset, size) => { if (offset < 0 || size < 0 || offset + size > a.length) fail('INVALID_IMAGE_HEADER') }
  const word = (offset, size) => { need(offset, size); return String.fromCharCode(...a.subarray(offset, offset + size)) }
  let width, height
  if (mime === 'image/png') {
    need(0, 33)
    if (a[0] !== 137 || word(1, 3) !== 'PNG' || word(4, 4) !== '\r\n\x1a\n' || v.getUint32(8) !== 13 || word(12, 4) !== 'IHDR') fail('INVALID_IMAGE_HEADER')
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
    need(0, 4); if (a[0] !== 255 || a[1] !== 216) fail('INVALID_IMAGE_HEADER')
    let offset = 2, segments = 0
    while (offset < a.length) {
      if (++segments > 2048) fail('IMAGE_HEADER_WORK_LIMIT')
      need(offset, 2); if (a[offset++] !== 255) fail('INVALID_IMAGE_HEADER')
      while (a[offset] === 255) { offset++; need(offset, 1) }
      const marker = a[offset++]
      if ([0, 216, 217, 218].includes(marker)) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      need(offset, 2); const length = v.getUint16(offset); if (length < 2) fail('INVALID_IMAGE_HEADER'); need(offset, length)
      if ([192, 193, 194].includes(marker)) { if (length < 8) fail('INVALID_IMAGE_HEADER'); height = v.getUint16(offset + 3); width = v.getUint16(offset + 5); break }
      offset += length
    }
    if (width === undefined) fail('UNSUPPORTED_JPEG_HEADER')
  } else if (mime === 'image/webp') {
    need(0, 20); if (word(0, 4) !== 'RIFF' || word(8, 4) !== 'WEBP' || v.getUint32(4, true) + 8 !== a.length) fail('INVALID_IMAGE_HEADER')
    let offset = 12, chunks = 0, canvas, frame
    while (offset < a.length) {
      if (++chunks > 2048) fail('IMAGE_HEADER_WORK_LIMIT')
      need(offset, 8); const type = word(offset, 4), length = v.getUint32(offset + 4, true), p = offset + 8; need(p, length)
      if (['ANIM', 'ANMF'].includes(type)) fail('ANIMATED_IMAGE_UNSUPPORTED')
      if (type === 'VP8X') {
        if (canvas || length !== 10) fail('INVALID_IMAGE_HEADER')
        if (a[p] & 2) fail('ANIMATED_IMAGE_UNSUPPORTED')
        const u24 = i => a[i] + 256 * a[i + 1] + 65536 * a[i + 2]
        canvas = [u24(p + 4) + 1, u24(p + 7) + 1]; assertPixels(...canvas)
      } else if (type === 'VP8 ') {
        if (frame || length < 10 || (a[p] & 1) || word(p + 3, 3) !== '\x9d\x01\x2a') fail('INVALID_IMAGE_HEADER')
        frame = [v.getUint16(p + 6, true) & 16383, v.getUint16(p + 8, true) & 16383]
      } else if (type === 'VP8L') {
        if (frame || length < 5 || a[p] !== 47) fail('INVALID_IMAGE_HEADER')
        const bits = v.getUint32(p + 1, true); frame = [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1]
      }
      offset = p + length + (length & 1); need(offset, 0)
    }
    if (!frame || (canvas && (canvas[0] !== frame[0] || canvas[1] !== frame[1]))) fail('INVALID_IMAGE_HEADER')
    ;[width, height] = frame
  } else fail('UNSUPPORTED_IMAGE_TYPE') // GIF/SVG/animation are explicit blockers, not omitted content.
  return Object.freeze({ width, height, pixels: assertPixels(width, height), mime })
}
const checkSignal = signal => { if (signal?.aborted) fail('CANCELLED') }
export async function preflightImages(records, { signal } = {}) {
  if (!Array.isArray(records) || records.length > 20000) fail('IMAGE_REFERENCE_LIMIT')
  const seen = new Map(), unique = []; let bytes = 0, pixels = 0
  const began = performance.now(), check = () => { checkSignal(signal); if (performance.now() - began > RESOURCE_LIMITS.stageMs) fail('MEDIA_PREFLIGHT_TIMEOUT') }
  for (const record of records) {
    check()
    if (typeof record?.id !== 'string' || !record.id || record.id.length > 128 || !(record.blob instanceof Blob)) fail('INVALID_IMAGE_REFERENCE')
    if (seen.has(record.id)) { if (seen.get(record.id) !== record.blob) fail('AMBIGUOUS_IMAGE_REFERENCE'); continue }
    seen.set(record.id, record.blob); unique.push(Object.freeze({ id: record.id, blob: record.blob }))
    if (unique.length > RESOURCE_LIMITS.images) fail('IMAGE_COUNT_LIMIT')
    if (!record.blob.size || record.blob.size > RESOURCE_LIMITS.imageBytes) fail('IMAGE_BYTE_LIMIT')
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(record.blob.type)) fail('UNSUPPORTED_IMAGE_TYPE')
    bytes += record.blob.size; if (bytes > LIMITS.mediaBytes) fail('MEDIA_BYTE_LIMIT')
  }
  const plan = []
  for (const record of unique) {
    check()
    const buffer = await record.blob.arrayBuffer(); check()
    const header = inspectHeader(buffer, record.blob.type)
    pixels += header.pixels; if (pixels > RESOURCE_LIMITS.totalPixels) fail('TOTAL_PIXEL_LIMIT')
    plan.push(Object.freeze({ id: record.id, blob: record.blob, ...header }))
  }
  const result = Object.freeze({ items: Object.freeze(plan), bytes, pixels }); approvedPlans.add(result); return result
}
// One queue instance must be shared across replacement tasks. An uncancellable native
// decode keeps the slot until its late bitmap is closed; cancellation never frees it early.
export class SerialImageDecoder {
  #busy = false
  get busy() { return this.#busy }
  async run(plan, { signal, decode = blob => createImageBitmap(blob), onDecoded = () => {}, timeoutMs = RESOURCE_LIMITS.stageMs } = {}) {
    if (this.#busy) fail('DECODER_BUSY')
    if (!approvedPlans.has(plan)) fail('UNVERIFIED_IMAGE_PLAN')
    if (!valid(timeoutMs) || timeoutMs > RESOURCE_LIMITS.stageMs) fail('INVALID_DECODE_TIMEOUT')
    checkSignal(signal); this.#busy = true
    let detached = false, completed = 0
    const deadline = performance.now() + timeoutMs
    try {
      for (const item of plan.items) {
        checkSignal(signal)
        const remaining = deadline - performance.now(); if (remaining <= 0) fail('DECODE_TIMEOUT')
        let bitmap, timer, onAbort
        const raw = Promise.resolve().then(() => decode(item.blob))
        const stopped = new Promise((_, reject) => {
          onAbort = () => reject(new PrintLabError('CANCELLED'))
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
          timer = setTimeout(() => reject(new PrintLabError('DECODE_TIMEOUT')), remaining)
        })
        try {
          bitmap = await Promise.race([raw, stopped]); checkSignal(signal)
          if (performance.now() > deadline) fail('DECODE_TIMEOUT')
          if (!bitmap || !valid(bitmap.width) || !valid(bitmap.height) || typeof bitmap.close !== 'function') fail('INVALID_BITMAP')
          assertPixels(bitmap.width, bitmap.height)
          const same = bitmap.width === item.width && bitmap.height === item.height
          const rotated = item.mime === 'image/jpeg' && bitmap.width === item.height && bitmap.height === item.width
          if (!same && !rotated) fail('DECODE_DIMENSION_MISMATCH')
          // Synchronous, scoped consumer: must not retain the bitmap or start another decode.
          onDecoded(bitmap, item); checkSignal(signal); if (performance.now() > deadline) fail('DECODE_TIMEOUT'); completed++
        } catch (error) {
          if (!bitmap) {
            detached = true
            raw.then(late => late?.close?.(), () => {}).finally(() => { this.#busy = false }).catch(() => {})
          }
          throw error instanceof PrintLabError ? error : new PrintLabError('IMAGE_DECODE_FAILED')
        } finally {
          clearTimeout(timer); signal?.removeEventListener('abort', onAbort); bitmap?.close?.()
        }
      }
      return { completed, concurrency: 1 }
    } finally { if (!detached) this.#busy = false }
  }
}
// Count bounded JSON UTF-8 without stringify/full-string encoding copies. This measures
// already-loaded data; it does not make loading an unbounded DB row itself safe.
export async function inspectDocuments(documents, { signal, now = () => performance.now(), yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  if (!Array.isArray(documents) || documents.length > LIMITS.entries) fail('ENTRY_COUNT_LIMIT')
  let bytes = 0, nodes = 0, yields = 0, last = now(); const began = last, ancestors = new Set()
  function* stringBytes(s) {
    yield 1; let n = 0, processed = 0
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) n += 2
      else if (c < 32) n += 6
      else if (c < 128) n++
      else if (c < 2048) n += 2
      else if (c >= 0xD800 && c <= 0xDBFF) {
        const d = s.charCodeAt(i + 1)
        if (d >= 0xDC00 && d <= 0xDFFF) { n += 4; i++ } else n += 6
      } else if (c >= 0xDC00 && c <= 0xDFFF) n += 6
      else n += 3
      if (++processed >= 4096) { yield n; n = 0; processed = 0 }
    }
    yield n + 1
  }
  function* visit(value, depth) {
    if (++nodes > LIMITS.nodes) fail('DOCUMENT_NODE_LIMIT')
    if (depth > RESOURCE_LIMITS.depth) fail('DOCUMENT_DEPTH_LIMIT')
    if (typeof value === 'string') { if (value.length > LIMITS.textBytes - bytes) fail('DOCUMENT_BYTE_LIMIT'); yield* stringBytes(value); return }
    if (value === null) { yield 4; return }
    if (typeof value === 'boolean') { yield value ? 4 : 5; return }
    if (typeof value === 'number' && Number.isFinite(value)) { yield String(value).length; return }
    if (!value || typeof value !== 'object') fail('UNSUPPORTED_JSON_VALUE')
    if (ancestors.has(value)) fail('CYCLIC_DOCUMENT')
    const array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('UNSUPPORTED_JSON_VALUE')
    if (array && value.length > LIMITS.nodes) fail('DOCUMENT_NODE_LIMIT')
    ancestors.add(value); yield 1; let first = true
    try {
      if (array) {
        for (let i = 0; i < value.length; i++) {
          const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d)) fail('UNSUPPORTED_JSON_VALUE')
          if (!first) yield 1; first = false; yield* visit(d.value, depth + 1)
        }
      } else {
        for (const key in value) if (Object.hasOwn(value, key)) {
          const d = Object.getOwnPropertyDescriptor(value, key); if (!d || !('value' in d)) fail('UNSUPPORTED_JSON_VALUE')
          if (!first) yield 1; first = false; yield* stringBytes(key); yield 1; yield* visit(d.value, depth + 1)
        }
      }
    } finally { ancestors.delete(value) }
    yield 1
  }
  for (const doc of documents) for (const amount of visit(doc, 0)) {
    checkSignal(signal); bytes += amount; if (bytes > LIMITS.textBytes) fail('DOCUMENT_BYTE_LIMIT')
    if (now() - began > RESOURCE_LIMITS.stageMs) fail('DOCUMENT_TIME_LIMIT')
    if (now() - last >= 8) { await yieldTask(); yields++; checkSignal(signal); last = now() }
  }
  checkSignal(signal); if (now() - began > RESOURCE_LIMITS.stageMs) fail('DOCUMENT_TIME_LIMIT')
  return { entries: documents.length, bytes, nodes, yields }
}
