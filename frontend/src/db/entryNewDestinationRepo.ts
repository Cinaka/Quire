import type { ScheduleHostContext } from "@/shared/scheduleHostTypes"
import { assertScheduleDate } from "@/shared/schedules"
import { todayLocal } from "@/shared/time"
import { assertHostContext, captureHostContext } from "./scheduleHostContext"
import { parseNewDiaryDraft } from "./scheduleFirstSaveRepo"
import { db } from "./schema"

export type EntryNewDestination =
  | { mode: "diary" }
  | { mode: "schedule"; date: string; firstSave: boolean; context: ScheduleHostContext }

/** 首次新建的只读入口判定；未来请求/未来未关联原稿均不能先挂载普通日记自动保存器。 */
export async function readEntryNewDestination(requested: unknown): Promise<EntryNewDestination> {
  const today = todayLocal()
  const date = requested === undefined ? today : requested
  if (typeof date !== "string") throw new Error("新建日期参数无效，未回退为今天")
  assertScheduleDate(date)
  return db.transaction("r", db.meta, async () => {
    const context = await captureHostContext()
    await assertHostContext(context)
    const stored = await db.meta.get("draft")
    let original: string | null = null
    if (stored) {
      if (!stored.value || typeof stored.value !== "object" || Array.isArray(stored.value)) throw new Error("原安全草稿格式不受支持，未覆盖")
      const identity = (stored.value as { entryId?: unknown }).entryId
      if (identity === null) original = parseNewDiaryDraft(stored.value).entryDate
      else if (typeof identity !== "string" || !identity) throw new Error("原安全草稿身份不受支持，未覆盖")
    }
    await assertHostContext(context)
    const currentDay = todayLocal()
    if (date > currentDay || (original !== null && original > currentDay)) {
      return { mode: "schedule" as const, date: date > currentDay ? date : original!, firstSave: original !== null, context: { ...context } }
    }
    return { mode: "diary" as const }
  })
}
