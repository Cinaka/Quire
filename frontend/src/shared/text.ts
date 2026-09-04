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
    // 改后：图片不进纯文本索引。
  // 原先拼的是 attrs.alt，而 alt 存的是上传时的文件名（17883932.jpg / IMG_2026.HEIC），
  // 它会直接漏进首页与列表摘要，也让搜索被文件名命中。
  // 图片的存在感改由 UI 的缩略图与数量徽标表达，不占用纯文本字段。
    if (node.type === "image") return
    node.content?.forEach(walk)
    if (node.type && BLOCK_TYPES.has(node.type)) flush()
  }

  walk(doc)
  flush()
  return lines.join("\n")
}


/** 编辑器里图片节点的 src 用这个协议，绝不存 blob: 开头的临时地址。 */
export const LOCAL_MEDIA_PREFIX = "local://media/"

export function toLocalSrc(mediaId: string): string {
  return `${LOCAL_MEDIA_PREFIX}${mediaId}`
}

export function parseLocalSrc(src: string): string | null {
  return src.startsWith(LOCAL_MEDIA_PREFIX) ? src.slice(LOCAL_MEDIA_PREFIX.length) : null
}


export interface TextPart {
  text: string
  hit: boolean
}

/**
 * 生成列表摘要，并把命中关键词的片段切出来。
 *
 * 返回的是片段数组而不是 HTML 字符串，渲染层用 v-for 逐段输出。
 * 这样就完全不需要 v-html——正文虽然是用户自己写的，
 * 但 P2 同步之后内容可能来自别的设备，留一个注入面没必要。
 */
export function highlightParts(text: string, keyword: string, max = 90): TextPart[] {
  const flat = text.replace(/\s+/g, " ").trim()
  const ellipsis = (s: string): TextPart[] => [
    { text: s.length > max ? `${s.slice(0, max)}…` : s, hit: false },
  ]

  const kw = keyword.trim()
  if (!kw) return ellipsis(flat)

  const lowerFlat = flat.toLowerCase()
  const lowerKw = kw.toLowerCase()
  const first = lowerFlat.indexOf(lowerKw)
  if (first === -1) return ellipsis(flat)

  // 命中处往前留 20 字上文，否则用户只看到关键词、看不懂在说什么
  const start = Math.max(0, first - 20)
  const win = flat.slice(start, start + max)
  const lowerWin = win.toLowerCase()

  const parts: TextPart[] = []
  if (start > 0) parts.push({ text: "…", hit: false })

  let cursor = 0
  for (;;) {
    const i = lowerWin.indexOf(lowerKw, cursor)
    if (i === -1) break
    if (i > cursor) parts.push({ text: win.slice(cursor, i), hit: false })
    parts.push({ text: win.slice(i, i + kw.length), hit: true })
    cursor = i + kw.length
  }
  if (cursor < win.length) parts.push({ text: win.slice(cursor), hit: false })
  if (start + max < flat.length) parts.push({ text: "…", hit: false })

  return parts
}

/**
 * 从 Tiptap doc 里递归抽出所有本地图片 ID。
 *
 * 纯 JSON 遍历，不依赖 Tiptap 运行时——所以保存时可以直接对存量 JSON 调用，
 * 不需要先把内容灌进编辑器实例。
 */
export function collectMediaIds(doc: unknown): string[] {
  const ids: string[] = []

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const value = node as {
      type?: string
      attrs?: { src?: string }
      content?: unknown[]
    }

    if (value.type === "image" && typeof value.attrs?.src === "string") {
      const id = parseLocalSrc(value.attrs.src)
      if (id && !ids.includes(id)) ids.push(id)
    }
    if (Array.isArray(value.content)) value.content.forEach(walk)
  }

  walk(doc)
  return ids
}
