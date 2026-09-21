// src/capabilities/backupFile.ts（新建）—— 生成并落盘一份全量备份。
// 放 capabilities/ 而不是 shared/：它经由 saveBlob 碰 document（铁律 6）。
import { saveBlob } from "./download"
import { backupRepo } from "@/repo"
import { backupFileName } from "@/shared/backup"

export async function downloadFullBackup(
  onProgress?: (done: number, total: number) => void,
): Promise<{ entries: number; media: number }> {
  const file = await backupRepo.exportAll(onProgress)
  // 不传缩进：base64 本来就大，缩进只会让文件再胖一圈而没人会去读它。
  saveBlob(new Blob([JSON.stringify(file)], { type: "application/json" }), backupFileName())
  return { entries: file.counts.entries, media: file.counts.media }
}
