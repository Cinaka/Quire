import type { EntryContent } from "./types"

type AnyNode = {
  type?: string
  text?: string
  content?: AnyNode[]
  attrs?: Record<string, unknown>
}

/** 这些节点结束时应该换行，其余节点（如 bold 标记、doc）不换行。 */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "tableCell",
  "tableHeader",
])

/**
 * 把 Tiptap JSON 抽成纯文本，供搜索使用。
 *
 * 这个函数放在 shared/ 里、不依赖任何浏览器 API，是有意的：
 * P2 之后服务端也需要同一套抽取逻辑来兜底校验，
 * 届时这个文件可以直接被 Node 端复用。
 */
export function toPlainText(content: EntryContent | null | undefined): string {
  const doc = content?.doc as AnyNode | undefined
  if (!doc) return ""

  const lines: string[] = []
  let buf = ""

  const flush = (): void => {
    const s = buf.trim()
    if (s) lines.push(s)
    buf = ""
  }

  const walk = (node: AnyNode): void => {
    if (node.type === "text") {
      buf += node.text ?? ""
      return
    }
    if (node.type === "hardBreak") {
      buf += " "
      return
    }
    if (node.type === "image") {
      const alt = node.attrs?.alt
      if (typeof alt === "string" && alt) buf += ` ${alt} `
      return
    }
    node.content?.forEach(walk)
    if (node.type && BLOCK_TYPES.has(node.type)) flush()
  }

  walk(doc)
  flush()
  return lines.join("\n")
}
