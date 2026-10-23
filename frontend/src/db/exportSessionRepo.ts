import { createVerifiedNotebookCapability } from "./notebookSessionRepo"
import { createExportPreflightTask } from "@/shared/exportPreflightTask"
import { createLocalExportSnapshotPort } from "./exportSnapshotRepo"

/** Shares the existing /auth/me-backed memory proof, expiry/token/owner watchers
 * and failed-renewal semantics with P5. No view supplies a lease or owner.
 * Snapshot constructor remains internal; formal UI receives only a task. */
export function createVerifiedExportSnapshotPort(failed: () => void) {
  return createVerifiedNotebookCapability(createLocalExportSnapshotPort, failed)
}

/** Same verified gate, with an owned snapshot port and cancellable image preflight.
 * Public only through the lazy verified @/repo factory; no caller-supplied lease. */
export function createVerifiedExportPreflightTask(failed: () => void) {
  return createVerifiedNotebookCapability(lease => {
    const port = createLocalExportSnapshotPort(lease)
    const task = createExportPreflightTask(port)
    return { ...task, close() { task.close(); port.close() } }
  }, failed)
}
