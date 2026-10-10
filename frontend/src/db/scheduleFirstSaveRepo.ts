import type { EditorDraft } from "./draftRepo"
import { planFirstSave } from "@/shared/firstSave"
import { scheduleDraftFingerprint, isDraftIso } from "@/shared/scheduleDrafts"
import { collectMediaIds } from "@/shared/text"
import { assertScheduleDate } from "@/shared/schedules"
import { CONTENT_SCHEMA_VERSION } from "@/shared/types"
import type { FirstSaveFrame, FirstSavePlan, FirstSaveResult, ScheduleHostContext } from "@/shared/scheduleHostTypes"
import { todayLocal } from "@/shared/time"
import { assertHostContext } from "./scheduleHostContext"
import { localEntryRepo } from "./entryRepo"
import { localMediaRepo } from "./mediaRepo"
import { localScheduleDraftRepo } from "./scheduleDraftRepo"
import { db } from "./schema"

function parseNewDiaryDraft(raw: unknown): EditorDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("原日记安全草稿格式不受支持，未覆盖")
  const draft = raw as EditorDraft
  if (Object.keys(raw).some(key => !["entryId", "entryDate", "title", "mood", "weather", "tagIds", "doc", "updatedAt"].includes(key)) ||
    draft.entryId !== null || typeof draft.title !== "string" || draft.title.length > 255 || !isDraftIso(draft.updatedAt) ||
    !(draft.mood === null || typeof draft.mood === "string") || !(draft.weather === null || typeof draft.weather === "string") ||
    !Array.isArray(draft.tagIds) || draft.tagIds.some(id => typeof id !== "string" || !id) || draft.doc?.type !== "doc") {
    throw new Error("仅处理已确认的未关联日记安全草稿，原值已保留")
  }
  assertScheduleDate(draft.entryDate)
  return JSON.parse(JSON.stringify(draft)) as EditorDraft
}
async function frame(): Promise<FirstSaveFrame | null> {
  const row = await db.meta.get("draft")
  if (!row) return null
  return { fingerprint: scheduleDraftFingerprint(true, row.value), draft: parseNewDiaryDraft(row.value) }
}
export async function readFirstSaveFrame(context: ScheduleHostContext): Promise<FirstSaveFrame | null> {
  context = { ...context }
  return db.transaction("r", db.meta, async () => { await assertHostContext(context); const value = await frame(); await assertHostContext(context); return value })
}

/** 显式首存：同一事务消费准确草稿快照，未来进Schedule，否则普通Entry；不改旧日记草稿协议。 */
export async function commitFirstSave(context: ScheduleHostContext, plan: FirstSavePlan): Promise<FirstSaveResult> {
  context = { ...context }; plan = { ...plan }
  return db.transaction("rw", db.entries, db.media, db.schedules, db.meta, async () => {
    await assertHostContext(context)
    const current = await frame()
    if (!current || current.fingerprint !== plan.fingerprint) throw new Error("日记安全草稿已变化或已消费，未采用新草稿重放旧首存")
    const actual = planFirstSave(current, plan.date, todayLocal())
    if (actual.resource !== plan.resource) throw new Error("日期分流已变化，请重新核对后明确确认，未跨午夜自动换表")
    const draft = current.draft
    const content = { schemaVersion: CONTENT_SCHEMA_VERSION, doc: draft.doc }
    let result: FirstSaveResult
    if (actual.resource === "schedule") {
      const slot = await localScheduleDraftRepo.read()
      if (slot.draft) throw new Error("已有预简安全草稿，请先恢复或明确弃去，未覆盖任一草稿")
      const stored = await localScheduleDraftRepo.save(slot.lease, { draftId: null, scheduleId: null, baseClientUpdatedAt: null,
        remindDate: actual.date, title: draft.title, content })
      const saved = await localScheduleDraftRepo.commit(stored.lease, stored.draft!.draftId)
      if (await db.entries.get(saved.schedule.id)) throw new Error("预简主键与既有日记碰撞，未覆盖")
      result = { resource: "schedule", schedule: saved.schedule }
    } else {
      const mediaIds = collectMediaIds(content.doc)
      for (const id of mediaIds) {
        const media = await db.media.get(id)
        if (!media || media.entryId) throw new Error("草稿图片缺失或已归属其他日记，未抢占或丢弃图片")
      }
      const entry = await localEntryRepo.create({ entryDate: actual.date, title: draft.title, content,
        mood: draft.mood, weather: draft.weather, tagIds: draft.tagIds, fromScheduleId: null })
      if (!Number.isSafeInteger(entry.sortOrder) || entry.sortOrder < 0 || await db.schedules.get(entry.id)) throw new Error("首存排序或资源主键异常，未半写入")
      if (mediaIds.length) await localMediaRepo.attach(entry.id, mediaIds)
      result = { resource: "entry", entry }
    }
    await db.meta.delete("draft")
    await assertHostContext(context) // token切换若发生于存储等待期间，则整个事务回滚。
    return result
  })
}
