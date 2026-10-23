import { createVerifiedNotebookCapability } from "./notebookSessionRepo"
import { createExportPreflightTask } from "@/shared/exportPreflightTask"
import { createLocalExportSnapshotPort } from "./exportSnapshotRepo"

/** Shares the existing /auth/me-backed memory proof, expiry/token/owner watchers
 * and failed-renewal semantics with P5. No view supplies a lease or owner.
 * Internal until the P6-1 real-storage checks; not exported by @/repo yet. */
export function createVerifiedExportSnapshotPort(failed: () => void) {
  return createVerifiedNotebookCapability(createLocalExportSnapshotPort, failed)
}

/** Same verified gate, with an owned snapshot port and cancellable image preflight.
 * Internal only: no formal route, @/repo export, fonts or printing in this node. */
export function createVerifiedExportPreflightTask(failed: () => void) {
  return createVerifiedNotebookCapability(lease => {
    const port = createLocalExportSnapshotPort(lease)
    const task = createExportPreflightTask(port)
    return { ...task, close() { task.close(); port.close() } }
  }, failed)
}
