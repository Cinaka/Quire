import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceTransport } from "@/api/scheduleCloudResourceTransport"
import { readDualResourceEvidenceFile } from "@/io/scheduleDualResourceEvidenceFile"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { resourceRepairBlob } from "@/io/scheduleResourceRepairFile"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { assertDualCloudAdoption } from "@/shared/scheduleDualResourceAdoption"
import { assertDualResourceTarget } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import { terminalVersionKey } from "@/shared/scheduleTerminalConflict"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"
import { toPlainText } from "@/shared/text"

import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease, readCheckedConversionQueue, readScheduleServerState, rememberScheduleServerState } from "./scheduleSyncStateRepo"
import { db, scheduleResourceTransactionAborter, waitForScheduleResourceBytes } from "./schema"

interface Ticket {
  id: string; lease: ConversionLease; fingerprint: string; evidence: ScheduleDualResourceEvidence
  file: ConflictEvidenceReadableFile
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
async function assertExclusiveMedia(id: string, ids: string[]) {
  const target = new Set(ids)
  const scan = (root: unknown) => {
    const stack = [{ value: root, depth: 0 }]; let work = 0
    while (stack.length) {
      const { value, depth } = stack.pop()!
      if (++work > 200000 || depth > 72) throw new Error("其他引用过深或过大，不能证明图片独占")
      if (typeof value === "string" && (target.has(value) ||
          value.startsWith("local://media/") && target.has(value.slice("local://media/".length)))) {
        throw new Error("图片被其他日记、首次意图或历史候选共享，不能替换")
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
async function checkWatermarks(active: Ticket) {
  const cloud = assertDualCloudAdoption(active.evidence)
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
/** Explicit, unmounted adoption of exclusive same-ID cloud images. Shared tags are never modified. */
export function createInternalDualResourceCloudAdopter(transport: ScheduleCloudResourceTransport) {
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
        const latest = await current(id, lease); guard(run)
        if (localVersion(latest.local) !== localVersion(evidence.local)) throw new Error("文件不是当前本机快照")
        const active: Ticket = { id, lease, fingerprint: latest.fingerprint, evidence, file }
        await checkWatermarks(active); guard(run)
        const wire = await transport.review(id, conversionCopy(lease)); guard(run); await assertScheduleLease(lease); guard(run)
        if (conversionCanonical(assertDualResourceTarget(evidence.local, wire)) !== conversionCanonical(cloud)) throw new Error("文件不是当前云端版本")
        await verify(active); guard(run)
        ticket = active
        return { ready: true, reason: "explicit_exclusive_cloud_adoption", reviewId,
          choices: ["cloud-source-use-diary"], mediaCount: cloud.media.length,
          warning: "replace_exclusive_local_images_after_preserving_both_versions" }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "cloud_adoption_protected", reviewId: 0, choices: [] as string[] } }
      finally { busy = false }
    },
    async resolve(reviewId: number, choice: string, confirmed: boolean) {
      if (busy) return { applied: false, reason: "busy" }
      if (!ticket || reviewId !== serial || choice !== "cloud-source-use-diary" || confirmed !== true) {
        return { applied: false, reason: "explicit_cloud_choice_required" }
      }
      busy = true; const active = ticket, run = ++operation
      const check = async () => { guard(run); await assertScheduleLease(active.lease); guard(run) }
      try {
        await check()
        const reread = await readDualResourceEvidenceFile(active.file); await check()
        if (conversionCanonical(reread) !== conversionCanonical(active.evidence)) throw new Error("双方证据文件已变化")
        await verify(active); await check()
        const cloud = await checkWatermarks(active); await check()
        const wire = await transport.review(active.id, conversionCopy(active.lease)); await check()
        if (conversionCanonical(assertDualResourceTarget(active.evidence.local, wire)) !== conversionCanonical(cloud)) throw new Error("云端资源已变化")
        await verify(active); await check()
        await db.transaction("rw", db.schedules, db.entries, db.tags, db.media, db.meta, async () => {
          abortWrite = scheduleResourceTransactionAborter(); await check()
          await verify(active, true); await check()
          await checkWatermarks(active); await check()
          const archive = await records(SCHEDULE_CONFLICT_ARCHIVE), chosen = conversionCopy(cloud.review.entry!)
          await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: [...archive, {
            ownerUserId: active.lease.ownerUserId, generation: active.lease.generation, scheduleId: active.id,
            kind: "terminal-dual-resource-cloud-adoption", choice, at: conversionUtc(new Date().toISOString()),
            evidence: conversionCopy(active.evidence), result: conversionCopy(chosen),
          }] }); await check()
          for (const media of active.evidence.cloudMedia) {
            await db.media.put({ id: media.id, entryId: active.id, mime: media.mime, width: media.width, height: media.height,
              size: media.size, sortOrder: media.sortOrder, createdAt: media.createdAt, dirty: 0, orphanedAt: null,
              remoteUrl: "", thumbRemoteUrl: "", blob: resourceRepairBlob(media.blobBase64, media.mime),
              thumbBlob: media.thumbBase64 === null ? null : resourceRepairBlob(media.thumbBase64, media.thumbMime!) })
            await check()
          }
          await rememberScheduleServerState(active.lease, cloud.review.schedule!); await check()
          await db.schedules.put({ ...conversionCopy(cloud.review.schedule!), contentText: toPlainText(cloud.review.schedule!.content), dirty: 0 }); await check()
          await db.entries.put({ ...chosen, contentText: toPlainText(chosen.content), dirty: 0 }); await check()
          const queue = await readCheckedConversionQueue(active.lease.ownerUserId)
          await db.meta.put({ key: SCHEDULE_META_KEYS.conversions, value: queue.filter(row => row.scheduleId !== active.id) }); await check()
          const candidates = await records(SCHEDULE_META_KEYS.conflicts)
          await db.meta.put({ key: SCHEDULE_META_KEYS.conflicts, value: candidates.filter(row =>
            !row || typeof row !== "object" || !("scheduleId" in row) || row.scheduleId !== active.id) }); await check()
        })
        ticket = null
        return { applied: true, reason: "cloud_diary_and_exclusive_images_adopted",
          localIntentStatus: active.evidence.local.state.intentions.length ? "superseded_by_explicit_choice" : "no_local_intent" }
      } catch { ticket = null; return { applied: false, reason: run !== operation ? "cancelled_recheck" : "cloud_adoption_unconfirmed" } }
      finally { abortWrite = null; busy = false }
    },
  }
}
