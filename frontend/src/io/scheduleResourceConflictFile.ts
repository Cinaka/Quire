import { parseScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import type { ScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { checkResourceConflictEvidence, matchedResourceChoices, parseResourceConflictEvidence, serializeResourceConflictEvidence } from "@/shared/scheduleResourceConflict"
import type { ScheduleResourceConflictEvidence } from "@/shared/scheduleResourceConflict"
import { RESOURCE_EVIDENCE_MAX_BYTES } from "@/shared/scheduleResourceEvidence"
import type { ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import { createVerifiedEvidenceFilePreserver, readVerifiedEvidenceFile } from "./scheduleConflictEvidenceFile"
import type { ConflictEvidenceFileHandle, ConflictEvidenceReadableFile, EvidenceFileCodec } from "./scheduleConflictEvidenceFile"

export async function digestScheduleResourceBytes(base64: string) {
  const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0))
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return { size: bytes.byteLength, sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("") }
}
/** Checks both original and thumbnail. No fetch, download, ID reuse or byte replacement. */
export async function assertMatchedResourceBytes(local: ScheduleResourceEvidence, cloud: ScheduleCloudResourceReview) {
  matchedResourceChoices(local, cloud)
  for (const proof of cloud.media) {
    const row = local.media.find(item => item.id === proof.id)!
    for (const [base64, expected] of [[row.blobBase64, proof.original], [row.thumbBase64, proof.thumbnail]] as const) {
      if (base64 === null) { if (expected.state !== "not_present") throw new Error("缩略图字节缺失"); continue }
      const actual = await digestScheduleResourceBytes(base64)
      if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error("图片字节与当前云端证明不同")
    }
  }
}
async function verify(value: ScheduleResourceConflictEvidence) {
  const valid = checkResourceConflictEvidence(value)
  await assertMatchedResourceBytes(valid.local, parseScheduleCloudResourceReview(valid.cloud, valid.scheduleId))
  return valid
}
const codec: EvidenceFileCodec<ScheduleResourceConflictEvidence> = {
  maxBytes: RESOURCE_EVIDENCE_MAX_BYTES, serialize: serializeResourceConflictEvidence, parse: parseResourceConflictEvidence,
}
/** Fresh empty file, exclusive write, close and exact readback. Not backup-v3 or a restore API. */
export function createScheduleResourceConflictFilePreserver(handle: ConflictEvidenceFileHandle) {
  const preserve = createVerifiedEvidenceFilePreserver(handle, codec)
  return async (value: ScheduleResourceConflictEvidence) => { const valid = await verify(value); await preserve(valid) }
}
export async function readScheduleResourceConflictFile(file: ConflictEvidenceReadableFile) {
  return verify(await readVerifiedEvidenceFile(file, codec))
}
