import type { DiaryTarget, DiaryTargetLease, ScheduleHostContext } from "@/shared/scheduleHostTypes"
import { assertDraftId, isDraftIso } from "@/shared/scheduleDrafts"
import { canOpenScheduleDiaryContent } from "@/shared/scheduleEditorContent"
import { isBackupSchedule } from "@/shared/scheduleBackup"
import { assertScheduleDate, nextScheduleRevision } from "@/shared/schedules"
import { collectMediaIds } from "@/shared/text"
import { todayLocal, utcNow } from "@/shared/time"
import type { EntryUpdateDto } from "@/shared/types"
import { assertHostContext } from "./scheduleHostContext"
import { localEntryRepo } from "./entryRepo"
import { localMediaRepo } from "./mediaRepo"
import { db } from "./schema"

async function target(id: string): Promise<DiaryTarget> {
  const purges = await db.meta.get("pendingPurges")
  if (purges && (!Array.isArray(purges.value) || purges.value.some(value => typeof value !== "string"))) throw new Error("日记弃去队列不受支持，未当作空队列")
  const entry = await db.entries.get(id)
  if (!entry || entry.isDeleted !== 0 || (Array.isArray(purges?.value) && purges.value.includes(id))) throw new Error("目标日记已删除/弃去或不存在，未重新创建")
  if (!isDraftIso(entry.clientUpdatedAt) || !isDraftIso(entry.createdAt) || !isDraftIso(entry.updatedAt) ||
    (entry.serverUpdatedAt !== "" && !isDraftIso(entry.serverUpdatedAt)) || entry.deletedAt !== null ||
    !Number.isSafeInteger(entry.sortOrder) || entry.sortOrder < 0 || typeof entry.title !== "string" ||
    !(entry.mood === null || typeof entry.mood === "string") || !(entry.weather === null || typeof entry.weather === "string") ||
    !Array.isArray(entry.tagIds) || entry.tagIds.some(id => typeof id !== "string" || !id) || !canOpenScheduleDiaryContent(entry.content)) throw new Error("目标日记格式不受支持，未打开可写正文")
  assertScheduleDate(entry.entryDate)
  if (entry.fromScheduleId !== null) {
    if (entry.fromScheduleId !== id) throw new Error("目标日记来源关系不一致")
    const source = await db.schedules.get(id)
    if (!isBackupSchedule(source) || source.status !== "converted" || source.convertedEntryId !== id) throw new Error("目标日记转换身份缺失或不一致，未修复或补生")
  }
  return { entry, lease: { id, fromScheduleId: entry.fromScheduleId, clientUpdatedAt: entry.clientUpdatedAt } }
}
export async function openDiaryTarget(context: ScheduleHostContext, id: string): Promise<DiaryTarget> {
  context = { ...context }; assertDraftId(id)
  return db.transaction("r", db.entries, db.schedules, db.meta, async () => {
    await assertHostContext(context); const value = await target(id); await assertHostContext(context); return value
  })
}
export async function saveDiaryTarget(context: ScheduleHostContext, lease: DiaryTargetLease, update: EntryUpdateDto): Promise<DiaryTarget> {
  context = { ...context }; lease = { ...lease }; update = structuredClone(update)
  assertDraftId(lease.id)
  if (!isDraftIso(lease.clientUpdatedAt)) throw new Error("目标日记保存修订无效")
  if (!update || Object.keys(update).some(key => !["entryDate", "title", "content", "mood", "weather", "tagIds"].includes(key))) throw new Error("目标日记更新载荷无效，不接受改变来源或终态")
  if (update.title !== undefined && (typeof update.title !== "string" || update.title.length > 255)) throw new Error("日记标题无效")
  if (update.content !== undefined && !canOpenScheduleDiaryContent(update.content)) throw new Error("日记正文不可安全编辑")
  for (const value of [update.mood, update.weather]) if (value !== undefined && value !== null && typeof value !== "string") throw new Error("日记元信息无效")
  if (update.tagIds !== undefined && (!Array.isArray(update.tagIds) || update.tagIds.some(id => typeof id !== "string" || !id))) throw new Error("日记标签无效")
  return db.transaction("rw", db.entries, db.media, db.schedules, db.meta, async () => {
    await assertHostContext(context)
    const current = await target(lease.id)
    if (current.lease.clientUpdatedAt !== lease.clientUpdatedAt || current.lease.fromScheduleId !== lease.fromScheduleId) throw new Error("目标日记已变化，请明确核对；未覆盖或换来源")
    if (update.entryDate !== undefined) {
      assertScheduleDate(update.entryDate)
      if (update.entryDate > todayLocal()) throw new Error("已存在日记不能改为未来日或自动搬到预简")
    }
    if (update.content !== undefined) for (const id of collectMediaIds(update.content?.doc)) {
      const media = await db.media.get(id)
      if (!media || (media.entryId && media.entryId !== lease.id)) throw new Error("日记图片缺失或归属不同，未抢占图片")
    }
    const saved = await localEntryRepo.update(lease.id, update)
    const revision = nextScheduleRevision(current.entry.clientUpdatedAt, utcNow())
    saved.updatedAt = revision; saved.clientUpdatedAt = revision
    await db.entries.put(saved)
    if (update.content !== undefined) await localMediaRepo.attach(lease.id, collectMediaIds(update.content?.doc))
    await assertHostContext(context)
    return { entry: saved, lease: { ...lease, clientUpdatedAt: revision } }
  })
}
