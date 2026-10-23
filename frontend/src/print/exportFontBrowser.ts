import { prepareExportFonts, type ExportFontFacePort, type ExportFontHost, type ExportFontMode } from "../shared/exportFontReadiness"
import { ExportSnapshotError } from "../shared/exportSnapshot"
// URL strings only, not eager font requests. This adapter is imported by the
// print pipeline on demand, never by ordinary list, homepage or P5 CSS.
const assets = import.meta.glob<string>("../assets/fonts/notebook/*.woff2", { eager: true, query: "?url&no-inline", import: "default" })
export function prepareBrowserExportFonts(text: string, mode: ExportFontMode,
  options: { signal?: AbortSignal; assertCurrent: () => Promise<void> }) {
  if (mode === "wenkai" && (typeof FontFace === "undefined" || !document.fonts)) throw new ExportSnapshotError("EXPORT_FONT_API_UNAVAILABLE")
  const host: ExportFontHost = {
    create(family, file, unicodeRange) {
      const url = assets[`../assets/fonts/notebook/${file}`]
      if (!url) throw new ExportSnapshotError("EXPORT_FONT_ASSET_MISSING")
      return new FontFace(family, `url(${JSON.stringify(url)}) format("woff2")`, { style: "normal", weight: "400", unicodeRange, display: "block" })
    },
    add(face: ExportFontFacePort) { document.fonts.add(face as FontFace) },
    remove(face: ExportFontFacePort) { document.fonts.delete(face as FontFace) },
  }
  return prepareExportFonts(text, mode, { ...options, host })
}
