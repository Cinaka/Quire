import { newId } from "@/shared/ids"
import { isBackupSchedule, scheduleContentTooNew } from "@/shared/scheduleBackup"
import {
  advanceScheduleDraftState, assertDraftId, emptyScheduleDraftState, isDraftIso,
  matchesScheduleDraftBody, parseScheduleDraftPayload, parseScheduleDraftState,
  type ScheduleDraftSaveInput, type ScheduleDraftState, type ScheduleEditorDraft,
} from "@/shared/scheduleDrafts"
import { nextScheduleRevision, SCHEDULE_META_KEYS } from "@/shared/schedules"
import { utcNow } from "@/shared/time"
import type { Iso, Schedule } from "@/shared/types"

import { assertLocalOwner, localOwnerSnapshot, type LocalOwnerSnapshot } from "./scheduleStateRepo"
import { db } from "./schema"

export interface ScheduleDraftLease extends LocalOwnerSnapshot { revision: number }
export interface ScheduleDraftReadResult {
  lease: ScheduleDraftLease
  draft: ScheduleEditorDraft | null
  status: "empty" | "recoverable" | "alreadySaved" | "conflict" | "sourceUnavailable"
}
/** 只能传本次业务保存返回的确切ID/修订；不能在列表按标题猜关联。 */
export interface ScheduleDraftReceipt {
  draftId: string
  scheduleId: string
  clientUpdatedAt: Iso
}
export type ScheduleDraftAck =
  | { cleared: true; lease: ScheduleDraftLease }
  | { cleared: false; reason: "changed" | "empty" | "mismatch" | "sourceChanged" }

function validLease(lease: ScheduleDraftLease): void {
  if (!lease || typeof lease.ownerUserId !== "string" || typeof lease.generation !== "string" ||
    !Number.isSafeInteger(lease.revision) || lease.revision < 0) throw new Error("预简草稿操作凭据无效")
}
function validReceipt(receipt: ScheduleDraftReceipt): void {
  if (!receipt) throw new Error("预简保存回执无效")
  assertDraftId(receipt.draftId)
  assertDraftId(receipt.scheduleId)
  if (!isDraftIso(receipt.clientUpdatedAt)) throw new Error("预简保存回执修订无效")
}
async function state(): Promise<ScheduleDraftState> {
  const row = await db.meta.get(SCHEDULE_META_KEYS.draft)
  return row ? parseScheduleDraftState(row.value) : emptyScheduleDraftState()
}
function leaseFor(owner: LocalOwnerSnapshot, current: ScheduleDraftState): ScheduleDraftLease {
  return { ...owner, revision: current.revision }
}
function sameRevision(current: ScheduleDraftState, lease: ScheduleDraftLease): void {
  if (current.revision !== lease.revision) throw new Error("预简草稿已变化，请重新读取；旧操作未覆盖")
}
async function status(draft: ScheduleEditorDraft | null): Promise<ScheduleDraftReadResult["status"]> {
  if (!draft) return "empty"
  if (!draft.scheduleId) return "recoverable"
  const source = await db.schedules.get(draft.scheduleId)
  if (!source || !isBackupSchedule(source) || scheduleContentTooNew(source) ||
    source.isDeleted || source.status !== "pending") {
    return "sourceUnavailable"
  }
  if (matchesScheduleDraftBody(draft, source)) return "alreadySaved"
  return source.clientUpdatedAt === draft.baseClientUpdatedAt ? "recoverable" : "conflict"
}
async function receiptSource(receipt: ScheduleDraftReceipt): Promise<Schedule | undefined> {
  const source = await db.schedules.get(receipt.scheduleId)
  return source && isBackupSchedule(source) && !scheduleContentTooNew(source) &&
    source.status === "pending" && !source.isDeleted &&
    source.clientUpdatedAt === receipt.clientUpdatedAt ? source : undefined
}

/** 内部单槽安全草稿；原draft键不碰，页面/DEV入口在真实验收前不开放。 */
export const localScheduleDraftRepo = {
  async read(): Promise<ScheduleDraftReadResult> {
    return db.transaction("r", db.schedules, db.meta, async () => {
      const owner = await localOwnerSnapshot()
      const current = await state()
      return { lease: leaseFor(owner, current), draft: current.draft, status: await status(current.draft) }
    })
  },

  async save(lease: ScheduleDraftLease, input: ScheduleDraftSaveInput): Promise<ScheduleDraftReadResult> {
    lease = { ...lease }
    validLease(lease)
    if (!input || typeof input !== "object") throw new Error("预简草稿载荷无效")
    const { draftId, ...raw } = input
    if (draftId !== null) assertDraftId(draftId)
    const payload = parseScheduleDraftPayload(raw)
    return db.transaction("rw", db.schedules, db.meta, async () => {
      await assertLocalOwner(lease)
      const current = await state()
      sameRevision(current, lease)
      if (current.draft) {
        if (draftId !== current.draft.draftId || payload.scheduleId !== current.draft.scheduleId) {
          throw new Error("已有其他预简草稿，请先恢复或明确弃去；未覆盖")
        }
      } else if (draftId !== null) {
        throw new Error("预简草稿已关闭，请重新开始")
      }
      const now = current.draft ? nextScheduleRevision(current.draft.updatedAt, utcNow()) : utcNow()
      const draft: ScheduleEditorDraft = { ...payload, draftId: draftId ?? newId(), updatedAt: now }
      const next = advanceScheduleDraftState(current, draft)
      await db.meta.put({ key: SCHEDULE_META_KEYS.draft, value: next })
      return { lease: leaseFor(lease, next), draft, status: await status(draft) }
    })
  },

  /** 明确弃去仍保留递增空标记；不能delete后让迟到回调重新写回。 */
  async clear(lease: ScheduleDraftLease): Promise<ScheduleDraftLease> {
    lease = { ...lease }
    validLease(lease)
    return db.transaction("rw", db.meta, async () => {
      await assertLocalOwner(lease)
      const current = await state()
      sameRevision(current, lease)
      const next = advanceScheduleDraftState(current, null)
      await db.meta.put({ key: SCHEDULE_META_KEYS.draft, value: next })
      return leaseFor(lease, next)
    })
  },

  /** 创建结果与同一草稿会话绑定；正文可比首次保存更新，绑定不得丢掉新编辑。 */
  async bindCreated(lease: ScheduleDraftLease, receipt: ScheduleDraftReceipt): Promise<ScheduleDraftReadResult> {
    lease = { ...lease }
    receipt = { ...receipt }
    validLease(lease)
    validReceipt(receipt)
    return db.transaction("rw", db.schedules, db.meta, async () => {
      await assertLocalOwner(lease)
      const current = await state()
      sameRevision(current, lease)
      const draft = current.draft
      if (!draft || draft.draftId !== receipt.draftId ||
        (draft.scheduleId !== null && draft.scheduleId !== receipt.scheduleId)) {
        throw new Error("预简创建回执不属于当前草稿，未绑定")
      }
      if (draft.scheduleId !== null) {
        if (draft.baseClientUpdatedAt !== receipt.clientUpdatedAt) {
          throw new Error("已绑定草稿不能用创建回执重置来源修订")
        }
        return { lease: leaseFor(lease, current), draft, status: await status(draft) }
      }
      if (!await receiptSource(receipt)) throw new Error("预简创建结果已变化，保留草稿待确认")
      const bound = { ...draft, scheduleId: receipt.scheduleId, baseClientUpdatedAt: receipt.clientUpdatedAt }
      const next = advanceScheduleDraftState(current, bound)
      await db.meta.put({ key: SCHEDULE_META_KEYS.draft, value: next })
      return { lease: leaseFor(lease, next), draft: bound, status: await status(bound) }
    })
  },

  async acknowledgeSaved(lease: ScheduleDraftLease, receipt: ScheduleDraftReceipt): Promise<ScheduleDraftAck> {
    lease = { ...lease }
    receipt = { ...receipt }
    validLease(lease)
    validReceipt(receipt)
    return db.transaction("rw", db.schedules, db.meta, async (): Promise<ScheduleDraftAck> => {
      await assertLocalOwner(lease)
      const current = await state()
      if (current.revision !== lease.revision) return { cleared: false, reason: "changed" }
      const draft = current.draft
      if (!draft) return { cleared: false, reason: "empty" }
      if (draft.draftId !== receipt.draftId || draft.scheduleId !== receipt.scheduleId) {
        return { cleared: false, reason: "mismatch" }
      }
      const source = await receiptSource(receipt)
      if (!source || !matchesScheduleDraftBody(draft, source)) return { cleared: false, reason: "sourceChanged" }
      const next = advanceScheduleDraftState(current, null)
      await db.meta.put({ key: SCHEDULE_META_KEYS.draft, value: next })
      return { cleared: true, lease: leaseFor(lease, next) }
    })
  },
}