import { paginateExportA5, type ExportA5Source, type ExportA5Layout } from "./exportA5"
import { settleExportToc, mapExportPages, EXPORT_BOOK_LIMITS, type ExportOutputMode } from "../shared/exportBookRules"
import { ExportSnapshotError } from "../shared/exportSnapshot"
const fail = (code: string): never => { throw new ExportSnapshotError(code) }
const el = (tag: string, text?: string, cls?: string) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n }
/** Assemble the same measured body DOM; never clone pages/images or recapture data.
 * Cover/TOC are text-only. Full output capability remains a P6-3 concern. */
export async function prepareExportBook(source: ExportA5Source, host: HTMLElement, options: { signal?: AbortSignal; mode?: ExportOutputMode } = {}) {
  if (!host.isConnected) fail("EXPORT_MEASURE_HOST_DETACHED")
  const controller = new AbortController(), stage = el("div"), extra = el("div", undefined, "quire-print-root")
  stage.style.cssText = "position:absolute;left:-30000px;top:0;opacity:0;pointer-events:none"; host.append(stage); stage.append(extra)
  let disposed = false, body: ExportA5Layout | undefined, stop: (() => void) | undefined, mappingVersion = 0
  const allPages: HTMLElement[] = [], release = () => {
    if (disposed) return; disposed = true; mappingVersion++; controller.abort(); stop?.(); options.signal?.removeEventListener("abort", release)
    for (const page of allPages) page.replaceChildren()
    body?.release(); extra.replaceChildren(); stage.remove()
  }
  stop = source.subscribeReleased(release); if (disposed) stop()
  options.signal?.addEventListener("abort", release, { once: true })
  const check = () => { if (disposed || options.signal?.aborted) fail("CANCELLED") }
  const initial = await Promise.resolve().then(() => source.read()).catch(error => { release(); throw error })
  const current = async () => { check(); const value = await source.read(); check(); if (value.document !== initial.document || value.font.family !== initial.font.family || value.font.mode !== initial.font.mode) fail("EXPORT_LAYOUT_SOURCE_CHANGED") }
  const fits = (paper: HTMLElement) => { const b = paper.querySelector<HTMLElement>(".p6-body")!, r = b.getBoundingClientRect(), last = b.lastElementChild?.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!last || last.bottom <= r.bottom - .5) && b.scrollWidth <= b.clientWidth + 1 && b.scrollHeight <= b.clientHeight + 1 }
  const sheet = (heading?: string) => { const p = el("section", undefined, "p6-sheet"), b = el("div", undefined, "p6-body"); p.append(b); extra.append(p); if (heading) b.append(el("h2", heading)); return p }
  const content = (p: HTMLElement) => p.querySelector<HTMLElement>(".p6-body")!
  const folio = (p: HTMLElement, n: number) => { let f = p.querySelector<HTMLElement>(".p6-folio"); if (!f) { f = el("div", undefined, "p6-folio"); p.append(f) } f.textContent = String(n); p.dataset.logicalPage = String(n) }
  const pause = async () => { check(); await new Promise<void>(resolve => setTimeout(resolve, 0)); await current(); check() }
  try {
    check(); body = await paginateExportA5(source, stage, { signal: controller.signal }); check(); await current()
    extra.style.fontFamily = initial.font.family
    const entries = initial.document.entries
    if (!entries.length || entries.length !== body.bodyStarts.length) fail("EXPORT_BOOK_ENTRIES_INVALID")
    const cover = sheet(); cover.classList.add("p6-cover"); cover.dataset.logicalPage = "1"
    content(cover).append(el("p", "QUIRE / PRINT", "p6-brand"), el("h1", initial.document.bookTitle), el("p", "一编青简，半生浮沉。"),
      el("p", `${entries[0]!.entryDate} — ${entries.at(-1)!.entryDate}`), el("p", `${entries.length} 篇`), el("p", "本机已保存内容的编排快照", "p6-cover-note"))
    if (initial.document.contentMode === "degraded") content(cover).append(el("p", "部分图片以占位呈现", "p6-cover-note"))
    if (!fits(cover)) fail("EXPORT_COVER_DOES_NOT_FIT")
    const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" })
    const titles = entries.map(e => {
      const title = e.title || "无题"
      if (title.length > EXPORT_BOOK_LIMITS.titleUnits) fail("EXPORT_TOC_TITLE_LIMIT")
      const offsets = [...segmenter.segment(title)].map(part => part.index); offsets.push(title.length)
      return { title, offsets }
    })
    let toc: HTMLElement[] = [], began = performance.now()
    const tocCheck = () => { check(); if (performance.now() - began > EXPORT_BOOK_LIMITS.stageMs) fail("EXPORT_TOC_TIMEOUT") }
    const convergence = await settleExportToc(body.bodyStarts, body.pages.length, async labels => {
      for (const p of toc) { p.replaceChildren(); p.remove() }; toc = []
      const newPage = () => { tocCheck(); if (1 + toc.length + 1 + body!.pages.length > EXPORT_BOOK_LIMITS.pages) fail("EXPORT_PAGE_LIMIT"); const p = sheet(toc.length ? "目录 · 续" : "目录"); toc.push(p); return p }
      let paper = newPage()
      for (const [i, entry] of entries.entries()) {
        const { title, offsets } = titles[i]!, units = offsets.length - 1; let start = 0
        while (start < units) {
          tocCheck()
          const row = el("div", undefined, "p6-toc-row"), text = el("div"), date = el("p", start ? "续" : entry.entryDate, "p6-toc-date"), name = el("span"), number = el("span", String(labels[i]), "p6-toc-number")
          text.append(date, name); row.append(text, number); row.dataset.entryIndex = String(i); row.dataset.titleFrom = String(offsets[start]); content(paper).append(row)
          let lo = 0, hi = Math.min(units - start, 8192)
          while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); name.textContent = title.slice(offsets[start], offsets[start + mid]); if (fits(paper)) lo = mid; else hi = mid - 1 }
          if (!lo) { row.remove(); if (content(paper).children.length === 1) fail("EXPORT_TOC_FRAGMENT_DOES_NOT_FIT"); paper = newPage(); continue }
          name.textContent = title.slice(offsets[start], offsets[start + lo]); row.dataset.titleTo = String(offsets[start + lo]); name.className = "p6-toc-title"; start += lo
          // The dedicated number column must never wrap or alter row height.
          const height = row.getBoundingClientRect().height
          for (const n of ["9", "10", "99", "100", "300"]) { number.textContent = n; if (number.scrollWidth > number.clientWidth + 1 || Math.abs(row.getBoundingClientRect().height - height) > .1) fail("EXPORT_TOC_NUMBER_OVERFLOW") }
          number.textContent = String(labels[i]); if (!fits(paper)) fail("EXPORT_TOC_MEASURE_MISMATCH")
          if (start < units) paper = newPage()
          await pause(); tocCheck()
        }
      }
      return { pageCount: toc.length, value: toc }
    }, { signal: controller.signal, assertCurrent: current })
    await current(); check()
    for (const [i, title] of titles.entries()) {
      const rows = toc.flatMap(p => [...p.querySelectorAll<HTMLElement>(`[data-entry-index="${i}"]`)])
      let offset = 0
      for (const row of rows) { const a = Number(row.dataset.titleFrom), b = Number(row.dataset.titleTo); if (a !== offset || row.querySelector(".p6-toc-title")?.textContent !== title.title.slice(a, b) || Number(row.querySelector(".p6-toc-number")?.textContent) !== convergence.labels[i]) fail("EXPORT_TOC_COVERAGE_FAILED"); offset = b }
      if (offset !== title.title.length || body.pages[body.bodyStarts[i]! - 1]?.entryId !== entries[i]!.id) fail("EXPORT_TOC_REFERENCE_MISMATCH")
    }
    allPages.push(cover, ...toc, ...body.pages.map(p => p.element))
    for (const [i, p] of allPages.entries()) { if (i) folio(p, i + 1); if (!fits(p)) fail("EXPORT_BOOK_FINAL_MEASURE_FAILED") }
    const root = body.root; root.classList.add("p6-book-output"); root.style.visibility = "hidden"
    let mapping = mapExportPages(allPages.length, options.mode ?? "a5")
    function renderMapping(mode: ExportOutputMode) {
      check(); mapping = mapExportPages(allPages.length, mode); root.style.visibility = "hidden"
      // Move, do not clone, the single logical page/image set.
      for (const p of allPages) extra.append(p)
      root.replaceChildren(); root.dataset.outputMode = mode
      for (const [i, face] of mapping.faces.entries()) {
        const view = el("div", undefined, `p6-paper-face ${mode === "a5" ? "p6-face-a5" : "p6-face-a4"}`)
        view.dataset.paperFace = String(i + 1); view.dataset.sheet = String(face.sheet); view.dataset.side = face.side
        for (const n of face.panels) { if (n === null) { const blank = el("div", undefined, "p6-panel-blank"); blank.setAttribute("aria-label", "排版补白"); view.append(blank) } else view.append(allPages[n - 1]!) }
        root.append(view)
      }
      // CSS panel geometry must match the declared PDF paper, not fit-to-page.
      const mm = 96 / 25.4
      for (const f of root.children) {
        const box = f.getBoundingClientRect()
        if (Math.abs(box.width - (mode === "a5" ? 148 : 297) * mm) > 1 || Math.abs(box.height - 210 * mm) > 1) fail("EXPORT_MAPPING_STYLE_MISMATCH")
        for (const panel of f.children) { const r = panel.getBoundingClientRect(); if (Math.abs(r.width - 148 * mm) > 1 || Math.abs(r.height - 210 * mm) > 1 || r.left < box.left - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1) fail("EXPORT_MAPPING_PANEL_OVERFLOW") }
      }
    }
    renderMapping(options.mode ?? "a5"); await current(); check()
    host.append(root); stage.remove(); root.style.visibility = "visible"
    return Object.freeze({ root, logicalPages: allPages.length, tocPages: convergence.tocPages, titlePages: convergence.labels, trace: convergence.trace,
      sourceCoverageChecked: body.sourceCoverageChecked, completeOutputReady: false as const, get mapping() { return mapping },
      async setMode(mode: ExportOutputMode) {
        const version = ++mappingVersion
        try { await current(); if (version !== mappingVersion) fail("CANCELLED"); renderMapping(mode); await current(); if (version !== mappingVersion) fail("CANCELLED"); root.style.visibility = "visible"; return mapping }
        catch (error) { if (version === mappingVersion) release(); throw error }
      },
      async assertCurrent() { try { await current() } catch (error) { release(); throw error } }, release })
  } catch (error) { release(); throw error }
}
