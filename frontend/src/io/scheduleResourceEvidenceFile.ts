import { parseScheduleResourceEvidence, RESOURCE_EVIDENCE_MAX_BYTES, serializeScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import type { ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import { createVerifiedEvidenceFilePreserver, readVerifiedEvidenceFile } from "./scheduleConflictEvidenceFile"
import type { ConflictEvidenceFileHandle, ConflictEvidenceReadableFile, EvidenceFileCodec } from "./scheduleConflictEvidenceFile"

const codec: EvidenceFileCodec<ScheduleResourceEvidence> = {
  maxBytes: RESOURCE_EVIDENCE_MAX_BYTES, serialize: serializeScheduleResourceEvidence, parse: parseScheduleResourceEvidence,
}
/** Saving a local resource snapshot does not enable any rich-content resolution or restore. */
export function createScheduleResourceEvidenceFilePreserver(handle: ConflictEvidenceFileHandle) {
  return createVerifiedEvidenceFilePreserver(handle, codec)
}
export function readScheduleResourceEvidenceFile(file: ConflictEvidenceReadableFile) {
  return readVerifiedEvidenceFile(file, codec)
}
