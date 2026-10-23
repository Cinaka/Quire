import type { ExportSnapshotHandle, ExportSnapshotPort } from "../db/exportSnapshotCore"
import type { ExportSelectionRequest } from "./exportScope"
import { ExportSnapshotError, type ExportSnapshot } from "./exportSnapshot"
import { preflightImages, exportImageDecoder, type SerialImageDecoder, type ExportDecode, type ExportImagePlan } from "./exportImageResources"

export type ExportPreflightState = "idle" | "capturing" | "checking-images" | "checked" | "failed" | "closed"
export interface ExportPreflightStatus {
  readonly state: ExportPreflightState
  readonly changed: boolean
  readonly code?: string
}
export interface ExportCheckedSnapshot {
  readonly snapshot: ExportSnapshot
  readonly images: ExportImagePlan
  readonly changed: boolean
  readonly availableImagesChecked: true
  /** Diagnostics, fonts, pagination and platform print checks still gate output. */
  readonly completeOutputReady: false
}
/** Internal lifecycle only; never exported via @/repo or mounted in a formal view.
 * Capture fully commits before Blob reads/native decode. Retains no bitmap/URL.
 * Caller must explicitly rerun to update content; ordinary changes only notify. */
export function createExportPreflightTask(port: ExportSnapshotPort,
  options: { decoder?: SerialImageDecoder; decode?: ExportDecode } = {}) {
  const decoder = options.decoder ?? exportImageDecoder
  const listeners = new Set<(status: ExportPreflightStatus) => void>()
  let closed = false, version = 0
  let status: ExportPreflightStatus = Object.freeze({ state: "idle", changed: false })
  let active: { controller: AbortController; handle?: ExportSnapshotHandle; value?: ExportCheckedSnapshot; stops: (() => void)[] } | undefined
  const publish = (next: ExportPreflightStatus) => {
    status = Object.freeze(next)
    for (const listener of [...listeners]) { try { listener(status) } catch { /* isolate consumers */ } }
  }
  function release(): void {
    const old = active; active = undefined
    if (!old) return
    // Detach callbacks first; release cannot recursively clear a newer job.
    for (const stop of old.stops.splice(0)) { try { stop() } catch { /* release all */ } }
    old.value = undefined; old.controller.abort(); old.handle?.release(); old.handle = undefined
  }
  function cancel(): void { if (closed) return; version++; release(); publish({ state: "idle", changed: false, code: "CANCELLED" }) }
  function close(): void {
    if (closed) return
    closed = true; version++; release(); stopInvalidated?.(); publish({ state: "closed", changed: false }); listeners.clear()
  }
  let stopInvalidated: (() => void) | undefined
  stopInvalidated = port.subscribeInvalidated(close)
  if (closed) { stopInvalidated(); stopInvalidated = undefined }
  return {
    status: () => status,
    subscribe(listener: (state: ExportPreflightStatus) => void) {
      if (closed) { try { listener(status) } catch { /* isolate */ }; return () => {} }
      listeners.add(listener); try { listener(status) } catch { /* isolate */ }
      return () => { listeners.delete(listener) }
    },
    cancel, close,
    async run(request: ExportSelectionRequest, signal?: AbortSignal): Promise<void> {
      if (closed) throw new ExportSnapshotError("EXPORT_PREFLIGHT_CLOSED")
      const task = ++version; release()
      const job = { controller: new AbortController(), stops: [] as (() => void)[], handle: undefined as ExportSnapshotHandle | undefined, value: undefined as ExportCheckedSnapshot | undefined }
      active = job
      const check = () => { if (closed || task !== version || active !== job || job.controller.signal.aborted) throw new ExportSnapshotError("CANCELLED") }
      const externalAbort = () => { if (active === job) cancel() }
      signal?.addEventListener("abort", externalAbort, { once: true })
      job.stops.push(() => signal?.removeEventListener("abort", externalAbort))
      publish({ state: "capturing", changed: false })
      try {
        if (signal?.aborted) throw new ExportSnapshotError("CANCELLED")
        check(); const handle = await port.capture(request, job.controller.signal)
        if (active !== job || task !== version) { handle.release(); throw new ExportSnapshotError("CANCELLED") }
        job.handle = handle
        job.stops.push(handle.subscribeReleased(() => { if (active === job) cancel() }))
        job.stops.push(handle.subscribeChanged(() => { if (active === job) publish({ ...status, changed: true }) }))
        check(); const snapshot = await handle.read(); check()
        const assertCurrent = async () => { check(); await handle.read(); check() }
        publish({ state: "checking-images", changed: handle.hasChanges() })
        const records = snapshot.media.flatMap(item => item.blob ? [{ id: item.id, blob: item.blob }] : [])
        const images = await preflightImages(records, { signal: job.controller.signal, assertCurrent }); check()
        await decoder.run(images, { signal: job.controller.signal, assertCurrent, ...(options.decode ? { decode: options.decode } : {}) }); check()
        await assertCurrent(); check()
        job.value = Object.freeze({ snapshot, images, changed: handle.hasChanges(), availableImagesChecked: true, completeOutputReady: false })
        publish({ state: "checked", changed: handle.hasChanges() })
      } catch (error) {
        if (active === job && task === version) {
          release()
          publish({ state: "failed", changed: false, code: error instanceof ExportSnapshotError ? error.code : "EXPORT_PREFLIGHT_FAILED" })
        }
        throw error
      }
    },
    async read(): Promise<ExportCheckedSnapshot> {
      const job = active, task = version
      if (!job?.value || !job.handle || status.state !== "checked") throw new ExportSnapshotError("EXPORT_PREFLIGHT_NOT_CHECKED")
      await job.handle.read()
      if (closed || task !== version || active !== job || !job.value) throw new ExportSnapshotError("EXPORT_PREFLIGHT_RELEASED")
      return Object.freeze({ ...job.value, changed: job.handle.hasChanges() })
    },
  }
}
