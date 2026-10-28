import { checkUuid32Backup } from "@/shared/backupUuid32"
import type { BackupFile, ImportConflict } from "@/shared/backup"
import { localBackupRepo } from "./backupRepo"

/** The public restore boundary; raw legacy reader remains private for compatibility tests. */
export const uuid32BackupRepo = {
  async exportAll(onProgress?: (done: number, total: number) => void) {
    const file = await localBackupRepo.exportAll(onProgress)
    checkUuid32Backup(file, "preferNewer")
    return file
  },
  async importAll(raw: unknown, conflict: ImportConflict = "preferNewer") {
    // Snapshot before any asynchronous decode or DB access, preserving the original file.
    const file: BackupFile = JSON.parse(JSON.stringify(checkUuid32Backup(raw, conflict)))
    if (conflict === "asCopy") for (const row of file.media) {
      row.remoteUrl = ""; row.thumbRemoteUrl = ""
    }
    return localBackupRepo.importAll(file, conflict)
  },
}
