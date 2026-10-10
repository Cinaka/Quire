import { assertScheduleEditorContent, canOpenScheduleDiaryContent } from "./scheduleEditorContent"
import { assertScheduleDate } from "./schedules"
import { collectMediaIds, toPlainText } from "./text"
import type { FirstSaveFrame, FirstSavePlan } from "./scheduleHostTypes"
import { CONTENT_SCHEMA_VERSION, type LocalDate } from "./types"

/** 仅首次新建按用户选定的自然日分流；既有日记/预简不因改期自动换表。 */
export function planFirstSave(frame: FirstSaveFrame, date: LocalDate, today: LocalDate): FirstSavePlan {
  assertScheduleDate(date); assertScheduleDate(today)
  if (frame.draft.entryId !== null) throw new Error("此草稿已关联日记，不能作为首次保存重新创建或搬到预简")
  const content = { schemaVersion: CONTENT_SCHEMA_VERSION, doc: frame.draft.doc }
  const resource = date > today ? "schedule" : "entry"
  if (resource === "schedule") {
    if (frame.draft.mood !== null || frame.draft.weather !== null || frame.draft.tagIds.length) throw new Error("未来预简不接收日记元信息；请明确处理，原安全草稿已保留")
    assertScheduleEditorContent(content)
  } else if (!canOpenScheduleDiaryContent(content)) throw new Error("日记正文格式不受支持，原安全草稿已保留")
  if (!frame.draft.title.trim() && !toPlainText(content).trim() && !frame.draft.mood && !frame.draft.weather &&
    !frame.draft.tagIds.length && !collectMediaIds(content.doc).length) throw new Error("请填写日记或预简内容，未创建空记录")
  return { fingerprint: frame.fingerprint, date, resource }
}
