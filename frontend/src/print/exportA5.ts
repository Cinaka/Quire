import type { ExportPreparedDocument } from "../shared/exportDocumentTask"
import { compileExportFlows, sliceExportFlow, assertExportPageCoverage, EXPORT_LAYOUT_LIMITS, type ExportFlowSlice, type ExportEntryFlow, type ExportPageRange } from "../shared/exportFragments"
import { preflightImages, selectExportImagePlan, exportImageDecoder, type ExportImageInfo, type ExportImagePlan } from "../shared/exportImageResources"
import { ExportSnapshotError } from "../shared/exportSnapshot"

export interface ExportA5Source { read(): Promise<ExportPreparedDocument>; readImages(): Promise<readonly ExportImageInfo[]>; subscribeReleased(listener: () => void): () => void }
export interface ExportA5Page extends ExportPageRange { readonly number: number; readonly element: HTMLElement }
export interface ExportA5Layout {
  readonly pages: readonly ExportA5Page[]; readonly bodyStarts: readonly number[]; readonly relaxedWidows: number
  readonly sourceCoverageChecked: true; readonly completeOutputReady: false; readonly root: HTMLElement
  assertCurrent(): Promise<void>; release(): void
}
const fail = (code: string): never => { throw new ExportSnapshotError(code) }
const el = (tag: string, className?: string) => { const node = document.createElement(tag); if (className) node.className = className; return node }
/** Body pages only; no cover/TOC/imposition or permission to call window.print.
 * Exact final family is required. A stale source, image, budget or no-fit error
 * destroys owned DOM/URLs, never publishes a cropped/partial successful book. */
export async function paginateExportA5(source: ExportA5Source, host: HTMLElement, options: { signal?: AbortSignal } = {}): Promise<ExportA5Layout> {
  if (!host.isConnected) fail("EXPORT_MEASURE_HOST_DETACHED")
  const began = performance.now(), root = el("div", "quire-print-root"), meter = el("div", "quire-print-root")
  meter.style.cssText = "position:absolute;left:-20000px;top:0;visibility:hidden;pointer-events:none"
  root.style.visibility = "hidden"; host.append(root, meter)
  const urls = new Map<string, string>(), sizes = new Map<string, { width: number; height: number }>(), plans = new Map<string, ExportImagePlan>()
  const imageElements = new Set<HTMLImageElement>(), controller = new AbortController()
  let disposed = false, measuring = true, stopReleased: (() => void) | undefined, initial: ExportPreparedDocument | undefined
  const release = () => {
    if (disposed) return; disposed = true; stopReleased?.(); controller.abort(); options.signal?.removeEventListener("abort", release)
    for (const img of imageElements) img.removeAttribute("src"); imageElements.clear()
    for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear(); sizes.clear(); plans.clear()
    for (const body of root.querySelectorAll(".p6-body")) body.replaceChildren()
    root.replaceChildren(); meter.replaceChildren(); root.remove(); meter.remove()
  }
  stopReleased = source.subscribeReleased(release)
  if (disposed) stopReleased()
  options.signal?.addEventListener("abort", release, { once: true })
  const check = () => { if (disposed || options.signal?.aborted || controller.signal.aborted) fail("CANCELLED"); if (measuring && performance.now() - began > EXPORT_LAYOUT_LIMITS.stageMs) fail("EXPORT_LAYOUT_TIMEOUT") }
  const current = async () => {
    check(); const value = await source.read(); check()
    if (initial && (value.document !== initial.document || value.font.family !== initial.font.family || value.font.mode !== initial.font.mode)) fail("EXPORT_LAYOUT_SOURCE_CHANGED")
    return value
  }
  const yieldControl = async () => { check(); await new Promise<void>(resolve => setTimeout(resolve, 0)); check() }
  function sheet(container: HTMLElement, number: number) {
    const paper = el("section", "p6-sheet"), body = el("div", "p6-body"), folio = el("div", "p6-folio")
    folio.textContent = String(number); paper.append(body, folio); container.append(paper); return { paper, body }
  }
  function render(nodes: readonly ExportFlowSlice[], parent: HTMLElement, pictures = false): void {
    for (const node of nodes) {
      check()
      let item: HTMLElement
      if (node.kind === "text") { item = el("span"); item.textContent = node.text ?? ""; item.dataset.utf16From = String(node.utf16From); item.dataset.utf16To = String(node.utf16To) }
      else if (node.kind === "image") {
        const image = node.image!, size = sizes.get(image.mediaId)
        if (!size) throw new ExportSnapshotError("EXPORT_LAYOUT_IMAGE_MISSING")
        item = el("span", "p6-image-box")
        item.style.width = `min(100%, ${size.width}px, ${153 * size.width / size.height}mm)`
        item.style.aspectRatio = `${size.width} / ${size.height}`
        if (pictures) { const img = new Image(); img.alt = image.alt; img.title = image.title; img.dataset.mediaId = image.mediaId; imageElements.add(img); item.append(img) }
      } else {
        item = el(node.tag ?? "span")
        if (node.listStart !== undefined) item.setAttribute("start", String(node.listStart))
        if (node.listValue !== undefined) item.setAttribute("value", String(node.listValue))
        if (node.kind !== "empty") render(node.children ?? [], item, pictures)
      }
      item.dataset.nodeStart = String(node.start); item.dataset.nodeEnd = String(node.end)
      item.dataset.flowId = String(node.id); item.dataset.unitFrom = String(node.from); item.dataset.unitTo = String(node.to)
      item.dataset.source = JSON.stringify(node.source); item.dataset.continued = String(node.continued)
      if (node.role) item.dataset.role = node.role
      parent.append(item)
    }
  }
  function fits(body: HTMLElement): boolean {
    const box = body.getBoundingClientRect(), last = body.lastElementChild?.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && (!last || last.bottom <= box.bottom - .5) && body.scrollWidth <= body.clientWidth + 1 && body.scrollHeight <= body.clientHeight + 1
  }
  async function loadImage(img: HTMLImageElement, id: string) {
    const plan = plans.get(id), url = urls.get(id)
    if (!plan || !url) throw new ExportSnapshotError("EXPORT_LAYOUT_IMAGE_MISSING")
    await exportImageDecoder.verifyDomImage(plan, { signal: controller.signal, assertCurrent: async () => { await current(); check() },
      load: async () => { check(); img.src = url; await img.decode(); check(); return { width: img.naturalWidth, height: img.naturalHeight } }, discard: () => img.removeAttribute("src") })
    check()
  }
  try {
    initial = await current(); check(); root.style.fontFamily = initial.font.family; meter.style.fontFamily = initial.font.family
    const images = await source.readImages(); check(); await current(); check()
    // All header/aggregate budgets precede DOM decoding. Serial DOM preparation
    // and ImageBitmap preflight use the SAME per-realm native slot.
    const plan = await preflightImages(images, { signal: controller.signal, assertCurrent: async () => { await current(); check() } }); check()
    for (const item of plan.items) {
      check(); plans.set(item.id, selectExportImagePlan(plan, item.id)); urls.set(item.id, URL.createObjectURL(item.blob))
      const img = new Image(); imageElements.add(img)
      await loadImage(img, item.id); sizes.set(item.id, { width: img.naturalWidth, height: img.naturalHeight }); img.removeAttribute("src"); imageElements.delete(img)
    }
    const flows = await compileExportFlows(initial.document, { check, yieldControl }); check()
    const probe = sheet(meter, 1), pages: ExportA5Page[] = [], bodyStarts: number[] = []
    const mm = 96 / 25.4, paperBox = probe.paper.getBoundingClientRect(), bodyBox = probe.body.getBoundingClientRect()
    if (Math.abs(paperBox.width - 148 * mm) > 1 || Math.abs(paperBox.height - 210 * mm) > 1 || Math.abs(bodyBox.width - 124 * mm) > 1 || Math.abs(bodyBox.height - 179 * mm) > 1) fail("EXPORT_PAGE_STYLE_MISMATCH")
    let relaxedWidows = 0
    const trial = (flow: ExportEntryFlow, from: number, to: number) => { probe.body.replaceChildren(); render(sliceExportFlow(flow, from, to), probe.body); return fits(probe.body) }
    // Keep a heading with following text where possible. If a title itself spans
    // a page, retain it in full across pages rather than dropping or shrinking it.
    function avoidHeadingOrphan(flow: ExportEntryFlow, from: number, cut: number): number {
      const visible = [...probe.body.querySelectorAll<HTMLElement>("h1,h2,h3")]
      const heading = visible.at(-1)
      if (!heading || cut === flow.units) return cut
      const after = document.createRange(); after.setStartAfter(heading); after.setEnd(probe.body, probe.body.childNodes.length)
      if (after.toString().trim()) return cut
      const at = Number(heading.dataset.unitFrom)
      if (at > from && probe.body.textContent?.slice(0, probe.body.textContent.indexOf(heading.textContent ?? "")).replace(/\d{4}-\d{2}-\d{2}/, "").trim()) return at
      relaxedWidows++; return cut
    }
    function lines(node: HTMLElement | null): number {
      if (!node) return 0
      const range = document.createRange(); range.selectNodeContents(node)
      return new Set([...range.getClientRects()].filter(rect => rect.height > 1).map(rect => Math.round(rect.top))).size
    }
    function avoidWidow(flow: ExportEntryFlow, from: number, cut: number): number {
      const block = [...probe.body.querySelectorAll<HTMLElement>("p[data-flow-id],li[data-flow-id],pre[data-flow-id]")].at(-1)
      if (!block) return cut
      const end = Number(block.dataset.nodeEnd), begin = Number(block.dataset.nodeStart), id = block.dataset.flowId!, count = lines(block)
      if (cut >= end) return cut
      if (count < 2) { if (begin > from) return begin; relaxedWidows++; return cut }
      // A one-line remainder borrows one line from this page when both sides can
      // retain two. Probe exact same wrappers and family, never insert new text.
      if (end - cut <= EXPORT_LAYOUT_LIMITS.probeUnits) {
        trial(flow, cut, end)
        if (lines(probe.body.querySelector<HTMLElement>(`[data-flow-id="${id}"]`)) === 1) {
          if (count < 3) { relaxedWidows++; return cut }
          let lo = Math.max(from, begin), hi = cut - 1
          while (lo < hi) { check(); const mid = Math.ceil((lo + hi) / 2); trial(flow, from, mid); if (lines(probe.body.querySelector<HTMLElement>(`[data-flow-id="${id}"]`)) <= count - 1) lo = mid; else hi = mid - 1 }
          if (lo > from) return lo
          relaxedWidows++
        }
      }
      return cut
    }
    for (const flow of flows) {
      bodyStarts.push(pages.length + 1); let cursor = 0
      while (cursor < flow.units) {
        check(); await current(); check()
        if (pages.length >= EXPORT_LAYOUT_LIMITS.pages) fail("EXPORT_PAGE_LIMIT")
        let lo = 0, hi = Math.min(flow.units - cursor, EXPORT_LAYOUT_LIMITS.probeUnits)
        while (lo < hi) { check(); const mid = Math.ceil((lo + hi) / 2); if (trial(flow, cursor, cursor + mid)) lo = mid; else hi = mid - 1 }
        if (!lo) fail("EXPORT_FRAGMENT_DOES_NOT_FIT")
        let cut = cursor + lo; trial(flow, cursor, cut); cut = avoidWidow(flow, cursor, cut)
        trial(flow, cursor, cut); cut = avoidHeadingOrphan(flow, cursor, cut)
        if (cut <= cursor || !trial(flow, cursor, cut)) fail("EXPORT_FRAGMENT_DOES_NOT_FIT")
        const page = sheet(root, pages.length + 1); render(sliceExportFlow(flow, cursor, cut), page.body, true)
        for (const img of page.body.querySelectorAll<HTMLImageElement>("img[data-media-id]")) await loadImage(img, img.dataset.mediaId!)
        if (!fits(page.body)) fail("EXPORT_FINAL_MEASURE_MISMATCH")
        const box = page.body.getBoundingClientRect()
        for (const item of page.body.querySelectorAll<HTMLElement>("[data-flow-id]")) {
          const r = item.getBoundingClientRect()
          if (r.left < box.left - 1 || r.right > box.right + 1 || r.bottom > box.bottom + 1) fail("EXPORT_FINAL_MEASURE_MISMATCH")
        }
        // No hidden overflow or screenshot slices; every page is a real subtree.
        pages.push(Object.freeze({ entryId: flow.entryId, from: cursor, to: cut, number: pages.length + 1, element: page.paper })); cursor = cut
        await yieldControl(); await current(); check()
      }
    }
    assertExportPageCoverage(flows, pages)
    // Audit the actual rendered text leaves too, not merely page range arithmetic.
    // Offsets are UTF-16 source offsets; every original text and empty/image atom
    // must be represented exactly once without altering any stored character.
    const renderedById = new Map<number, HTMLElement[]>()
    for (const item of root.querySelectorAll<HTMLElement>("[data-flow-id]")) {
      const id = Number(item.dataset.flowId)
      const items = renderedById.get(id) ?? []
      items.push(item); renderedById.set(id, items)
    }
    for (const flow of flows) {
      const stack = [...flow.nodes]
      while (stack.length) {
        check(); const node = stack.pop()!
        if (node.children?.length) { for (const child of node.children) stack.push(child) }
        else {
          const rendered = renderedById.get(node.id) ?? []
          if (node.kind === "text") {
            let offset = 0
            if (!rendered.length) fail("EXPORT_RENDER_COVERAGE_FAILED")
            for (const item of rendered) {
              const a = Number(item.dataset.utf16From), b = Number(item.dataset.utf16To)
              if (a !== offset || b < a || item.textContent !== node.text!.slice(a, b)) fail("EXPORT_RENDER_COVERAGE_FAILED")
              offset = b
            }
            if (offset !== node.text!.length) fail("EXPORT_RENDER_COVERAGE_FAILED")
          } else if (rendered.length !== 1) fail("EXPORT_RENDER_COVERAGE_FAILED")
        }
      }
    }
    await current(); check(); measuring = false; meter.remove(); root.style.visibility = "visible"
    return Object.freeze({ pages: Object.freeze(pages), bodyStarts: Object.freeze(bodyStarts), relaxedWidows, sourceCoverageChecked: true as const, completeOutputReady: false as const, root,
      async assertCurrent() { try { await current(); check() } catch (error) { release(); throw error } }, release })
  } catch (error) { release(); throw error }
}
