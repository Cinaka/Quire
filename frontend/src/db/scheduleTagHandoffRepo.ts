import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleTagHandoffTransport } from "@/api/scheduleTagPublicationTransport"
import { readDualResourceEvidenceFile, verifyIndependentTagLocalImages } from "@/io/scheduleDualResourceEvidenceFile"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { resourceRepairBlob } from "@/io/scheduleResourceRepairFile"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { assertDualResourceAdoptionBase, independentTagImageSets, independentTagLocalImageIds, planIndependentTagLocalImages } from "@/shared/scheduleDualResourceAdoption"
import { newId } from "@/shared/ids"
import type { SharedTagCopyRecord } from "@/shared/scheduleSharedTagCopy"
import { sharedTagNameKey } from "@/shared/scheduleSharedTagCopy"
import { independentTagHandoffEntry, makeTagPublicationRequest, parseTagPublicationReceipt, TAG_HANDOFF_KIND } from "@/shared/scheduleTagPublication"
import type { TagPublicationRecord, TagHandoffRecord } from "@/shared/scheduleTagPublication"
import { terminalVersionKey } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"

import { assertExclusiveMedia } from "./scheduleDualResourceAdoptionRepo"
import { captureSharedTagCopySnapshot, readSharedTagCopyArchive } from "./scheduleSharedTagCopyRepo"
import { sharedTagPlanDigest } from "./scheduleTagPublicationRepo"
import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db, scheduleResourceTransactionAborter } from "./schema"

const same = (a: unknown, b: unknown) => conversionCanonical(a) === conversionCanonical(b)
const localKey = (value: SharedTagCopyRecord["evidence"]["local"]) => {
  const { exportedAt: _time, ...rest } = value
  return conversionCanonical(rest)
}
interface Ticket {
  plan: SharedTagCopyRecord; publication: TagPublicationRecord; fingerprint: string
  lease: ConversionLease; file: ConflictEvidenceReadableFile
}
/** Internal explicit local reference handoff. No server diary write or original tag mutation. */
export function createInternalIndependentTagHandoff(transport: ScheduleTagHandoffTransport) {
  let active: Ticket | null = null, busy = false, serial = 0, operation = 0
  let abortWrite: (() => void) | null = null, controller: AbortController | null = null
  const guard = (run: number) => { if (run !== operation) throw new Error("标签交接已取消") }
  const check = async (ticket: Ticket, run: number) => { guard(run); await assertScheduleLease(ticket.lease); guard(run) }
  const verify = async (ticket: Ticket, run: number, write = false) => {
    const snapshot = await captureSharedTagCopySnapshot(ticket.plan.scheduleId, ticket.lease, write)
    await check(ticket, run)
    if (snapshot.fingerprint !== ticket.fingerprint || localKey(snapshot.local) !== localKey(ticket.plan.evidence.local) ||
        !same(snapshot.catalog, ticket.plan.catalog)) throw new Error("本机正文、目录或实物已变化")
    const saved = await readSharedTagCopyArchive()
    if (!same(saved.plans.find(row => row.id === ticket.plan.id), ticket.plan) ||
        !same(saved.publications.find(row => row.planId === ticket.plan.id), ticket.publication) ||
        saved.handoffs.some(row => row.planId === ticket.plan.id) ||
        saved.plans.some(row => row.id !== ticket.plan.id && row.scheduleId === ticket.plan.scheduleId && row.state === "prepared")) throw new Error("交接计划、发布或其他准备已变化")
    const cloud = assertDualResourceAdoptionBase(ticket.plan.evidence), id = ticket.plan.scheduleId
    await assertExclusiveMedia(id, [...new Set([...ticket.plan.evidence.local.mediaIds, ...cloud.mediaIds])])
    for (const remoteId of independentTagImageSets(ticket.plan.evidence).cloudOnly) {
      if (await db.media.get(remoteId) || await db.tags.get(remoteId) || await db.entries.get(remoteId) || await db.schedules.get(remoteId)) throw new Error("云端图片身份在本机占用")
    }
    for (const copy of ticket.plan.copies) {
      if (await db.tags.get(copy.tag.id) || await db.entries.get(copy.tag.id) || await db.schedules.get(copy.tag.id) || await db.media.get(copy.tag.id)) throw new Error("独立标签身份在本机已占用")
      if (snapshot.catalog.some(tag => sharedTagNameKey(tag.name) === sharedTagNameKey(copy.tag.name))) throw new Error("独立标签名称在本机占用")
      await assertExclusiveMedia(id, [copy.tag.id], "独立标签身份")
    }
    const source = snapshot.local.state.source!, entry = snapshot.local.state.entry!, base = await readScheduleServerState(ticket.lease, id)
    const remote = cloud.review.schedule!, diary = cloud.review.entry!
    if ((base && terminalVersionKey(base.serverUpdatedAt) > terminalVersionKey(remote.serverUpdatedAt)) ||
        (source.serverUpdatedAt && terminalVersionKey(source.serverUpdatedAt) > terminalVersionKey(remote.serverUpdatedAt)) ||
        (entry.serverUpdatedAt && terminalVersionKey(entry.serverUpdatedAt) > terminalVersionKey(diary.serverUpdatedAt)) ||
        (base && terminalVersionKey(base.serverUpdatedAt) === terminalVersionKey(remote.serverUpdatedAt) && !same(base, remote))) throw new Error("云端证明落后或同水位矛盾")
    await check(ticket, run)
    return saved
  }
  const fileCheck = async (ticket: Ticket, run: number) => {
    if (!same(await readDualResourceEvidenceFile(ticket.file), ticket.plan.evidence)) throw new Error("双方实物文件已变化")
    await check(ticket, run)
    if (ticket.plan.choice === "cloud-source-keep-diary") { await verifyIndependentTagLocalImages(ticket.plan.evidence); await check(ticket, run) }
  }
  const presence = async (ticket: Ticket, run: number) => {
    const wire = conversionCopy(await transport.review(ticket.plan.scheduleId, conversionCopy(ticket.lease)))
    await check(ticket, run)
    const request = makeTagPublicationRequest(ticket.plan, wire)
    if (!same(request, ticket.publication.request)) throw new Error("原wire证明已变化")
    controller = new AbortController()
    const receipt = conversionCopy(await transport.checkTags(ticket.plan.scheduleId, request, conversionCopy(ticket.lease), controller.signal))
    await check(ticket, run)
    const tags = parseTagPublicationReceipt(receipt, ticket.plan), historical = parseTagPublicationReceipt(ticket.publication.receipt, ticket.plan)
    if (tags.some((tag, index) => tag.created || tag.createdAt !== historical[index]!.createdAt)) throw new Error("标签缺失、重建或并非只读核对")
    return { receipt, tags }
  }
  return {
    cancel() { operation++; serial++; active = null; controller?.abort(); try { abortWrite?.() } catch { /* No completed commit is undone. */ } },
    async review(planId: string, file: ConflictEvidenceReadableFile) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0 }
      busy = true; active = null; const run = ++operation, reviewId = ++serial
      try {
        const lease = await captureSyncContext(), saved = await readSharedTagCopyArchive(); guard(run); await assertScheduleLease(lease); guard(run)
        const plan = saved.plans.find(row => row.id === planId), publication = saved.publications.find(row => row.planId === planId)
        if (!plan || plan.ownerUserId !== lease.ownerUserId || plan.generation !== lease.generation || plan.state !== "prepared" ||
            !publication || publication.state !== "confirmed" || await sharedTagPlanDigest(plan) !== publication.planDigest) throw new Error("需要本代际原准备与已确认发布")
        const snapshot = await captureSharedTagCopySnapshot(plan.scheduleId, lease)
        const ticket = { plan, publication, lease, file, fingerprint: snapshot.fingerprint }
        await fileCheck(ticket, run); await verify(ticket, run); await presence(ticket, run); await verify(ticket, run)
        active = ticket
        return { ready: true, reviewId, reason: "explicit_independent_tag_handoff", choice: plan.choice,
          tagIds: plan.copies.map(copy => copy.tag.id), serverDiaryChanged: false }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "tag_handoff_protected", reviewId: 0 } }
      finally { busy = false; controller = null }
    },
    async resolve(reviewId: number, choice: string, confirmed: boolean) {
      if (busy) return { applied: false, reason: "busy" }
      if (!active || reviewId !== serial || choice !== active.plan.choice || confirmed !== true) return { applied: false, reason: "explicit_tag_handoff_choice_required" }
      busy = true; const ticket = active, run = ++operation
      try {
        await check(ticket, run); await fileCheck(ticket, run); await verify(ticket, run)
        const fresh = await presence(ticket, run)
        await fileCheck(ticket, run); await verify(ticket, run)
        await db.transaction("rw", db.entries, db.schedules, db.tags, db.media, db.meta, async () => {
          abortWrite = scheduleResourceTransactionAborter()
          const saved = await verify(ticket, run, true), plan = ticket.plan, id = plan.scheduleId, evidence = plan.evidence
          const cloud = assertDualResourceAdoptionBase(evidence), mapping = new Map<string, string>(), at = conversionUtc(new Date().toISOString())
          if (plan.choice === "cloud-source-keep-diary") for (const from of independentTagLocalImageIds(evidence)) {
            const to = newId()
            if (scheduleEntryId(to) !== to || to === plan.id || [...mapping.values()].includes(to) ||
                [...evidence.local.mediaIds, ...cloud.mediaIds, ...plan.originalTagIds, ...plan.copies.map(copy => copy.tag.id)].includes(to) ||
                saved.plans.some(row => row.id === to || row.copies.some(copy => copy.tag.id === to)) ||
                await db.entries.get(to) || await db.schedules.get(to) || await db.tags.get(to) || await db.media.get(to)) throw new Error("新图片身份已占用")
            mapping.set(from, to); await check(ticket, run)
          }
          if (mapping.size) await assertExclusiveMedia(id, [...mapping.values()])
          await check(ticket, run)
          const result = independentTagHandoffEntry(plan, mapping, at)
          const record: TagHandoffRecord = { kind: TAG_HANDOFF_KIND, version: 1, planId: plan.id, scheduleId: id,
            ownerUserId: ticket.lease.ownerUserId, generation: ticket.lease.generation, at, receipt: fresh.receipt,
            mediaMap: [...mapping].map(([from, to]) => ({ from, to })), entry: result }
          // Archive both physical versions before touching any live reference or image row.
          await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: [...saved.rows, record] }); await check(ticket, run)
          for (const tag of fresh.tags) {
            await db.tags.add({ id: tag.id, name: tag.name, color: tag.color, createdAt: tag.createdAt, dirty: 0 })
            await check(ticket, run)
          }
          if (plan.choice === "cloud-source-keep-diary") {
            const localPlan = planIndependentTagLocalImages(evidence, mapping, at)
            for (const old of evidence.local.mediaIds) { await db.media.delete(old); await check(ticket, run) }
            for (const media of localPlan.media) {
              await db.media.add({ id: media.id, entryId: id, mime: media.mime, width: media.width, height: media.height,
                size: media.size, sortOrder: media.sortOrder, createdAt: media.createdAt, dirty: 1, orphanedAt: null,
                remoteUrl: "", thumbRemoteUrl: "", blob: resourceRepairBlob(media.blobBase64, media.mime),
                thumbBlob: media.thumbBase64 === null ? null : resourceRepairBlob(media.thumbBase64, media.thumbMime!) })
              await check(ticket, run)
            }
          } else {
            for (const old of independentTagImageSets(evidence).localOnly) { await db.media.delete(old); await check(ticket, run) }
            for (const media of evidence.cloudMedia) {
              const row = { id: media.id, entryId: id, mime: media.mime, width: media.width, height: media.height,
                size: media.size, sortOrder: media.sortOrder, createdAt: media.createdAt, dirty: 0 as const, orphanedAt: null,
                remoteUrl: "", thumbRemoteUrl: "", blob: resourceRepairBlob(media.blobBase64, media.mime),
                thumbBlob: media.thumbBase64 === null ? null : resourceRepairBlob(media.thumbBase64, media.thumbMime!) }
              if (evidence.local.mediaIds.includes(media.id)) await db.media.put(row)
              else await db.media.add(row)
              await check(ticket, run)
            }
          }
          await rememberScheduleServerState(ticket.lease, cloud.review.schedule!); await check(ticket, run)
          await db.schedules.put({ ...conversionCopy(cloud.review.schedule!), contentText: toPlainText(cloud.review.schedule!.content), dirty: 0 }); await check(ticket, run)
          await db.entries.put(result); await check(ticket, run)
          const queue = await readCheckedConversionQueue(ticket.lease.ownerUserId)
          await db.meta.put({ key: SCHEDULE_META_KEYS.conversions, value: queue.filter(row => row.scheduleId !== id) }); await check(ticket, run)
          const candidates = await db.meta.get(SCHEDULE_META_KEYS.conflicts), rows = candidates ? candidates.value : []
          if (!Array.isArray(rows)) throw new Error("候选留档损坏")
          await db.meta.put({ key: SCHEDULE_META_KEYS.conflicts, value: rows.filter(row => !row || typeof row !== "object" || !("scheduleId" in row) || row.scheduleId !== id) }); await check(ticket, run)
        })
        active = null
        return { applied: true, reason: "independent_tag_references_ready_for_p2", serverDiaryChanged: false,
          cloudSynced: false, originalSharedResourcesHeld: true }
      } catch { active = null; return { applied: false, reason: run !== operation ? "cancelled_recheck" : "tag_handoff_unconfirmed_keep_protection" } }
      finally { busy = false; abortWrite = null; controller = null }
    },
  }
}
