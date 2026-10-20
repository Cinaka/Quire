import { independentTagLocalImageIds, localKeepImageIds } from "@/shared/scheduleDualResourceAdoption"
import { digestScheduleResourceBytes } from "./scheduleResourceConflictFile"
import { parseScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { checkDualResourceEvidence, parseDualResourceEvidence, serializeDualResourceEvidence } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "@/shared/scheduleDualResourceEvidence"
import { RESOURCE_EVIDENCE_MAX_BYTES } from "@/shared/scheduleResourceEvidence"
import { createVerifiedEvidenceFilePreserver, readVerifiedEvidenceFile } from "./scheduleConflictEvidenceFile"
import type { ConflictEvidenceFileHandle, ConflictEvidenceReadableFile, EvidenceFileCodec } from "./scheduleConflictEvidenceFile"
import { validateScheduleResourceImage } from "./scheduleResourceImageDownload"

/** Validate every downloaded original and thumbnail, even if a later choice would not use it. */
export async function verifyDualResourceEvidence(value: ScheduleDualResourceEvidence) {
  const valid = checkDualResourceEvidence(value)
  const cloud = parseScheduleCloudResourceReview(valid.cloud, valid.scheduleId)
  for (const row of valid.cloudMedia) {
    const proof = cloud.media.find(item => item.id === row.id)!
    for (const variant of ["original", "thumbnail"] as const) {
      const base64 = variant === "original" ? row.blobBase64 : row.thumbBase64
      if (base64 === null) continue // Structural validation required not_present for this slot.
      const expected = proof[variant]
      await validateScheduleResourceImage({ read_only: true, resolution_enabled: false,
        proof_scope: "current_entry_image_bytes", schedule_id: valid.scheduleId, media_id: row.id, variant,
        size: expected.size, mime: expected.mime, sha256: expected.sha256, data_base64: base64 },
      valid.scheduleId, row.id, variant, expected)
    }
  }
  return valid
}
const codec: EvidenceFileCodec<ScheduleDualResourceEvidence> = {
  maxBytes: RESOURCE_EVIDENCE_MAX_BYTES, serialize: serializeDualResourceEvidence, parse: parseDualResourceEvidence,
}
/** Empty file only, exclusive close/exact readback; never a backup-v3 importer or a handoff token. */
export function createDualResourceEvidenceFilePreserver(handle: ConflictEvidenceFileHandle, check: () => Promise<void> = async () => {}) {
  const guarded: ConflictEvidenceFileHandle = {
    async getFile() {
      await check()
      const file = await handle.getFile()
      return { size: file.size, async text() { await check(); return file.text() } }
    },
    async createWritable(options) {
      await check()
      const writable = await handle.createWritable(options)
      return {
        async write(text) { await check(); await writable.write(text) },
        async close() { await check(); await writable.close() },
        async abort() { await writable.abort() }, // Cleanup must still run after cancellation.
      }
    },
  }
  const preserve = createVerifiedEvidenceFilePreserver(guarded, codec)
  return async (value: ScheduleDualResourceEvidence) => {
    const verified = await verifyDualResourceEvidence(value)
    await check()
    await preserve(verified)
  }
}
export async function readDualResourceEvidenceFile(file: ConflictEvidenceReadableFile) {
  return verifyDualResourceEvidence(await readVerifiedEvidenceFile(file, codec))
}

/** Retained local images need valid uploadable signatures too; no resize/re-encoding is performed. */
export async function verifyDualLocalKeepImages(value: ScheduleDualResourceEvidence) {
  localKeepImageIds(value)
  return verifyIndependentTagLocalImages(value)
}
export async function verifyIndependentTagLocalImages(value: ScheduleDualResourceEvidence) {
  for (const id of independentTagLocalImageIds(value)) {
    const row = value.local.media.find(item => item.id === id)!
    for (const variant of ["original", "thumbnail"] as const) {
      const base64 = variant === "original" ? row.blobBase64 : row.thumbBase64
      if (base64 === null) continue
      const mime = variant === "original" ? row.mime : row.thumbMime
      const digest = await digestScheduleResourceBytes(base64)
      const proof = { state: "verified" as const, ...digest, mime }
      await validateScheduleResourceImage({ read_only: true, resolution_enabled: false, proof_scope: "current_entry_image_bytes",
        schedule_id: value.scheduleId, media_id: id, variant, ...digest, mime, data_base64: base64 },
      value.scheduleId, id, variant, proof)
    }
  }
}
