import type { CloudImageProof, CloudMediaProof } from "@/shared/scheduleCloudResources"
import { conversionCanonical } from "@/shared/scheduleConversionSync"
import { parseScheduleResourceEvidence, RESOURCE_EVIDENCE_MAX_BYTES } from "@/shared/scheduleResourceEvidence"
import type { ResourceEvidenceMedia, ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import type { ScheduleResourceConflictEvidence } from "@/shared/scheduleResourceConflict"
import { digestScheduleResourceBytes, readScheduleResourceConflictFile } from "./scheduleResourceConflictFile"
import { readVerifiedEvidenceFile } from "./scheduleConflictEvidenceFile"
import type { EvidenceFileCodec } from "./scheduleConflictEvidenceFile"
import type { ConflictEvidenceReadableFile } from "./scheduleConflictEvidenceFile"

export type ResourceRepairDocument = ScheduleResourceEvidence | ScheduleResourceConflictEvidence
const textCodec: EvidenceFileCodec<string> = { maxBytes: RESOURCE_EVIDENCE_MAX_BYTES, serialize: text => text, parse: text => text }
/** One bounded physical read. A compound package is never downgraded to its local field before verification. */
export async function readResourceRepairDocument(file: ConflictEvidenceReadableFile, id: string) {
  const text = await readVerifiedEvidenceFile(file, textCodec), header: unknown = JSON.parse(text)
  const format = header && typeof header === "object" && !Array.isArray(header) && "format" in header ? header.format : null
  let document: ResourceRepairDocument
  if (format === "terminal-local-resource-evidence") document = parseScheduleResourceEvidence(text)
  else if (format === "terminal-matched-resource-conflict-evidence") {
    // Validate the full original choice/cloud proof and every original/thumbnail hash, including unselected assets.
    document = await readScheduleResourceConflictFile({ size: new Blob([text]).size, text: async () => text })
  } else throw new Error("不支持的资源补齐材料，未降级或当作备份恢复")
  const local = document.format === "terminal-local-resource-evidence" ? document : document.local
  if (document.scheduleId !== id || local.scheduleId !== id || local.entryPendingPurge) throw new Error("资源证据来源不同或属于待永久弃去记录")
  // Include the entire normalized document, not just local bytes: old choice/cloud metadata cannot change unnoticed.
  const normalized = await new Blob([conversionCanonical(document)]).arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", normalized)
  const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("")
  return { local, document, fingerprint }
}
/** Compatibility reader only; it does not authorize replaying a choice or importing business state. */
export async function readResourceRepairMaterial(file: ConflictEvidenceReadableFile, id: string) {
  return (await readResourceRepairDocument(file, id)).local
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
