import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { assertDualResourceTarget } from "./scheduleDualResourceEvidence"
import { sharedTagCopyArchivePlans } from "./scheduleSharedTagCopy"
import type { SharedTagCopyRecord } from "./scheduleSharedTagCopy"
import { terminalVersionKey } from "./scheduleTerminalConflict"

export const TAG_PUBLICATION_KIND = "terminal-independent-tag-publication"
export interface TagPublicationRequest {
  plan_id: string; choice: SharedTagCopyRecord["choice"]; confirmed: true
  expected_resources: unknown
  copies: Array<{ from_tag_id: string; id: string; name: string; color: string | null }>
}
export interface TagPublicationRecord {
  kind: typeof TAG_PUBLICATION_KIND; version: 1; planId: string; scheduleId: string
  ownerUserId: string; generation: string; planDigest: string; createdAt: string
  state: "started" | "confirmed"; request: TagPublicationRequest; receipt: unknown
}
function object(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !(key in raw))) {
    throw new Error("标签发布记录或响应字段未知")
  }
  return raw as Record<string, unknown>
}
export function makeTagPublicationRequest(plan: SharedTagCopyRecord, wire: unknown): TagPublicationRequest {
  const current = assertDualResourceTarget(plan.evidence.local, wire)
  if (conversionCanonical(current) !== conversionCanonical(assertDualResourceTarget(plan.evidence.local, plan.evidence.cloud)) ||
      new Blob([conversionCanonical(wire)]).size > 1024 * 1024) throw new Error("资源证明已变化或过大")
  return conversionCopy({ plan_id: plan.id, choice: plan.choice, confirmed: true,
    expected_resources: wire, copies: plan.copies.map(copy => ({ from_tag_id: copy.from, id: copy.tag.id, name: copy.tag.name, color: copy.tag.color })) })
}
function timestamp(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)?$/.test(raw)) throw new Error("发布时间无效")
  const utc = raw.endsWith("+00:00") ? `${raw.slice(0, -6)}Z` : raw.endsWith("Z") ? raw : `${raw}Z`
  return terminalVersionKey(utc)
}
export function parseTagPublicationReceipt(raw: unknown, plan: SharedTagCopyRecord) {
  const row = object(raw, ["proof_scope", "tags_confirmed", "resolution_enabled", "diary_sync_enabled", "schedule_id", "plan_id", "tags"])
  if (row.proof_scope !== "independent_tag_presence" || row.tags_confirmed !== true || row.resolution_enabled !== false ||
      row.diary_sync_enabled !== false || row.schedule_id !== plan.scheduleId || row.plan_id !== plan.id ||
      !Array.isArray(row.tags) || row.tags.length !== plan.copies.length) throw new Error("标签发布并非本准备的存在确认")
  return row.tags.map((value, index) => {
    const tag = object(value, ["from_tag_id", "id", "name", "color", "created_at", "created"]), expected = plan.copies[index]!
    if (tag.from_tag_id !== expected.from || tag.id !== expected.tag.id || tag.name !== expected.tag.name ||
        tag.color !== expected.tag.color || typeof tag.created !== "boolean") throw new Error("发布标签与明确命名不一致")
    return { from: expected.from, id: expected.tag.id, name: expected.tag.name, color: expected.tag.color,
      createdAt: timestamp(tag.created_at), created: tag.created }
  })
}
/** Pure safety validation. The publisher additionally verifies the cryptographic plan digest. */
export function readTagSafetyArchive(rows: unknown[]) {
  const plans = sharedTagCopyArchivePlans(rows), seen = new Set<string>()
  const publications = rows.filter(raw => raw && typeof raw === "object" && "kind" in raw && raw.kind === TAG_PUBLICATION_KIND).map(raw => {
    const row = object(raw, ["kind", "version", "planId", "scheduleId", "ownerUserId", "generation", "planDigest", "createdAt", "state", "request", "receipt"])
    const plan = plans.find(plan => plan.id === row.planId)
    if (!plan || plan.state !== "prepared" || seen.has(plan.id) || row.version !== 1 || row.scheduleId !== plan.scheduleId ||
        row.ownerUserId !== plan.ownerUserId || row.generation !== plan.generation || typeof row.planDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.planDigest) || typeof row.createdAt !== "string" || conversionUtc(row.createdAt) !== row.createdAt ||
        !["started", "confirmed"].includes(row.state as string)) throw new Error("标签发布归属、准备或状态损坏")
    seen.add(plan.id)
    const request = object(row.request, ["plan_id", "choice", "confirmed", "expected_resources", "copies"])
    if (conversionCanonical(request) !== conversionCanonical(makeTagPublicationRequest(plan, request.expected_resources))) throw new Error("发布请求不是原独立命名")
    if (row.state === "started" ? row.receipt !== null : row.receipt === null) throw new Error("发布回执状态不一致")
    if (row.receipt !== null) parseTagPublicationReceipt(row.receipt, plan)
    return conversionCopy(row) as unknown as TagPublicationRecord
  })
  return { plans, publications }
}
