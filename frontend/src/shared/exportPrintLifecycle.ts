import { ExportSnapshotError } from "./exportSnapshot"
export type ExportPrintState = "idle" | "checking" | "printing" | "returned" | "acknowledged" | "failed" | "closed"
export interface ExportPrintIO {
  assertCurrent(): Promise<void>
  enter(): void
  leave(): void
  print(): void
  listen(returned: () => void): () => void
}
/** A dialog return is NOT a saved PDF. Synchronous print() return never releases
 * resources. Missing afterprint stays locked until the user's explicit ack.
 * Close is best-effort application cleanup, not recall of OS/browser copies. */
export function createExportPrintLifecycle(io: ExportPrintIO, notify: (state: ExportPrintState) => void) {
  let state: ExportPrintState = "idle", generation = 0, stop: (() => void) | undefined
  const publish = (next: ExportPrintState) => { state = next; notify(next) }
  const leave = () => { const old = stop; stop = undefined; old?.(); io.leave() }
  function returned() { if (state !== "printing") return; generation++; leave(); publish("returned") }
  return {
    state: () => state,
    async request() {
      if (["closed", "checking", "printing"].includes(state)) throw new ExportSnapshotError("EXPORT_PRINT_BUSY")
      const task = ++generation; publish("checking")
      try {
        await io.assertCurrent()
        if (task !== generation || state === "closed") throw new ExportSnapshotError("CANCELLED")
        stop = io.listen(returned); io.enter(); publish("printing")
        io.print()
        // Deliberately no success/cleanup at synchronous return.
      } catch (error) {
        if (task === generation && state !== "closed") { leave(); publish("failed") }
        throw error
      }
    },
    acknowledgeClosed() { if (state !== "printing") return; generation++; leave(); publish("acknowledged") },
    close() { if (state === "closed") return; generation++; leave(); publish("closed") },
  }
}
