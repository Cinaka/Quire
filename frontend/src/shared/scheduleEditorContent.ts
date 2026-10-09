import { assertScheduleContent } from "./schedules"
import { CONTENT_SCHEMA_VERSION, type EntryContent } from "./types"

const DIARY_NODES = new Set(["doc", "paragraph", "text", "heading", "blockquote", "bulletList", "orderedList", "listItem", "codeBlock", "hardBreak", "image"])
const DIARY_MARKS = new Set(["bold", "italic", "strike", "code"])
function compatibleTree(raw: unknown, depth: number, seen: Set<object>, images: boolean): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > 100 || seen.has(raw)) throw new Error("正文结构不可安全编辑")
  seen.add(raw)
  const node = raw as { type?: unknown; text?: unknown; content?: unknown; marks?: unknown; attrs?: { level?: unknown } }
  if (typeof node.type !== "string" || !DIARY_NODES.has(node.type) || (!images && node.type === "image") ||
    (node.type === "doc" && depth !== 0)) throw new Error("正文含当前日记编辑器不支持的节点，请保留并使用兼容版本")
  if (node.attrs !== undefined && (!node.attrs || typeof node.attrs !== "object" || Array.isArray(node.attrs))) throw new Error("正文节点属性无效")
  const level = node.attrs?.level ?? 1
  if (node.type === "heading" && (typeof level !== "number" || ![1, 2, 3].includes(level))) throw new Error("当前日记编辑器仅支持1～3级标题，请保留原正文")
  if (["text", "image", "hardBreak"].includes(node.type) && Array.isArray(node.content) && node.content.length) throw new Error("正文叶节点不能含子正文")
  if ((node.type === "text" && typeof node.text !== "string") || (node.text !== undefined && typeof node.text !== "string")) throw new Error("正文文字字段无效")
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) throw new Error("正文节点结构无效")
    for (const child of node.content) compatibleTree(child, depth + 1, seen, images)
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks) || node.marks.some(mark => !mark || typeof mark !== "object" || !("type" in mark) || typeof mark.type !== "string" || !DIARY_MARKS.has(mark.type))) throw new Error("正文格式不受当前日记编辑器支持")
  }
}
/** 数据/备份仍按既定规则保存；此处只限制当前UI，不静默删去不兼容节点。 */
export function assertScheduleEditorContent(content: EntryContent | null): void {
  assertScheduleContent(content)
  if (content) compatibleTree(content.doc, 0, new Set(), false)
}
/** 转简后允许原日记图片节点；未知版本/损坏树不能误开可写编辑器。 */
export function canOpenScheduleDiaryContent(content: EntryContent | null): boolean {
  if (content === null) return true
  try {
    if (!content || content.schemaVersion !== CONTENT_SCHEMA_VERSION || content.doc?.type !== "doc") return false
    compatibleTree(content.doc, 0, new Set(), true)
    return true
  } catch { return false }
}
