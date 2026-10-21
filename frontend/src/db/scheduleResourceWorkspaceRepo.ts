import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceImageTransport } from "@/api/scheduleCloudResourceImageTransport"
import type { ScheduleTagPublicationTransport, ScheduleTagHandoffTransport } from "@/api/scheduleTagPublicationTransport"
import { readDualResourceEvidenceFile } from "@/io/scheduleDualResourceEvidenceFile"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { conversionCanonical, conversionCopy } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { assertDualResourceAdoptionBase } from "@/shared/scheduleDualResourceAdoption"
import { assertDualResourceTarget } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "@/shared/scheduleDualResourceEvidence"
import type { ResourceWorkspacePort, ResourceWorkspacePreview, ResourceWorkspaceResult, ResourceWorkspaceEntry } from "@/shared/scheduleResourceWorkspaceTypes"
import type { SharedTagCopyChoice } from "@/shared/scheduleSharedTagCopy"
import { scheduleEntryId } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"
import type { Entry } from "@/shared/types"

import { createInternalDualResourceEvidenceExporter } from "./scheduleDualResourceEvidenceRepo"
import { assertExclusiveMedia, createInternalDualResourceCloudAdopter, createInternalDualResourceLocalKeeper } from "./scheduleDualResourceAdoptionRepo"
import { captureSharedTagCopySnapshot, createInternalSharedTagCopyPreparer, readSharedTagCopyArchive } from "./scheduleSharedTagCopyRepo"
import { createInternalScheduleTagPublisher } from "./scheduleTagPublicationRepo"
import { createInternalIndependentTagHandoff } from "./scheduleTagHandoffRepo"
import { assertScheduleLease } from "./scheduleSyncStateRepo"

const choices: SharedTagCopyChoice[] = ["cloud-source-use-diary", "cloud-source-keep-diary"]
const same = (a: unknown, b: unknown) => conversionCanonical(a) === conversionCanonical(b)
const localKey = (value: ScheduleDualResourceEvidence["local"]) => { const { exportedAt: _time, ...rest } = value; return conversionCanonical(rest) }
const failed = (): ResourceWorkspaceResult => ({ ok: false, outcome: "not_confirmed", cloudSynced: false })
function previewEntry(entry: Entry, tags: ResourceWorkspaceEntry["tags"]): ResourceWorkspaceEntry {
  return { title: entry.title, date: entry.entryDate, text: toPlainText(entry.content).slice(0, 12000), tags: conversionCopy(tags) }
}
/** One fixed-source, first-explicit-use pinned session. Construction never reads, downloads or writes. */
export function createInternalResourceWorkspace(id: string,
  transport: ScheduleCloudResourceImageTransport & ScheduleTagPublicationTransport & ScheduleTagHandoffTransport): ResourceWorkspacePort {
  if (scheduleEntryId(id) !== id) throw new Error("固定来源身份无效")
  let lease: ConversionLease | null = null, busy = false, revision = 0
  const check = async (run: number) => {
    if (run !== revision || !lease) throw new Error("资源工作区上下文已失效")
    await assertScheduleLease(lease)
    if (run !== revision) throw new Error("资源工作区已取消")
  }
  const requestCheck = async (target: string, candidate: ConversionLease, run: number) => {
    if (target !== id || !lease || !same(candidate, lease)) throw new Error("子操作不能重绑固定工作区账号")
    await check(run)
  }
  // Child controllers capture leases independently. Fence their transports too, so a
  // same-owner relogin during a child capture cannot issue even a GET under a new token.
  const pinned: ScheduleCloudResourceImageTransport & ScheduleTagPublicationTransport & ScheduleTagHandoffTransport = {
    async review(target, candidate) { const run = revision; await requestCheck(target, candidate, run)
      const response = await transport.review(target, candidate); await requestCheck(target, candidate, run); return response },
    async image(target, mediaId, variant, proof, candidate, signal) { const run = revision; await requestCheck(target, candidate, run)
      const response = await transport.image(target, mediaId, variant, proof, candidate, signal); await requestCheck(target, candidate, run); return response },
    async publish(target, body, candidate, signal) { const run = revision; await requestCheck(target, candidate, run)
      const response = await transport.publish(target, body, candidate, signal); await requestCheck(target, candidate, run); return response },
    async checkTags(target, body, candidate, signal) { const run = revision; await requestCheck(target, candidate, run)
      const response = await transport.checkTags(target, body, candidate, signal); await requestCheck(target, candidate, run); return response },
  }
  const exporter = createInternalDualResourceEvidenceExporter(pinned), preparer = createInternalSharedTagCopyPreparer(pinned)
  const publisher = createInternalScheduleTagPublisher(pinned), handoff = createInternalIndependentTagHandoff(pinned)
  const adopters = { "cloud-source-use-diary": createInternalDualResourceCloudAdopter(pinned),
    "cloud-source-keep-diary": createInternalDualResourceLocalKeeper(pinned) }
  const begin = async () => { const run = ++revision; if (!lease) lease = await captureSyncContext(); await check(run); return run }
  const cancelChildren = () => { exporter.cancel(); preparer.cancel(); publisher.cancel(); handoff.cancel(); for (const item of Object.values(adopters)) item.cancel() }
  const read = async (file: ConflictEvidenceReadableFile, run: number) => {
    const value = await readDualResourceEvidenceFile(file); await check(run)
    if (value.scheduleId !== id) throw new Error("证据属于其他来源")
    return value
  }
  const exclusive = async (value: ScheduleDualResourceEvidence, run: number) => {
    const cloud = assertDualResourceAdoptionBase(value)
    await assertExclusiveMedia(id, [...new Set([...value.local.mediaIds, ...cloud.mediaIds])]); await check(run)
  }
  const selectedPlan = async (file: ConflictEvidenceReadableFile, planId: string, run: number) => {
    const value = await read(file, run), saved = await readSharedTagCopyArchive(); await check(run)
    const plan = saved.plans.find(row => row.id === planId)
    if (!plan || plan.scheduleId !== id || plan.ownerUserId !== lease!.ownerUserId || plan.generation !== lease!.generation ||
        plan.state !== "prepared" || !same(plan.evidence, value) || saved.handoffs.some(row => row.planId === planId)) throw new Error("当前来源没有可续接原准备")
    return plan
  }
  const act = async (confirmed: boolean, task: (run: number) => Promise<ResourceWorkspaceResult>) => {
    if (busy || confirmed !== true) return failed()
    busy = true
    try { const run = await begin(); const result = await task(run); await check(run); return result }
    catch { return failed() }
    finally { busy = false; cancelChildren() }
  }
  return {
    cancel() { revision++; cancelChildren() },
    async prepareEvidence(confirmed) {
      if (busy || confirmed !== true) return { ready: false, reviewId: 0 }
      busy = true
      try { const run = await begin(), result = await exporter.prepare(id, true); await check(run)
        return { ready: result.ready === true && result.reason === "both_resource_versions_prepared", reviewId: result.ready ? result.reviewId : 0 }
      } catch { return { ready: false, reviewId: 0 } } finally { busy = false }
    },
    async saveEvidence(reviewId, handle) {
      if (busy) return { saved: false }
      busy = true
      try { const run = await begin(), result = await exporter.save(reviewId, true, handle); await check(run)
        return { saved: result.saved === true && result.reason === "both_versions_file_verified_protection_retained" }
      } catch { return { saved: false } } finally { busy = false }
    },
    async inspect(file) {
      if (busy) throw new Error("操作尚未结束")
      busy = true
      try {
        const run = await begin(), evidence = await read(file, run), cloud = assertDualResourceAdoptionBase(evidence)
        const saved = await readSharedTagCopyArchive(); await check(run)
        const plans = saved.plans.filter(row => row.scheduleId === id && row.ownerUserId === lease!.ownerUserId && row.state === "prepared")
        if (plans.length > 1) throw new Error("多个原准备需要另行处理")
        const plan = plans[0], publication = saved.publications.find(row => row.planId === plan?.id)
        const historical = saved.handoffs.some(row => row.planId === plan?.id)
        const result: ResourceWorkspacePreview = { sourceId: id,
          local: previewEntry(evidence.local.state.entry!, evidence.local.tags.map(({ id, name, color }) => ({ id, name, color }))),
          cloud: previewEntry(cloud.review.entry!, cloud.tags.map(({ id, name, color }) => ({ id, name, color }))),
          localMediaCount: evidence.local.mediaIds.length, cloudMediaCount: cloud.mediaIds.length,
          directChoices: [], independentChoices: [], blockers: [], plan: plan ? { id: plan.id, choice: plan.choice, names: conversionCopy(plan.names),
            stage: historical ? "handed-off" : plan.generation !== lease!.generation ? "stale" : publication?.state ?? "prepared" } : null }
        if (plan && !same(plan.evidence, evidence)) throw new Error("文件不是原命名准备证据")
        if (historical) { result.blockers = ["historical_handoff"]; return result }
        if (plan && plan.generation !== lease!.generation) { result.blockers = ["stale_plan"]; return result }
        const current = await captureSharedTagCopySnapshot(id, lease!); await check(run)
        const wire = await pinned.review(id, conversionCopy(lease!)); await check(run)
        if (localKey(current.local) !== localKey(evidence.local) || !same(assertDualResourceTarget(evidence.local, wire), cloud)) {
          result.blockers = ["current_state_changed"]; return result
        }
        try { await assertExclusiveMedia(id, [...new Set([...evidence.local.mediaIds, ...cloud.mediaIds])]); await check(run) }
        catch { await check(run); result.blockers = ["shared_images"]; return result }
        if (!plan) {
          for (const choice of choices) {
            const review = await adopters[choice].review(id, file); await check(run)
            if (review.ready === true) result.directChoices.push(choice)
            adopters[choice].cancel()
          }
          const source = evidence.local.state.source!
          if (source.dirty === 1 || !source.serverUpdatedAt || evidence.local.state.intentions.length) {
            result.independentChoices = choices.filter(choice => { const count = (choice === "cloud-source-keep-diary" ? evidence.local.tagIds : cloud.tagIds).length; return !result.directChoices.includes(choice) && count > 0 && count <= 64 })
          }
          if (result.directChoices.length < 2) result.blockers.push("protected_conditions")
        } else if (publication?.state === "started") result.blockers.push("publication_uncertain")
        // Re-read local bytes after all awaited probes, so their previews cannot authorize old evidence.
        const last = await captureSharedTagCopySnapshot(id, lease!); await check(run)
        const latestWire = await pinned.review(id, conversionCopy(lease!)); await check(run)
        const latestArchive = await readSharedTagCopyArchive(); await check(run)
        if (last.fingerprint !== current.fingerprint || !same(assertDualResourceTarget(evidence.local, latestWire), cloud) || !same(latestArchive.rows, saved.rows)) {
          result.directChoices = []; result.independentChoices = []; result.blockers = ["current_state_changed"]
        }
        return result
      } finally { busy = false; for (const item of Object.values(adopters)) item.cancel() }
    },
    prepareCopies(file, choice, names, confirmed) { return act(confirmed, async run => {
      const evidence = await read(file, run); await exclusive(evidence, run)
      const review = await preparer.review(id, file, choice, names); await check(run)
      if (!review.ready) return failed()
      const done = await preparer.prepare(review.reviewId, true); await check(run)
      return done.prepared === true && done.reason === "local_names_reserved_cloud_confirmation_required" ? { ok: true, outcome: "names_prepared", cloudSynced: false } : failed()
    }) },
    publishCopies(file, planId, confirmed) { return act(confirmed, async run => {
      const plan = await selectedPlan(file, planId, run); await exclusive(plan.evidence, run)
      const review = await publisher.review(planId, file); await check(run)
      if (!review.ready) return failed()
      const done = await publisher.publish(review.reviewId, true); await check(run)
      return done.tagsConfirmed === true && done.reason === "tag_presence_confirmed_not_diary_handoff" ? { ok: true, outcome: "tags_confirmed", cloudSynced: false } : failed()
    }) },
    handoffCopies(file, planId, choice, confirmed) { return act(confirmed, async run => {
      const plan = await selectedPlan(file, planId, run)
      if (plan.choice !== choice) return failed()
      const review = await handoff.review(planId, file); await check(run)
      if (!review.ready) return failed()
      const done = await handoff.resolve(review.reviewId, choice, true); await check(run)
      return done.applied === true && done.reason === "independent_tag_references_ready_for_p2" && done.cloudSynced === false ? { ok: true, outcome: "diary_handed_off", cloudSynced: false } : failed()
    }) },
    resolveDirect(file, choice, confirmed) { return act(confirmed, async run => {
      await read(file, run)
      const saved = await readSharedTagCopyArchive(); await check(run)
      if (saved.plans.some(row => row.scheduleId === id && row.ownerUserId === lease!.ownerUserId && row.state === "prepared")) return failed()
      const resolver = adopters[choice]
      if (!resolver) return failed()
      const review = await resolver.review(id, file); await check(run)
      if (!review.ready) return failed()
      const done = await resolver.resolve(review.reviewId, choice, true); await check(run)
      const reason = choice === "cloud-source-keep-diary" ? "local_diary_with_fresh_image_ids_ready_for_p2" : "cloud_diary_and_exclusive_images_adopted"
      return done.applied === true && done.reason === reason ? { ok: true, outcome: "diary_handed_off", cloudSynced: false } : failed()
    }) },
  }
}
