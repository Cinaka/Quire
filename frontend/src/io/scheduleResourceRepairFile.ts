import type { CloudImageProof, CloudMediaProof } from "@/shared/scheduleCloudResources"
import type { ResourceEvidenceMedia } from "@/shared/scheduleResourceEvidence"
import { digestScheduleResourceBytes } from "./scheduleResourceConflictFile"
import { readScheduleResourceEvidenceFile } from "./scheduleResourceEvidenceFile"
import type { ConflictEvidenceReadableFile } from "./scheduleConflictEvidenceFile"

export async function readResourceRepairMaterial(file: ConflictEvidenceReadableFile, id: string) {
  const evidence = await readScheduleResourceEvidenceFile(file)
  if (evidence.scheduleId !== id || evidence.entryPendingPurge) throw new Error("资源证据来源不同或属于待永久弃去记录")
  return evidence
}
export async function assertResourceRepairImage(base64: string | null, mime: string | null, proof: CloudImageProof) {
  if (base64 === null) { if (proof.state !== "not_present") throw new Error("证据文件没有完整缩略图"); return }
  if (proof.state !== "verified" || mime !== proof.mime) throw new Error("证据图片MIME或证明不一致")
  const actual = await digestScheduleResourceBytes(base64)
  if (actual.size !== proof.size || actual.sha256 !== proof.sha256) throw new Error("证据图片字节与云端当前证明不同")
}
export async function assertResourceRepairMaterial(media: ResourceEvidenceMedia, proof: CloudMediaProof, id: string) {
  if (media.entryId !== id || media.id !== proof.id || media.orphanedAt !== null || media.width !== proof.width ||
      media.height !== proof.height || media.size !== proof.size || media.sortOrder !== proof.sortOrder) throw new Error("证据媒体身份或元数据不匹配")
  await assertResourceRepairImage(media.blobBase64, media.mime, proof.original)
  await assertResourceRepairImage(media.thumbBase64, media.thumbMime, proof.thumbnail)
}
export async function inspectResourceRepairBlob(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), parts: string[] = []
  for (let index = 0; index < bytes.length; index += 8192) parts.push(String.fromCharCode(...bytes.subarray(index, index + 8192)))
  const base64 = btoa(parts.join(""))
  return { mime: blob.type, base64, ...(await digestScheduleResourceBytes(base64)) }
}
export function resourceRepairBlob(base64: string, mime: string): Blob {
  return new Blob([Uint8Array.from(atob(base64), value => value.charCodeAt(0))], { type: mime })
}
