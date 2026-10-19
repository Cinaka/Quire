import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceTransport } from "@/api/scheduleCloudResourceTransport"
import { readDualResourceEvidenceFile, verifyDualLocalKeepImages } from "@/io/scheduleDualResourceEvidenceFile"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { resourceRepairBlob } from "@/io/scheduleResourceRepairFile"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { newId } from "@/shared/ids"
import { assertDualCloudAdoption, dualResourceImageSets, dualResourceTagSets, localKeepImageIds, planDualLocalKeep } from "@/shared/scheduleDualResourceAdoption"
import { assertDualResourceTarget } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import { terminalVersionKey } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"
import type { Tag } from "@/shared/types"

import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db, scheduleResourceTransactionAborter, waitForScheduleResourceBytes } from "./schema"

interface Ticket {
  id: string; lease: ConversionLease; fingerprint: string; evidence: ScheduleDualResourceEvidence
  file: ConflictEvidenceReadableFile; keepLocal: boolean; tagFingerprint: string
}
const localVersion = (value: ScheduleResourceEvidence) => {
  const { exportedAt: _time, ...rest } = value
  return conversionCanonical(rest)
}
async function records(key: string): Promise<unknown[]> {
  const row = await db.meta.get(key)
  if (row && !Array.isArray(row.value)) throw new Error("保护或留档元数据损坏")
  return (row?.value ?? []) as unknown[]
}
/** Includes deleted diaries and other queued/historical candidates, not just current visible bodies. */
async function assertExclusiveMedia(id: string, ids: string[], kind = "图片") {
  const target = new Set(ids)
  const scan = (root: unknown) => {
    const stack = [{ value: root, depth: 0 }]; let work = 0
    while (stack.length) {
      const { value, depth } = stack.pop()!
      if (++work > 200000 || depth > 72) throw new Error(`其他引用过深或过大，不能证明${kind}独占`)
      if (typeof value === "string" && (target.has(value) ||
          value.startsWith("local://media/") && target.has(value.slice("local://media/".length)))) {
        throw new Error(`${kind}被其他日记、首次意图或历史候选共享，不能替换`)
      }
      if (value && typeof value === "object") for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 })
    }
  }
  for (const row of await db.entries.toArray()) if (row.id !== id) scan(row)
  const owner = (await db.meta.get("ownerUserId"))?.value
  if (typeof owner !== "string") throw new Error("本机归属无效")
  for (const row of await readCheckedConversionQueue(owner)) if (row.scheduleId !== id) scan(row)
  for (const row of await records(SCHEDULE_META_KEYS.conflicts)) {
    if (!row || typeof row !== "object" || !("scheduleId" in row) || row.scheduleId !== id) scan(row)
  }
  for (const row of await records("conflicts")) scan(row)
}
async function current(id: string, lease: ConversionLease, insideWrite = false) {
  const raw = await captureScheduleResourceSnapshot(id, lease)
  const pending = encodeScheduleResourceSnapshot(raw, id, lease)
  const encoded = insideWrite ? await waitForScheduleResourceBytes(pending) : await pending
  await assertScheduleLease(lease)
  const local = scheduleResourceSnapshotEvidence(encoded, id)
  await assertExclusiveMedia(id, local.mediaIds)
  await records(SCHEDULE_CONFLICT_ARCHIVE)
  await assertScheduleLease(lease)
  return { local, fingerprint: conversionCanonical({ raw, encoded }) }
}
async function verify(active: Ticket, insideWrite = false) {
  const latest = await current(active.id, active.lease, insideWrite)
  if (latest.fingerprint !== active.fingerprint || localVersion(latest.local) !== localVersion(active.evidence.local)) {
    throw new Error("本机资源、首次意图或保护已变化")
  }
}
/** Remote-only identities must not overwrite any unpreserved cache or occupy another resource. */
async function checkResourceIdentities(active: Ticket) {
  const cloud = assertDualCloudAdoption(active.evidence), sets = dualResourceImageSets(active.evidence)
  await assertExclusiveMedia(active.id, [...new Set([...active.evidence.local.mediaIds, ...cloud.mediaIds])])
  for (const id of sets.cloudOnly) {
    if (await db.media.get(id) || await db.entries.get(id) || await db.schedules.get(id) || await db.tags.get(id)) {
      throw new Error("云端新增图片身份已在本机占用，未覆盖或弃去")
    }
  }
}
// Conservative name ambiguity guard, not an implementation of every MySQL collation rule.
const tagNameKey = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase()
async function captureTagMembership(id: string, evidence: ScheduleDualResourceEvidence, keepLocal: boolean) {
  const cloud = assertDualCloudAdoption(evidence), sets = dualResourceTagSets(evidence)
  // An absent tag in the current cloud diary is not proof of its global definition.
  // Releasing dirty local-only tags would silently authorize writes to other cloud diaries.
  if (evidence.local.tags.some(tag => sets.localOnly.includes(tag.id) && tag.dirty !== 0)) {
    throw new Error("本机独有标签仍有未确认定义修改，请保留保护")
  }
  const catalog = await db.tags.toArray(), seen: Array<{ id: string; row: Tag | null }> = [], additions: Tag[] = []
  for (const proof of cloud.tags) {
    const row = catalog.find(tag => tag.id === proof.id) ?? null
    if (row && (row.name !== proof.name || row.color !== proof.color)) throw new Error("已有共享标签定义不同，未覆盖")
    if (catalog.some(tag => tag.id !== proof.id && tagNameKey(tag.name) === tagNameKey(proof.name)) ||
        cloud.tags.some(tag => tag.id !== proof.id && tagNameKey(tag.name) === tagNameKey(proof.name))) {
      throw new Error("同名或近似同名标签身份不同，不能自动合并")
    }
    seen.push({ id: proof.id, row })
    if (!row) {
      if (await db.entries.get(proof.id) || await db.schedules.get(proof.id) || await db.media.get(proof.id)) {
        throw new Error("云端标签身份已在本机其他资源占用")
      }
      await assertExclusiveMedia(id, [proof.id], "缺失标签身份")
      if (!keepLocal) additions.push({ ...conversionCopy(proof), dirty: 0 })
    }
  }
  return { sets, seen, additions }
}
async function checkTagMembership(active: Ticket) {
  const plan = await captureTagMembership(active.id, active.evidence, active.keepLocal)
  if (conversionCanonical(plan) !== active.tagFingerprint) throw new Error("标签身份、定义或待安装状态已变化")
  return plan
}
async function checkWatermarks(active: Ticket) {
  const cloud = assertDualCloudAdoption(active.evidence)
  await checkResourceIdentities(active)
  await checkTagMembership(active)
  const source = active.evidence.local.state.source!, entry = active.evidence.local.state.entry!
  const base = await readScheduleServerState(active.lease, active.id)
  const remote = cloud.review.schedule!, diary = cloud.review.entry!
  if ((base && terminalVersionKey(base.serverUpdatedAt) > terminalVersionKey(remote.serverUpdatedAt)) ||
      (source.serverUpdatedAt && terminalVersionKey(source.serverUpdatedAt) > terminalVersionKey(remote.serverUpdatedAt)) ||
      (entry.serverUpdatedAt && terminalVersionKey(entry.serverUpdatedAt) > terminalVersionKey(diary.serverUpdatedAt)) ||
      (base && terminalVersionKey(base.serverUpdatedAt) === terminalVersionKey(remote.serverUpdatedAt) &&
        conversionCanonical(base) !== conversionCanonical(remote))) throw new Error("云端证明落后或与已知同水位基线矛盾")
  return cloud
}
/** The two factories deliberately expose different explicit choices; no fallback silently switches sides. */
function createDualResourceResolver(transport: ScheduleCloudResourceTransport, acceptedChoice: "cloud-source-use-diary" | "cloud-source-keep-diary") {
  const keepLocal = acceptedChoice === "cloud-source-keep-diary"
  let ticket: Ticket | null = null, busy = false, serial = 0, operation = 0
  let abortWrite: (() => void) | null = null
  const guard = (run: number) => { if (run !== operation) throw new Error("资源取舍已取消") }
  return {
    cancel() { operation++; ticket = null; try { abortWrite?.() } catch { /* A completed commit is not undone. */ } },
    async review(id: string, file: ConflictEvidenceReadableFile) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0, choices: [] as string[] }
      busy = true; ticket = null; const run = ++operation, reviewId = ++serial
      try {
        if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
        const lease = await captureSyncContext(); guard(run)
        const evidence = await readDualResourceEvidenceFile(file); guard(run); await assertScheduleLease(lease); guard(run)
        if (evidence.scheduleId !== id) throw new Error("双方文件属于其他来源")
        const cloud = assertDualCloudAdoption(evidence)
        if (keepLocal) { await verifyDualLocalKeepImages(evidence); guard(run); await assertScheduleLease(lease); guard(run) }
        const latest = await current(id, lease); guard(run)
        if (localVersion(latest.local) !== localVersion(evidence.local)) throw new Error("文件不是当前本机快照")
        const tagPlan = await captureTagMembership(id, evidence, keepLocal); guard(run); await assertScheduleLease(lease); guard(run)
        const active: Ticket = { id, lease, fingerprint: latest.fingerprint, evidence, file, keepLocal, tagFingerprint: conversionCanonical(tagPlan) }
        await checkWatermarks(active); guard(run)
        const wire = await transport.review(id, conversionCopy(lease)); guard(run); await assertScheduleLease(lease); guard(run)
        if (conversionCanonical(assertDualResourceTarget(evidence.local, wire)) !== conversionCanonical(cloud)) throw new Error("文件不是当前云端版本")
        await verify(active); guard(run)
        await checkTagMembership(active); guard(run); await assertScheduleLease(lease); guard(run)
        ticket = active
        return { ready: true, reason: keepLocal ? "explicit_fresh_id_local_keep" : "explicit_exclusive_cloud_adoption", reviewId,
          choices: [acceptedChoice], mediaCount: cloud.media.length, imageSets: dualResourceImageSets(evidence), tagSets: dualResourceTagSets(evidence),
          warning: keepLocal ? "fork_local_image_ids_and_evict_old_cache_not_cloud_delete" : "replace_exclusive_local_images_after_preserving_both_versions" }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "cloud_adoption_protected", reviewId: 0, choices: [] as string[] } }
      finally { busy = false }
    },
    async resolve(reviewId: number, choice: string, confirmed: boolean) {
      if (busy) return { applied: false, reason: "busy" }
      if (!ticket || reviewId !== serial || choice !== acceptedChoice || confirmed !== true) {
        return { applied: false, reason: "explicit_cloud_choice_required" }
      }
      busy = true; const active = ticket, run = ++operation
      const check = async () => { guard(run); await assertScheduleLease(active.lease); guard(run) }
      try {
        await check()
        const reread = await readDualResourceEvidenceFile(active.file); await check()
        if (conversionCanonical(reread) !== conversionCanonical(active.evidence)) throw new Error("双方证据文件已变化")
        if (keepLocal) { await verifyDualLocalKeepImages(reread); await check() }
        await verify(active); await check()
        const cloud = await checkWatermarks(active); await check()
        const wire = await transport.review(active.id, conversionCopy(active.lease)); await check()
        if (conversionCanonical(assertDualResourceTarget(active.evidence.local, wire)) !== conversionCanonical(cloud)) throw new Error("云端资源已变化")
        await verify(active); await check()
        await db.transaction("rw", db.schedules, db.entries, db.tags, db.media, db.meta, async () => {
          abortWrite = scheduleResourceTransactionAborter(); await check()
          await verify(active, true); await check()
          await checkWatermarks(active); await check()
          const tagPlan = await checkTagMembership(active); await check()
          const at = conversionUtc(new Date().toISOString()), mapping = new Map<string, string>()
          if (keepLocal) {
            for (const from of localKeepImageIds(active.evidence)) {
              const to = newId()
              if (scheduleEntryId(to) !== to || (active.evidence.local.mediaIds.includes(to) || cloud.mediaIds.includes(to) || active.evidence.local.tagIds.includes(to) || cloud.tagIds.includes(to)) || [...mapping.values()].includes(to) ||
                  await db.media.get(to) || await db.entries.get(to) || await db.schedules.get(to) || await db.tags.get(to)) {
                throw new Error("新媒体身份无效或已占用，未覆盖")
              }
              mapping.set(from, to); await check()
            }
            if (mapping.size) await assertExclusiveMedia(active.id, [...mapping.values()])
            await check()
          }
          const localPlan = keepLocal ? planDualLocalKeep(active.evidence, mapping, at) : null
          const archive = await records(SCHEDULE_CONFLICT_ARCHIVE), chosenRaw = localPlan?.entry ?? conversionCopy(cloud.review.entry!)
          const chosen = { ...chosenRaw, contentText: toPlainText(chosenRaw.content) }
          await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: [...archive, {
            ownerUserId: active.lease.ownerUserId, generation: active.lease.generation, scheduleId: active.id,
            kind: keepLocal ? "terminal-dual-resource-local-keep" : "terminal-dual-resource-cloud-adoption", choice, at,
            ...(localPlan ? { resourceIdMap: conversionCopy(localPlan.resourceIdMap) } : {}),
            imageSets: dualResourceImageSets(active.evidence), tagPlan: conversionCopy(tagPlan),
            evidence: conversionCopy(active.evidence), result: conversionCopy(chosen),
          }] }); await check()
          for (const tag of tagPlan.additions) { await db.tags.add(tag); await check() }
          if (localPlan) {
            // Cache eviction only: no old-ID dirty row, orphan tombstone or server deletion request.
            // Both old physical versions remain in the verified external file and transaction archive.
            for (const id of active.evidence.local.mediaIds) { await db.media.delete(id); await check() }
            for (const media of localPlan.media) {
              await db.media.add({ id: media.id, entryId: active.id, mime: media.mime, width: media.width, height: media.height,
                size: media.size, sortOrder: media.sortOrder, createdAt: media.createdAt, dirty: 1, orphanedAt: null,
                remoteUrl: "", thumbRemoteUrl: "", blob: resourceRepairBlob(media.blobBase64, media.mime),
                thumbBlob: media.thumbBase64 === null ? null : resourceRepairBlob(media.thumbBase64, media.thumbMime!) })
              await check()
            }
          } else {
            // Local-only images are archived before cache eviction. No orphan marker or cloud delete.
            for (const id of dualResourceImageSets(active.evidence).localOnly) { await db.media.delete(id); await check() }
            for (const media of active.evidence.cloudMedia) {
              const row = { id: media.id, entryId: active.id, mime: media.mime, width: media.width, height: media.height,
                size: media.size, sortOrder: media.sortOrder, createdAt: media.createdAt, dirty: 0 as const, orphanedAt: null,
                remoteUrl: "", thumbRemoteUrl: "", blob: resourceRepairBlob(media.blobBase64, media.mime),
                thumbBlob: media.thumbBase64 === null ? null : resourceRepairBlob(media.thumbBase64, media.thumbMime!) }
              if (active.evidence.local.mediaIds.includes(media.id)) await db.media.put(row)
              else await db.media.add(row)
              await check()
            }
          }
          await rememberScheduleServerState(active.lease, cloud.review.schedule!); await check()
          await db.schedules.put({ ...conversionCopy(cloud.review.schedule!), contentText: toPlainText(cloud.review.schedule!.content), dirty: 0 }); await check()
          await db.entries.put({ ...chosen, contentText: toPlainText(chosen.content) }); await check()
          const queue = await readCheckedConversionQueue(active.lease.ownerUserId)
          await db.meta.put({ key: SCHEDULE_META_KEYS.conversions, value: queue.filter(row => row.scheduleId !== active.id) }); await check()
          const candidates = await records(SCHEDULE_META_KEYS.conflicts)
          await db.meta.put({ key: SCHEDULE_META_KEYS.conflicts, value: candidates.filter(row =>
            !row || typeof row !== "object" || !("scheduleId" in row) || row.scheduleId !== active.id) }); await check()
        })
        ticket = null
        return { applied: true, reason: keepLocal ? "local_diary_with_fresh_image_ids_ready_for_p2" : "cloud_diary_and_exclusive_images_adopted",
          localIntentStatus: active.evidence.local.state.intentions.length ? "superseded_by_explicit_choice" : "no_local_intent" }
      } catch { ticket = null; return { applied: false, reason: run !== operation ? "cancelled_recheck" : "cloud_adoption_unconfirmed" } }
      finally { abortWrite = null; busy = false }
    },
  }
}

/** Cloud choice compatibility entry: it never accepts a local-keep choice. */
export function createInternalDualResourceCloudAdopter(transport: ScheduleCloudResourceTransport) {
  return createDualResourceResolver(transport, "cloud-source-use-diary")
}
/** Explicit local diary retention; only new image identities may become ordinary P2 uploads. */
export function createInternalDualResourceLocalKeeper(transport: ScheduleCloudResourceTransport) {
  return createDualResourceResolver(transport, "cloud-source-keep-diary")
}
