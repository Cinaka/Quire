import { createScheduleEditorSession } from "@/shared/scheduleEditor"
import { isBackupSchedule, scheduleContentTooNew } from "@/shared/scheduleBackup"
import { assertDraftId } from "@/shared/scheduleDrafts"
import { assertScheduleDate } from "@/shared/schedules"
import type { LocalDate } from "@/shared/types"

import { localScheduleDraftRepo } from "./scheduleDraftRepo"
import { db } from "./schema"

/** 只开放给内部测试，恢复必须显式resume；不自动覆盖占用槽位，不导出到@/repo。 */
export const localScheduleEditorRepo = {
  async openNew(remindDate: LocalDate) {
    assertScheduleDate(remindDate)
    const context = await localScheduleDraftRepo.read()
    if (context.draft) throw new Error("已有预简草稿，请先恢复或明确弃去")
    return createScheduleEditorSession(localScheduleDraftRepo, context, {
      scheduleId: null, baseClientUpdatedAt: null, remindDate, title: "", content: null,
    })
  },
  async resume() {
    const context = await localScheduleDraftRepo.read()
    if (!context.draft) throw new Error("没有可恢复的预简草稿")
    const draft = context.draft
    const payload = { scheduleId: draft.scheduleId, baseClientUpdatedAt: draft.baseClientUpdatedAt,
      remindDate: draft.remindDate, title: draft.title, content: draft.content }
    // conflict/sourceUnavailable也可恢复文字；正式保存仍拒绝覆盖变化或终态来源。
    return createScheduleEditorSession(localScheduleDraftRepo, context, payload)
  },
  async openExisting(id: string) {
    assertDraftId(id)
    return db.transaction("r", db.schedules, db.meta, async () => {
      const context = await localScheduleDraftRepo.read()
      if (context.draft) throw new Error("已有预简草稿，请先恢复或明确弃去")
      const source = await db.schedules.get(id)
      if (!source || !isBackupSchedule(source) || scheduleContentTooNew(source) ||
        source.isDeleted || source.status !== "pending") throw new Error("预简来源不可编辑")
      return createScheduleEditorSession(localScheduleDraftRepo, context, {
        scheduleId: source.id, baseClientUpdatedAt: source.clientUpdatedAt,
        remindDate: source.remindDate, title: source.title, content: source.content,
      })
    })
  },
}
