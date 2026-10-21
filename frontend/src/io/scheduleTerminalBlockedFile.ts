import { parseTerminalBlockedEvidence, serializeTerminalBlockedEvidence } from "@/shared/scheduleTerminalBlockers"
import type { TerminalBlockedEvidence } from "@/shared/scheduleTerminalBlockers"
import { RESOURCE_EVIDENCE_MAX_BYTES } from "@/shared/scheduleResourceEvidence"
import { createVerifiedEvidenceFilePreserver, readVerifiedEvidenceFile } from "./scheduleConflictEvidenceFile"
import type { ConflictEvidenceFileHandle, ConflictEvidenceReadableFile, EvidenceFileCodec } from "./scheduleConflictEvidenceFile"
const codec: EvidenceFileCodec<TerminalBlockedEvidence>={maxBytes:RESOURCE_EVIDENCE_MAX_BYTES,serialize:serializeTerminalBlockedEvidence,parse:parseTerminalBlockedEvidence}
export function createTerminalBlockedFilePreserver(handle: ConflictEvidenceFileHandle){return createVerifiedEvidenceFilePreserver(handle,codec)}
export function readTerminalBlockedFile(file: ConflictEvidenceReadableFile){return readVerifiedEvidenceFile(file,codec)}
