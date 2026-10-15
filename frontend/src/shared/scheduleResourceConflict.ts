import { parseScheduleCloudResourceReview } from "./scheduleCloudResources"
import type { ScheduleCloudResourceReview } from "./scheduleCloudResources"
import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { checkScheduleResourceEvidence, RESOURCE_EVIDENCE_MAX_BYTES } from "./scheduleResourceEvidence"
import type { ScheduleResourceEvidence } from "./scheduleResourceEvidence"
import { terminalVersionKey } from "./scheduleTerminalConflict"
import type { TerminalConflictChoice } from "./scheduleTerminalConflict"
import { scheduleEntryId } from "./schedules"
import type { Entry } from "./types"

export interface ScheduleResourceConflictEvidence {
  app: "quire"; format: "terminal-matched-resource-conflict-evidence"; formatVersion: 1
  exportedAt: string; scheduleId: string; choice: TerminalConflictChoice
  local: ScheduleResourceEvidence; cloud: unknown
  meaning: "explicit_choice_not_first_intent_confirmation"
}
const same = (a: unknown, b: unknown) => conversionCanonical(a) === conversionCanonical(b)
/** Eligibility only. Actual original/thumbnail bytes must additionally pass the IO SHA-256 check. */
export function matchedResourceChoices(local: ScheduleResourceEvidence, cloud: ScheduleCloudResourceReview): TerminalConflictChoice[] {
  const value = checkScheduleResourceEvidence(local), state = value.state, review = cloud.review
  if (!value.completeLocalResources || value.entryPendingPurge || !cloud.resourcesComplete || cloud.resourceState !== "verified" ||
      !review.reviewable || !review.receiptKnown || review.reason !== "terminal_review" || !review.schedule || !review.entry ||
      !state.source || !state.entry || state.source.status !== "converted" || review.schedule.status !== "converted" ||
      state.source.id !== review.schedule.id || state.source.isDeleted !== review.schedule.isDeleted || state.p2Conflicts.length ||
      state.intentions.length > 1 || !state.candidates.length || state.linkedEntries.length !== 1 ||
      !same(state.entry, state.linkedEntries[0]) || !same(value.mediaIds, cloud.mediaIds) || !same(value.tagIds, cloud.tagIds)) {
    throw new Error("来源、身份、资源集合或其他保护尚不能取舍")
  }
  // Union includes historical candidates and protected IDs, not just the current local body.
  for (const proof of cloud.media) {
    const row = value.media.find(item => item.id === proof.id)
    if (!row || row.entryId !== value.scheduleId || proof.entryId !== value.scheduleId || row.orphanedAt !== null ||
        row.size !== proof.size || row.width !== proof.width || row.height !== proof.height || row.sortOrder !== proof.sortOrder ||
        row.mime !== proof.original.mime || proof.original.state !== "verified" ||
        (proof.thumbnail.state === "not_present" ? row.thumbBase64 !== null :
          proof.thumbnail.state !== "verified" || row.thumbBase64 === null || row.thumbMime !== proof.thumbnail.mime)) {
      throw new Error("媒体身份、元数据或缩略图未匹配")
    }
  }
  for (const proof of cloud.tags) {
    const tag = value.tags.find(row => row.id === proof.id)
    if (!tag || tag.name !== proof.name || tag.color !== proof.color) throw new Error("共享标签定义不同，不能覆写")
  }
  const choices: TerminalConflictChoice[] = []
  if (state.entry.isDeleted === review.entry.isDeleted || state.entry.isDeleted === 1) choices.push("cloud-source-keep-diary")
  if (state.entry.isDeleted === review.entry.isDeleted || review.entry.isDeleted === 1) choices.push("cloud-source-use-diary")
  return choices
}
export function chosenResourceEntry(local: ScheduleResourceEvidence, cloud: ScheduleCloudResourceReview, choice: TerminalConflictChoice, now: string): Entry {
  if (!matchedResourceChoices(local, cloud).includes(choice)) throw new Error("该选择不能恢复或弃去日记")
  if (choice === "cloud-source-use-diary") return { ...conversionCopy(cloud.review.entry!), dirty: 0 }
  const entry = local.state.entry!, remote = cloud.review.entry!
  const previous = Math.max(Date.parse(terminalVersionKey(entry.clientUpdatedAt)), Date.parse(terminalVersionKey(remote.clientUpdatedAt)))
  const revision = conversionUtc(new Date(Math.max(previous + 1, Date.parse(conversionUtc(now)))).toISOString())
  return { ...conversionCopy(entry), updatedAt: revision, clientUpdatedAt: revision, serverUpdatedAt: remote.serverUpdatedAt, dirty: 1 }
}
export function checkResourceConflictEvidence(raw: unknown): ScheduleResourceConflictEvidence {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("资源取舍证据结构无效")
  const row = raw as ScheduleResourceConflictEvidence
  const keys = ["app", "format", "formatVersion", "exportedAt", "scheduleId", "choice", "local", "cloud", "meaning"]
  if (Object.keys(row).some(key => !keys.includes(key)) || keys.some(key => !(key in row)) || row.app !== "quire" ||
      row.format !== "terminal-matched-resource-conflict-evidence" || row.formatVersion !== 1 ||
      typeof row.scheduleId !== "string" || scheduleEntryId(row.scheduleId) !== row.scheduleId ||
      typeof row.exportedAt !== "string" || conversionUtc(row.exportedAt) !== row.exportedAt ||
      row.meaning !== "explicit_choice_not_first_intent_confirmation") throw new Error("不是本版资源取舍证据或含未知字段")
  const local = checkScheduleResourceEvidence(row.local), cloud = parseScheduleCloudResourceReview(row.cloud, row.scheduleId)
  if (local.scheduleId !== row.scheduleId || !matchedResourceChoices(local, cloud).includes(row.choice)) throw new Error("资源取舍身份或选择不一致")
  return conversionCopy(row)
}
/** Read-only structural validation. SHA-256 verification belongs to the asynchronous IO adapter. */
export function parseResourceConflictEvidence(text: string): ScheduleResourceConflictEvidence {
  if (typeof text !== "string" || !text.length || text.length > RESOURCE_EVIDENCE_MAX_BYTES) throw new Error("证据文件为空或过大")
  const value: unknown = JSON.parse(text), stack = [{ value, depth: 0 }]; let count = 0
  while (stack.length) {
    const current = stack.pop()!
    if (++count > 200000 || current.depth > 72) throw new Error("证据文件过深或过大")
    if (current.value && typeof current.value === "object") for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 })
  }
  return checkResourceConflictEvidence(value)
}
export function serializeResourceConflictEvidence(value: ScheduleResourceConflictEvidence): string {
  return `${JSON.stringify(parseResourceConflictEvidence(JSON.stringify(value)))}\n`
}
