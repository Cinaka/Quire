import type { ScheduleDraftReadResult } from "@/db/scheduleDraftRepo"

import { isBackupSchedule, scheduleContentTooNew } from "./scheduleBackup"
import { schedulePhase } from "./schedules"
import { toPlainText } from "./text"
import type { LocalDate, Schedule } from "./types"

export function presentSchedule(row: Schedule, today: LocalDate) {
  if (!isBackupSchedule(row) || scheduleContentTooNew(row)) {
    return { usable: false, phase: null, label: "记录格式不受支持，请保留并检查备份", preview: "",
      canEdit: false, canConvert: false, canRemove: false, canRestore: false, canInspect: false }
  }
  const phase = schedulePhase(row, today)
  const labels = { future: "待刻", due: "今日待刻", overdue: "已逾期", converted: "已转简", deleted: "已移入断简" }
  return { usable: true, phase, label: labels[phase], preview: toPlainText(row.content).slice(0, 180),
    canEdit: row.isDeleted === 0 && row.status === "pending",
    canConvert: phase === "due" || phase === "overdue", canRemove: row.isDeleted === 0,
    canRestore: row.isDeleted === 1, canInspect: row.isDeleted === 0 && row.status === "converted" }
}

export function draftRecoveryMessage(status: ScheduleDraftReadResult["status"]): string {
  const messages = {
    empty: "",
    recoverable: "发现本机安全草稿。恢复不会自动保存为预简，也不会上传云端。",
    alreadySaved: "草稿与本机预简内容相同。请恢复核对后保存，或明确弃去草稿。",
    conflict: "预简来源已变化。草稿文字仍可恢复；不能直接覆盖来源，请先核对冲突。",
    sourceUnavailable: "草稿来源已删除、转简、缺失或不受支持。可恢复文字，但不能保存回原来源。",
  }
  return messages[status]
}
