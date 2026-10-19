import { captureSyncContext } from "@/api/syncContext"
import type { ScheduleCloudResourceTransport } from "@/api/scheduleCloudResourceTransport"
import { readDualResourceEvidenceFile } from "@/io/scheduleDualResourceEvidenceFile"
import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { SCHEDULE_CONFLICT_ARCHIVE } from "@/shared/scheduleConflict"
import { assertDualResourceAdoptionBase } from "@/shared/scheduleDualResourceAdoption"
import { assertDualResourceTarget } from "@/shared/scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "@/shared/scheduleDualResourceEvidence"
import { newId } from "@/shared/ids"
import { checkSharedTagCopyRecord, sharedTagCatalog, sharedTagCopySelection, sharedTagCopyArchivePlans, sharedTagNameKey, SHARED_TAG_COPY_KIND } from "@/shared/scheduleSharedTagCopy"
import type { SharedTagCopyChoice, SharedTagCopyName, SharedTagCopyRecord } from "@/shared/scheduleSharedTagCopy"
import { scheduleEntryId, SCHEDULE_META_KEYS } from "@/shared/schedules"

import { captureScheduleResourceSnapshot, encodeScheduleResourceSnapshot, scheduleResourceSnapshotEvidence } from "./scheduleResourceEvidenceRepo"
import { assertScheduleLease } from "./scheduleSyncStateRepo"
import { db, scheduleResourceTransactionAborter, waitForScheduleResourceBytes } from "./schema"

const localVersion = (evidence: ScheduleDualResourceEvidence["local"]) => {
  const { exportedAt: _time, ...rest } = evidence
  return conversionCanonical(rest)
}
async function archive() {
  const row = await db.meta.get(SCHEDULE_CONFLICT_ARCHIVE)
  if (row && !Array.isArray(row.value)) throw new Error("留档损坏，未准备标签")
  const rows = (row?.value ?? []) as unknown[]
  const plans = sharedTagCopyArchivePlans(rows)
  return { rows, plans }
}
async function snapshot(id: string, lease: ConversionLease, write = false) {
  const raw = await captureScheduleResourceSnapshot(id, lease), pending = encodeScheduleResourceSnapshot(raw, id, lease)
  const encoded = write ? await waitForScheduleResourceBytes(pending) : await pending
  await assertScheduleLease(lease)
  if (write) {
    // Blob values are immutable snapshots; a fresh row read is required after the
    // async byte wait so a same-transaction replacement cannot pass as old bytes.
    const reread = await captureScheduleResourceSnapshot(id, lease)
    const reencoded = await waitForScheduleResourceBytes(encodeScheduleResourceSnapshot(reread, id, lease))
    await assertScheduleLease(lease)
    if (conversionCanonical({ raw, encoded }) !== conversionCanonical({ raw: reread, encoded: reencoded })) {
      throw new Error("字节等待期间本机资源已变化")
    }
  }
  const local = scheduleResourceSnapshotEvidence(encoded, id), catalog = sharedTagCatalog(await db.tags.toArray())
  await assertScheduleLease(lease)
  return { local, catalog, fingerprint: conversionCanonical({ raw, encoded, catalog }) }
}
function originallyHeld(evidence: ScheduleDualResourceEvidence) {
  const source = evidence.local.state.source!
  if (!evidence.local.state.intentions.length && source.dirty !== 1 && source.serverUpdatedAt) throw new Error("原转换保护已不存在，未新增独立标签准备")
}
async function reservedIds(evidence: ScheduleDualResourceEvidence, plans: SharedTagCopyRecord[]) {
  const ids = new Set<string>(), scan = (root: unknown) => {
    const stack = [{ value: root, depth: 0 }]; let work = 0
    while (stack.length) {
      const { value, depth } = stack.pop()!
      if (++work > 200000 || depth > 72) throw new Error("身份引用无法完整核对")
      if (typeof value === "string") {
        const candidate = value.startsWith("local://media/") ? value.slice("local://media/".length) : value
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) ids.add(candidate)
      } else if (value && typeof value === "object") for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 })
    }
  }
  scan(evidence)
  for (const table of [db.entries, db.schedules, db.tags, db.media]) scan(await table.toArray())
  for (const key of [SCHEDULE_META_KEYS.conversions, SCHEDULE_META_KEYS.conflicts, "conflicts", "pendingPurges"]) scan((await db.meta.get(key))?.value)
  for (const plan of plans) { ids.add(plan.id); for (const copy of plan.copies) ids.add(copy.tag.id) }
  return ids
}
interface Ticket {
  id: string; lease: ConversionLease; evidence: ScheduleDualResourceEvidence; file: ConflictEvidenceReadableFile
  choice: SharedTagCopyChoice; names: SharedTagCopyName[]; fingerprint: string
}
/** A durable naming/reservation stage only: no tag upload, diary remap or protection release. */
export function createInternalSharedTagCopyPreparer(transport: ScheduleCloudResourceTransport) {
  let active: Ticket | null = null, busy = false, serial = 0, operation = 0, abortWrite: (() => void) | null = null
  const guard = (run: number) => { if (run !== operation) throw new Error("独立标签准备已取消") }
  const check = async (run: number, lease: ConversionLease) => { guard(run); await assertScheduleLease(lease); guard(run) }
  const verify = async (ticket: Ticket, run: number, write = false) => {
    const latest = await snapshot(ticket.id, ticket.lease, write); await check(run, ticket.lease)
    if (latest.fingerprint !== ticket.fingerprint || localVersion(latest.local) !== localVersion(ticket.evidence.local)) throw new Error("本机正文、标签目录或转换保护已变化")
    return latest
  }
  return {
    cancel() { operation++; serial++; active = null; try { abortWrite?.() } catch { /* Completed commits cannot be cancelled. */ } },
    async review(id: string, file: ConflictEvidenceReadableFile, choice: SharedTagCopyChoice, names: SharedTagCopyName[]) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0, resolutionEnabled: false }
      busy = true; active = null; const run = ++operation, reviewId = ++serial
      try {
        if (scheduleEntryId(id) !== id) throw new Error("来源身份无效")
        const lease = await captureSyncContext(); await check(run, lease)
        const evidence = await readDualResourceEvidenceFile(file); await check(run, lease)
        if (evidence.scheduleId !== id) throw new Error("双方文件属于其他来源")
        const cloud = assertDualResourceAdoptionBase(evidence); originallyHeld(evidence)
        const current = await snapshot(id, lease); await check(run, lease)
        if (localVersion(current.local) !== localVersion(evidence.local)) throw new Error("双方文件不是当前本机状态")
        const selection = sharedTagCopySelection(evidence, choice, names, current.catalog)
        const ticket = { id, lease, evidence, file, choice, names: selection.names, fingerprint: current.fingerprint }
        const latest = await transport.review(id, conversionCopy(lease)); await check(run, lease)
        if (conversionCanonical(assertDualResourceTarget(evidence.local, latest)) !== conversionCanonical(cloud)) throw new Error("云端证明已变化")
        await verify(ticket, run); await archive(); await check(run, lease)
        active = ticket
        return { ready: true, reason: "explicit_names_ready_for_local_preparation", reviewId, resolutionEnabled: false,
          choice, names: conversionCopy(selection.names), originalTagIds: selection.originalTagIds,
          warning: "original_shared_definitions_remain_held_no_diary_remap_or_upload" }
      } catch { return { ready: false, reason: run !== operation ? "cancelled_recheck" : "tag_copy_preparation_protected", reviewId: 0, resolutionEnabled: false } }
      finally { busy = false }
    },
    async prepare(reviewId: number, confirmed: boolean) {
      if (busy) return { prepared: false, reason: "busy", resolutionEnabled: false }
      if (!active || reviewId !== serial || confirmed !== true) return { prepared: false, reason: "explicit_naming_confirmation_required", resolutionEnabled: false }
      busy = true; const ticket = active, run = ++operation
      try {
        await check(run, ticket.lease)
        const file = await readDualResourceEvidenceFile(ticket.file); await check(run, ticket.lease)
        if (conversionCanonical(file) !== conversionCanonical(ticket.evidence)) throw new Error("双方文件已变化")
        await verify(ticket, run)
        const wire = await transport.review(ticket.id, conversionCopy(ticket.lease)); await check(run, ticket.lease)
        if (conversionCanonical(assertDualResourceTarget(ticket.evidence.local, wire)) !== conversionCanonical(assertDualResourceAdoptionBase(ticket.evidence))) throw new Error("云端证明已变化")
        let result: SharedTagCopyRecord | null = null
        await db.transaction("rw", db.entries, db.schedules, db.tags, db.media, db.meta, async () => {
          abortWrite = scheduleResourceTransactionAborter(); await check(run, ticket.lease)
          const current = await verify(ticket, run, true), saved = await archive(); await check(run, ticket.lease)
          const pending = saved.plans.filter(plan => plan.ownerUserId === ticket.lease.ownerUserId && plan.scheduleId === ticket.id && plan.state === "prepared")
          if (pending.length > 1) throw new Error("已有多个准备记录，未重建")
          if (pending.length) {
            const plan = pending[0]!
            if (plan.generation !== ticket.lease.generation || plan.choice !== ticket.choice ||
                conversionCanonical(plan.evidence) !== conversionCanonical(ticket.evidence) ||
                conversionCanonical(plan.names) !== conversionCanonical(ticket.names) || conversionCanonical(plan.catalog) !== conversionCanonical(current.catalog)) {
              throw new Error("已有其他准备，请先明确处理，未自动替换")
            }
            result = plan; return
          }
          const selection = sharedTagCopySelection(ticket.evidence, ticket.choice, ticket.names, current.catalog)
          const occupiedNames = new Set(saved.plans.filter(plan => plan.ownerUserId === ticket.lease.ownerUserId && plan.state === "prepared")
            .flatMap(plan => plan.names.map(row => sharedTagNameKey(row.name))))
          if (selection.names.some(row => occupiedNames.has(sharedTagNameKey(row.name)))) throw new Error("另一准备已占用相同或近似名称")
          const reserved = await reservedIds(ticket.evidence, saved.plans); await check(run, ticket.lease)
          const fresh = () => {
            const id = newId()
            if (scheduleEntryId(id) !== id || reserved.has(id)) throw new Error("准备身份已占用，未覆盖")
            reserved.add(id); return id
          }
          const id = fresh(), createdAt = conversionUtc(new Date().toISOString())
          const plan = checkSharedTagCopyRecord({ kind: SHARED_TAG_COPY_KIND, version: 1, id, scheduleId: ticket.id,
            ownerUserId: ticket.lease.ownerUserId, generation: ticket.lease.generation, state: "prepared", choice: ticket.choice, createdAt,
            names: selection.names, copies: selection.names.map((row, index) => ({ from: row.from,
              tag: { id: fresh(), name: row.name, color: selection.definitions[index]!.color, createdAt, dirty: 1 } })),
            originalTagIds: selection.originalTagIds, evidence: ticket.evidence, catalog: current.catalog })
          await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: [...saved.rows, plan] }); await check(run, ticket.lease)
          result = plan
        })
        if (!result) throw new Error("准备未确认")
        const plan = result as SharedTagCopyRecord
        active = null
        return { prepared: true, reason: "local_names_reserved_cloud_confirmation_required", planId: plan.id,
          copies: conversionCopy(plan.copies), cloudConfirmed: false, resolutionEnabled: false, diarySyncEnabled: false }
      } catch { active = null; return { prepared: false, reason: run !== operation ? "cancelled_recheck" : "tag_copy_preparation_unconfirmed", resolutionEnabled: false } }
      finally { busy = false; abortWrite = null }
    },
    async listPrepared() {
      const lease = await captureSyncContext(), saved = await archive(); await assertScheduleLease(lease)
      return saved.plans.filter(plan => plan.ownerUserId === lease.ownerUserId && plan.state === "prepared").map(plan => ({
        planId: plan.id, scheduleId: plan.scheduleId, choice: plan.choice, names: conversionCopy(plan.names),
        copies: conversionCopy(plan.copies), currentEpoch: plan.generation === lease.generation,
        cloudConfirmed: false, resolutionEnabled: false, diarySyncEnabled: false,
      }))
    },
    async discard(planId: string, confirmed: boolean) {
      if (busy) return { discarded: false, reason: "busy" }
      if (confirmed !== true) return { discarded: false, reason: "explicit_discard_required" }
      busy = true; active = null; serial++; const run = ++operation
      try {
        const lease = await captureSyncContext(); await check(run, lease)
        await db.transaction("rw", db.entries, db.schedules, db.tags, db.media, db.meta, async () => {
          abortWrite = scheduleResourceTransactionAborter(); await check(run, lease)
          const saved = await archive(), plan = saved.plans.find(plan => plan.id === planId)
          if (!plan || plan.ownerUserId !== lease.ownerUserId || plan.generation !== lease.generation || plan.state !== "prepared") throw new Error("旧准备不可弃去")
          originallyHeld(plan.evidence)
          const current = await snapshot(plan.scheduleId, lease, true); await check(run, lease)
          if (localVersion(current.local) !== localVersion(plan.evidence.local) || conversionCanonical(current.catalog) !== conversionCanonical(plan.catalog)) throw new Error("原保护或目录已变化，未弃去")
          await db.meta.put({ key: SCHEDULE_CONFLICT_ARCHIVE, value: saved.rows.map(row => row && typeof row === "object" && "id" in row && row.id === planId && "kind" in row && row.kind === SHARED_TAG_COPY_KIND
            ? { ...plan, state: "discarded" } : row) }); await check(run, lease)
        })
        return { discarded: true, reason: "unpublished_names_discarded_original_conversion_still_held" }
      } catch { return { discarded: false, reason: "discard_unconfirmed_original_protection_retained" } }
      finally { busy = false; abortWrite = null }
    },
  }
}
