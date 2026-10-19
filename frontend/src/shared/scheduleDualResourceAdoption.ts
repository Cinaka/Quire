import { assertDualResourceTarget, checkDualResourceEvidence } from "./scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "./scheduleDualResourceEvidence"
import { conversionCanonical } from "./scheduleConversionSync"

/** Structural eligibility, never authorization by the file alone. IO/live checks remain mandatory. */
export function assertDualCloudAdoption(evidence: ScheduleDualResourceEvidence) {
  const value = checkDualResourceEvidence(evidence), local = value.local, state = local.state
  const cloud = assertDualResourceTarget(local, value.cloud)
  if (!cloud.media.length || state.linkedEntries.length !== 1 || !state.entry ||
      conversionCanonical(state.entry) !== conversionCanonical(state.linkedEntries[0]) ||
      state.intentions.length > 1 || !state.candidates.length || state.p2Conflicts.length ||
      conversionCanonical([...local.mediaIds].sort()) !== conversionCanonical(cloud.mediaIds) ||
      conversionCanonical([...local.tagIds].sort()) !== conversionCanonical(cloud.tagIds)) {
    throw new Error("图片集合、稳定关联或其他保护尚不能采用云端版本")
  }
  for (const media of local.media) {
    if (media.entryId !== value.scheduleId || media.orphanedAt !== null) throw new Error("孤儿或其他归属媒体不能替换")
  }
  for (const proof of cloud.tags) {
    const tag = local.tags.find(item => item.id === proof.id)
    if (!tag || tag.name !== proof.name || tag.color !== proof.color) throw new Error("共享标签不同，不能覆盖")
  }
  return cloud
}
