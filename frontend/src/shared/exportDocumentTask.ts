import type { createExportPreflightTask } from "./exportPreflightTask"
import { createExportDocument, collectExportFontText, type ExportDocument } from "./exportDocument"
import type { ExportFontLease, ExportFontMode } from "./exportFontReadiness"
import type { ExportContentMode, ExportReview } from "./exportReviewPolicy"
import { ExportSnapshotError } from "./exportSnapshot"

type Preflight = ReturnType<typeof createExportPreflightTask>
export type ExportFontPrepare = (text: string, mode: ExportFontMode, options: { signal: AbortSignal; assertCurrent: () => Promise<void> }) => Promise<ExportFontLease>
export interface ExportPreparedDocument {
  readonly document: ExportDocument
  readonly font: Readonly<Pick<ExportFontLease, "mode" | "family" | "shardCount" | "uncoveredScalars">>
  readonly changed: boolean
  /** Preparation only: no measured pages, TOC, print DOM or output capability. */
  readonly completeOutputReady: false
}
/** Owns font leases, NOT the supplied preflight port. A print view must close both.
 * Read rechecks policy/identity; stale consumers
 * cannot use a model as permission. Cancellation cannot erase retained copies. */
export function createExportDocumentTask(preflight: Preflight, prepareFonts: ExportFontPrepare) {
  const releases = new Set<() => void>()
  let closed = false, version = 0
  let active: { controller: AbortController; review: ExportReview; mode: ExportContentMode; font?: ExportFontLease; value?: ExportPreparedDocument; stopAbort?: () => void } | undefined
  const cancel = () => {
    version++; const old = active; active = undefined
    old?.stopAbort?.(); old?.controller.abort(); old?.font?.release()
    if (old) for (const listener of [...releases]) { try { listener() } catch { /* isolate consumers */ } }
  }
  const stop = preflight.subscribe(status => {
    const job = active
    if (job && (status.state !== "checked" || (job.mode === "degraded" && status.contentPolicy !== "degraded-confirmed"))) cancel()
  })
  return {
    cancel,
    subscribeReleased(listener: () => void) {
      if (!active?.value || closed) { listener(); return () => {} }
      releases.add(listener); return () => { releases.delete(listener) }
    },
    close() { if (closed) return; closed = true; cancel(); stop(); releases.clear() },
    async prepare(mode: ExportContentMode, review: ExportReview, fontMode: ExportFontMode, signal?: AbortSignal, options: { title?: string } = {}): Promise<void> {
      if (closed) throw new ExportSnapshotError("EXPORT_DOCUMENT_CLOSED")
      const bookOptions = { title: options.title }
      cancel(); const task = version
      const job = { controller: new AbortController(), review, mode, font: undefined as ExportFontLease | undefined, value: undefined as ExportPreparedDocument | undefined, stopAbort: undefined as (() => void) | undefined }
      active = job
      const externalAbort = () => { if (active === job) cancel() }
      signal?.addEventListener("abort", externalAbort, { once: true }); job.stopAbort = () => signal?.removeEventListener("abort", externalAbort)
      const check = () => { if (closed || version !== task || active !== job || signal?.aborted || job.controller.signal.aborted) throw new ExportSnapshotError("CANCELLED") }
      const current = async () => { check(); const value = await preflight.readForLayout(mode, review); check(); return value }
      try {
        const value = await current(); check()
        const document = createExportDocument(value, bookOptions), text = collectExportFontText(document)
        const font = await prepareFonts(text, fontMode, { signal: job.controller.signal, assertCurrent: async () => { await current(); check() } })
        if (active !== job || task !== version || closed || signal?.aborted) { font.release(); throw new ExportSnapshotError("CANCELLED") }
        job.font = font
        const final = await current(); check()
        job.value = Object.freeze({ document, font: Object.freeze({ mode: font.mode, family: font.family, shardCount: font.shardCount, uncoveredScalars: font.uncoveredScalars }), changed: final.changed, completeOutputReady: false })
      } catch (error) { if (active === job) cancel(); throw error }
    },
    /** Same fixed snapshot resources, no new scan or thumbnail/remote fallback. */
    async readImages() {
      const job = active, task = version
      if (!job?.value) throw new ExportSnapshotError("EXPORT_DOCUMENT_NOT_PREPARED")
      try {
        const current = await preflight.readForLayout(job.mode, job.review)
        if (closed || version !== task || active !== job || !job.value) throw new ExportSnapshotError("EXPORT_DOCUMENT_RELEASED")
        return current.images.items
      } catch (error) { if (active === job) cancel(); throw error }
    },
    async read(): Promise<ExportPreparedDocument> {
      const job = active, task = version
      if (!job?.value) throw new ExportSnapshotError("EXPORT_DOCUMENT_NOT_PREPARED")
      try {
        const current = await preflight.readForLayout(job.mode, job.review)
        if (closed || version !== task || active !== job || !job.value) throw new ExportSnapshotError("EXPORT_DOCUMENT_RELEASED")
        return Object.freeze({ ...job.value, changed: current.changed })
      } catch (error) { if (active === job) cancel(); throw error }
    },
  }
}
