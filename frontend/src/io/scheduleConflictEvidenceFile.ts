import {
  CONFLICT_EVIDENCE_MAX_BYTES, parseConflictEvidenceFile, serializeConflictEvidenceFile,
} from "@/shared/scheduleConflictEvidenceFile"
import type { ConflictEvidence } from "@/shared/scheduleConflictEvidenceFile"

export interface ConflictEvidenceReadableFile { size: number; text(): Promise<string> }
export interface ConflictEvidenceWritableFile {
  write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void>
}
/** The caller supplies an explicitly chosen fresh file; no picker/permission request runs here. */
export interface ConflictEvidenceFileHandle {
  getFile(): Promise<ConflictEvidenceReadableFile>
  createWritable(options: { keepExistingData: false; mode: "exclusive" }): Promise<ConflictEvidenceWritableFile>
}
function size(file: ConflictEvidenceReadableFile) {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > CONFLICT_EVIDENCE_MAX_BYTES) {
    throw new Error("冲突证据文件大小无效或超限")
  }
}
export async function readConflictEvidenceFile(file: ConflictEvidenceReadableFile): Promise<ConflictEvidence> {
  size(file)
  const text = await file.text()
  if (new Blob([text]).size !== file.size) throw new Error("冲突证据读取长度不一致")
  return parseConflictEvidenceFile(text)
}
/**
 * Only a closed, re-read, byte-for-byte matching file satisfies the existing preserve callback.
 * Browser support/permission, crashes and external writers remain outside the local DB transaction.
 * A download click, cancelled picker, malformed file, or stale earlier file never counts as preserved.
 */
export function createConflictEvidenceFilePreserver(handle: ConflictEvidenceFileHandle) {
  let busy = false, used = false
  return async (evidence: ConflictEvidence): Promise<void> => {
    if (busy || used) throw new Error("证据文件正在使用或已保存，请另选空文件")
    busy = true
    let writable: ConflictEvidenceWritableFile | null = null
    try {
      const expected = serializeConflictEvidenceFile(evidence)
      if (new Blob([expected]).size > CONFLICT_EVIDENCE_MAX_BYTES) throw new Error("冲突证据文件超限")
      const existing = await handle.getFile()
      size(existing)
      if (existing.size !== 0) throw new Error("拒绝覆盖已有文件，请明确选择新空文件")
      writable = await handle.createWritable({ keepExistingData: false, mode: "exclusive" })
      const locked = await handle.getFile()
      size(locked)
      if (locked.size !== 0) throw new Error("目标文件已变化，未覆盖")
      await writable.write(expected)
      await writable.close()
      writable = null
      const saved = await handle.getFile()
      size(saved)
      if (saved.size !== new Blob([expected]).size) throw new Error("证据保存长度不一致，仍保留保护")
      const actual = await saved.text()
      if (actual !== expected) throw new Error("证据回读不一致，仍保留保护")
      parseConflictEvidenceFile(actual)
      used = true
    } finally {
      if (writable) { try { await writable.abort() } catch { /* do not replace the original failure */ } }
      busy = false
    }
  }
}
