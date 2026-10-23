import { EXPORT_FONT_CATALOG } from "./exportFontCatalog"
import { ExportSnapshotError } from "./exportSnapshot"

export type ExportFontMode = "wenkai" | "system"
export interface ExportFontLease {
  readonly mode: ExportFontMode; readonly family: string; readonly shardCount: number; readonly uncoveredScalars: number
  release(): void
}
export interface ExportFontFacePort { load(): Promise<unknown> }
export interface ExportFontHost {
  create(family: string, file: string, unicodeRange: string): ExportFontFacePort
  add(face: ExportFontFacePort): void
  remove(face: ExportFontFacePort): void
}
let sequence = 0
/** Exact packaged cmap ranges, not a promise of platform glyph or emoji coverage. */
export function selectExportFontShards(text: string) {
  if (text.length > 6 * 1024 ** 2) throw new ExportSnapshotError("EXPORT_FONT_TEXT_LIMIT")
  const wanted = new Set<number>()
  for (const char of text) { const cp = char.codePointAt(0)!; if (cp >= 32 && cp !== 127) wanted.add(cp) }
  const selected: typeof EXPORT_FONT_CATALOG[number][] = []
  for (const shard of EXPORT_FONT_CATALOG) {
    let used = false
    for (const cp of wanted) if (shard.ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) { used = true; wanted.delete(cp) }
    if (used) selected.push(shard)
  }
  return { shards: selected, uncoveredScalars: wanted.size }
}
/** No CSS swap: load private faces BEFORE registering them under a unique family.
 * On failure/abort/timeout nothing is published; late loads never register a face.
 * System mode is an explicit new request and does not mention any Quire family. */
export async function prepareExportFonts(text: string, mode: ExportFontMode,
  options: { host: ExportFontHost; signal?: AbortSignal; assertCurrent: () => Promise<void>; timeoutMs?: number }): Promise<ExportFontLease> {
  if (mode !== "wenkai" && mode !== "system") throw new ExportSnapshotError("EXPORT_INVALID_FONT_MODE")
  const timeout = options.timeoutMs ?? 20000
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 20000) throw new ExportSnapshotError("EXPORT_FONT_TIMEOUT_INVALID")
  const selection = selectExportFontShards(text), faces: ExportFontFacePort[] = [], added: ExportFontFacePort[] = []
  let released = false, timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  const family = mode === "system" ? "serif" : `Quire Print Session ${++sequence}`
  const release = () => { if (released) return; released = true; for (const face of added.splice(0)) { try { options.host.remove(face) } catch { /* release every face */ } } }
  const check = () => { if (released || options.signal?.aborted) throw new ExportSnapshotError("CANCELLED") }
  const aborted = new Promise<never>((_, reject) => {
    abort = () => { release(); reject(new ExportSnapshotError("CANCELLED")) }
    options.signal?.addEventListener("abort", abort, { once: true })
    timer = setTimeout(() => { release(); reject(new ExportSnapshotError("EXPORT_FONT_TIMEOUT")) }, timeout)
  })
  const work = async () => {
    check(); await options.assertCurrent(); check()
    if (mode === "wenkai") {
      // Four bounded loads at a time; no default request for all 114 shards.
      for (let offset = 0; offset < selection.shards.length; offset += 4) {
        check()
        const group = selection.shards.slice(offset, offset + 4).map(shard => {
          const ranges = shard.ranges.map(([lo, hi]) => `U+${lo.toString(16)}-${hi.toString(16)}`).join(",")
          const face = options.host.create(family, shard.file, ranges); faces.push(face); return face
        })
        await Promise.all(group.map(face => face.load())); check()
        await options.assertCurrent(); check()
      }
    }
    await options.assertCurrent(); check()
    for (const face of faces) { added.push(face); options.host.add(face) }
    return Object.freeze({ mode, family: mode === "system" ? family : `"${family}", serif`,
      shardCount: faces.length, uncoveredScalars: mode === "system" ? 0 : selection.uncoveredScalars, release })
  }
  try { const lease = await Promise.race([work(), aborted]); check(); return lease }
  catch (error) { release(); throw error instanceof ExportSnapshotError ? error : new ExportSnapshotError("EXPORT_FONT_LOAD_FAILED") }
  finally { clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort) }
}
