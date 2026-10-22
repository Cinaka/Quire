import { createVerifiedNotebookCapability } from "./notebookSessionRepo"
import { createLocalExportSnapshotPort } from "./exportSnapshotRepo"

/** Shares the existing /auth/me-backed memory proof, expiry/token/owner watchers
 * and failed-renewal semantics with P5. No view supplies a lease or owner.
 * Internal until the P6-1 real-storage checks; not exported by @/repo yet. */
export function createVerifiedExportSnapshotPort(failed: () => void) {
  return createVerifiedNotebookCapability(createLocalExportSnapshotPort, failed)
}
