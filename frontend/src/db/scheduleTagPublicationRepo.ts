import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleTagPublicationTransport } from "@/api/scheduleTagPublicationTransport"
import { readDualResourceEvidenceFile } from "@/io/scheduleDualResourceEvidenceFile"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import type { SharedTagCopyRecord } from "@/shared/scheduleSharedTagCopy"
import { makeTagPublicationRequest, parseTagPublicationReceipt, TAG_PUBLICATION_KIND } from "@/shared/scheduleTagPublication"
import type { TagPublicationRecord, TagPublicationRequest } from "@/shared/scheduleTagPublication"

import { captureSharedTagCopySnapshot, readSharedTagCopyArchive } from "./scheduleSharedTagCopyRepo"
import { assertScheduleLease } from "./scheduleSyncStateRepo"
import { db, scheduleResourceTransactionAborter } from "./schema"

const same = (a: unknown, b: unknown) => conversionCanonical(a) === conversionCanonical(b)
const localKey = (value: SharedTagCopyRecord["evidence"]["local"]) => {
  const { exportedAt: _time, ...rest } = value
  return conversionCanonical(rest)
}
export async function sharedTagPlanDigest(plan: SharedTagCopyRecord) {
  const bytes = await new Blob([conversionCanonical(plan)]).arrayBuffer()
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}
interface Ticket {
  plan: SharedTagCopyRecord; digest: string; lease: ConversionLease; file: ConflictEvidenceReadableFile
  fingerprint: string; request: TagPublicationRequest
}
/** Explicit durable POST only. Never installs live Tags, remaps diaries or releases a hold. */
export function createInternalScheduleTagPublisher(transport: ScheduleTagPublicationTransport) {
  let active: Ticket | null = null, busy = false, serial = 0, operation = 0
  let abortWrite: (() => void) | null = null, requestController: AbortController | null = null
  const guard = (run: number) => { if (run !== operation) throw new Error("标签发布已取消，结果需重新核对") }
  const check = async (run: number, lease: ConversionLease) => { guard(run); await assertScheduleLease(lease); guard(run) }
  const fileCheck = async (ticket: Ticket, run: number) => {
    const file = await readDualResourceEvidenceFile(ticket.file); await check(run, ticket.lease)
    if (!same(file, ticket.plan.evidence)) throw new Error("原双方实物文件已变化")
  }
  const verify = async (ticket: Ticket, run: number, write = false) => {
    const current = await captureSharedTagCopySnapshot(ticket.plan.scheduleId, ticket.lease, write)
    await check(run, ticket.lease)
    if (current.fingerprint !== ticket.fingerprint || localKey(current.local) !== localKey(ticket.plan.evidence.local) ||
        !same(current.catalog, ticket.plan.catalog)) throw new Error("本机正文、实物、目录或保护已变化")
    const saved = await readSharedTagCopyArchive(), plan = saved.plans.find(row => row.id === ticket.plan.id)
    if (!same(plan, ticket.plan)) throw new Error("独立命名准备已变化")
    const prior = saved.publications.find(row => row.planId === ticket.plan.id)
    if (prior && (prior.planDigest !== ticket.digest || !same(prior.request, ticket.request))) throw new Error("发布请求与原准备不同")
    await check(run, ticket.lease)
    return saved
  }
  return {
    cancel() {
      operation++; serial++; active = null; requestController?.abort()
      try { abortWrite?.() } catch { /* A committed server operation cannot be undone by cancellation. */ }
    },
    async list() {
      const lease = await captureSyncContext(), saved = await readSharedTagCopyArchive(); await assertScheduleLease(lease)
      return saved.publications.filter(row => row.ownerUserId === lease.ownerUserId).map(row => ({
        planId: row.planId, scheduleId: row.scheduleId, state: row.state,
        currentEpoch: row.generation === lease.generation, historicalConfirmation: row.state === "confirmed",
        requiresRecheck: true, referencesHandedOff: saved.handoffs.some(item => item.planId === row.planId),
        resolutionEnabled: false, diarySyncEnabled: false,
      }))
    },
    async review(planId: string, file: ConflictEvidenceReadableFile) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0 }
      busy = true; active = null; const run = ++operation, reviewId = ++serial
      try {
        const lease = await captureSyncContext(), saved = await readSharedTagCopyArchive(); await check(run, lease)
        const plan = saved.plans.find(row => row.id === planId)
        if (saved.handoffs.some(row => row.planId === planId) || !plan || plan.state !== "prepared" || plan.ownerUserId !== lease.ownerUserId || plan.generation !== lease.generation) throw new Error("旧准备不能发布")
        const fileValue = await readDualResourceEvidenceFile(file); await check(run, lease)
        if (!same(fileValue, plan.evidence)) throw new Error("请重读原双方实物文件")
        const current = await captureSharedTagCopySnapshot(plan.scheduleId, lease), digest = await sharedTagPlanDigest(plan)
        await check(run, lease)
        const wire = conversionCopy(await transport.review(plan.scheduleId, conversionCopy(lease))); await check(run, lease)
        const request = makeTagPublicationRequest(plan, wire), ticket = { plan, digest, lease, file, fingerprint: current.fingerprint, request }
        const latest = await verify(ticket, run)
        active = ticket
        return { ready: true, reason: "explicit_tag_publication_ready", reviewId, planId, copies: conversionCopy(plan.copies),
          historicalConfirmation: latest.publications.some(row => row.planId === planId && row.state === "confirmed"),
          resolutionEnabled: false, diarySyncEnabled: false }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "tag_publication_protected", reviewId: 0 } }
      finally { busy = false }
    },
    async publish(reviewId: number, confirmed: boolean) {
      if (busy) return { tagsConfirmed: false, reason: "busy", requiresRecheck: true }
      if (!active || serial !== reviewId || confirmed !== true) return { tagsConfirmed: false, reason: "explicit_publication_confirmation_required", requiresRecheck: true }
      busy = true; const ticket = active, run = ++operation
      try {
        await check(run, ticket.lease); await fileCheck(ticket, run); await verify(ticket, run)
        const wire = conversionCopy(await transport.review(ticket.plan.scheduleId, conversionCopy(ticket.lease))); await check(run, ticket.lease)
        if (!same(makeTagPublicationRequest(ticket.plan, wire), ticket.request)) throw new Error("原始wire证明已变化")
        await db.transaction("rw", db.entries, db.schedules, db.tags, db.media, db.meta, async () => {
          abortWrite = scheduleResourceTransactionAborter()
          const saved = await verify(ticket, run, true)
          if (!saved.publications.some(row => row.planId === ticket.plan.id)) {
            const intent: TagPublicationRecord = { kind: TAG_PUBLICATION_KIND, version: 1, planId: ticket.plan.id,
              scheduleId: ticket.plan.scheduleId, ownerUserId: ticket.lease.ownerUserId, generation: ticket.lease.generation,
              planDigest: ticket.digest, createdAt: conversionUtc(new Date().toISOString()), state: "started", request: conversionCopy(ticket.request), receipt: null }
            await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: [...saved.rows, intent] })
            await check(run, ticket.lease)
          }
        })
        abortWrite = null
        // The durable started record is a safety fence, not an assumption that POST failed/succeeded.
        await verify(ticket, run); await check(run, ticket.lease)
        requestController = new AbortController()
        const receipt = conversionCopy(await transport.publish(ticket.plan.scheduleId, conversionCopy(ticket.request), conversionCopy(ticket.lease), requestController.signal))
        await check(run, ticket.lease)
        const tags = parseTagPublicationReceipt(receipt, ticket.plan)
        await fileCheck(ticket, run)
        await db.transaction("rw", db.entries, db.schedules, db.tags, db.media, db.meta, async () => {
          abortWrite = scheduleResourceTransactionAborter()
          const saved = await verify(ticket, run, true), prior = saved.publications.find(row => row.planId === ticket.plan.id)
          if (!prior) throw new Error("发布意图缺失，未确认本机状态")
          if (prior.state === "confirmed") {
            const before = parseTagPublicationReceipt(prior.receipt, ticket.plan)
            if (before.some((tag, index) => tag.createdAt !== tags[index]!.createdAt)) throw new Error("云端标签创建身份已变化")
          }
          const next: TagPublicationRecord = { ...prior, state: "confirmed", receipt }
          await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: saved.rows.map(row => row && typeof row === "object" && "kind" in row && row.kind === TAG_PUBLICATION_KIND && "planId" in row && row.planId === ticket.plan.id ? next : row) })
          await check(run, ticket.lease)
        })
        await check(run, ticket.lease)
        active = null
        return { tagsConfirmed: true, reason: "tag_presence_confirmed_not_diary_handoff", planId: ticket.plan.id, tags,
          requiresRecheck: true, resolutionEnabled: false, diarySyncEnabled: false }
      } catch { active = null; return { tagsConfirmed: false, reason: run !== operation ? "cancelled_recheck" : "tag_publication_uncertain_keep_intent", requiresRecheck: true,
        resolutionEnabled: false, diarySyncEnabled: false } }
      finally { busy = false; abortWrite = null; requestController = null }
    },
  }
}
