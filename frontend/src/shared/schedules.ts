import { toPlainText } from "./text"
import { isLocalDate, todayLocal } from "./time"
import {
  CONTENT_SCHEMA_VERSION,
  type EntryContent,
  type Iso,
  type LocalDate,
  type Schedule,
  type SchedulePhase,
} from "./types"

export const SCHEDULE_META_KEYS = {
  cursor: "scheduleLastSyncAt",
  conflicts: "scheduleConflicts",
  errors: "scheduleSyncErrors",
  conversions: "scheduleConversions",
  draft: "scheduleDraft",
} as const

const TEXT_NODES = new Set([
  "doc", "paragraph", "text", "heading", "blockquote", "bulletList", "orderedList",
  "listItem", "codeBlock", "hardBreak", "horizontalRule",
])
const TEXT_MARKS = new Set(["bold", "italic", "strike", "code"])

/** 首版只接收文本型 StarterKit JSON，不让隐藏图片或未知节点进入存储。 */
export function assertScheduleContent(content: EntryContent | null): void {
  if (content === null) return
  if (
    !content || content.schemaVersion !== CONTENT_SCHEMA_VERSION ||
    !content.doc || content.doc.type !== "doc"
  ) throw new Error("预简正文格式或版本不受支持")

  const seen = new Set<object>()
  const walk = (raw: unknown, depth: number): void => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > 100) {
      throw new Error("预简正文节点无效")
    }
    if (seen.has(raw)) throw new Error("预简正文不能含循环或重复对象引用")
    seen.add(raw)
    const node = raw as {
      type?: unknown; text?: unknown; content?: unknown; marks?: unknown; attrs?: unknown
    }
    if (typeof node.type !== "string" || !TEXT_NODES.has(node.type)) {
      throw new Error("预简首版仅支持文本，图片与其他节点请在转简后添加")
    }
    if (node.type === "doc" && depth !== 0) throw new Error("预简正文不能嵌套 doc")
    if (node.type === "text" && typeof node.text !== "string") {
      throw new Error("预简文字节点缺少 text")
    }
    if (node.text !== undefined && typeof node.text !== "string") {
      throw new Error("预简文字字段无效")
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) throw new Error("预简正文 content 必须是数组")
      for (const child of node.content) walk(child, depth + 1)
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) throw new Error("预简正文 marks 必须是数组")
      for (const mark of node.marks) {
        if (!mark || typeof mark !== "object" || !TEXT_MARKS.has(mark.type)) {
          throw new Error("预简文字标记不受支持")
        }
      }
    }
  }
  walk(content.doc, 0)
}

export function assertScheduleDate(value: LocalDate): void {
  if (typeof value !== "string" || !isLocalDate(value)) throw new Error("预简日期无效")
}

/** 普通今天/过去的新建内容仍由日记入口承担；改期可以落到已至之日。 */
export function assertNewScheduleDate(value: LocalDate, today = todayLocal()): void {
  assertScheduleDate(value)
  assertScheduleDate(today)
  if (value <= today) throw new Error("新预简请选择未来日期，已至之日请刻日记")
}

export function assertScheduleBody(title: string, content: EntryContent | null): void {
  if (typeof title !== "string") throw new Error("预简标题无效")
  assertScheduleContent(content)
  if (!title.trim() && !toPlainText(content).trim()) throw new Error("请填写预简标题或正文")
}

export function schedulePhase(
  row: Pick<Schedule, "remindDate" | "status" | "isDeleted">,
  today = todayLocal(),
): SchedulePhase {
  assertScheduleDate(row.remindDate)
  assertScheduleDate(today)
  if (row.isDeleted === 1) return "deleted"
  if (row.status === "converted") return "converted"
  if (row.status !== "pending") throw new Error("预简状态无效")
  if (row.remindDate > today) return "future"
  return row.remindDate === today ? "due" : "overdue"
}

/** 由来源 UUID v7 直接映射；不同资源表允许相同主键，不另造随机 Entry ID。 */
export function scheduleEntryId(scheduleId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scheduleId)) {
    throw new Error("预简来源必须为 UUID v7")
  }
  return scheduleId.toLowerCase()
}

export function assertConvertibleSchedule(row: Schedule, today = todayLocal()): void {
  if (row.isDeleted) throw new Error("已删除预简不能转简")
  if (row.status !== "pending") throw new Error("预简已转简，请打开关联日记")
  if (schedulePhase(row, today) === "future") throw new Error("尚未到期，暂不能转简")
  if (row.convertedEntryId !== null || row.convertedAt !== null) {
    throw new Error("预简转换关系异常")
  }
}

/** 同毫秒连续修改也有不同修订，避免迟到响应误清下一次修改的 dirty。 */
export function nextScheduleRevision(previous: Iso, now: Iso): Iso {
  const before = Date.parse(previous)
  const current = Date.parse(now)
  if (!Number.isFinite(before) || !Number.isFinite(current)) throw new Error("预简修订时间无效")
  return new Date(Math.max(before + 1, current)).toISOString()
}
