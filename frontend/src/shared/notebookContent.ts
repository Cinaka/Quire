/** Safe presentation projection. Never normalizes or writes stored Entry JSON. */
export type NotebookTag = "div" | "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "li" | "blockquote" | "pre" | "code" | "br" | "strong" | "em" | "s"
export type NotebookNode =
  | { kind: "text"; text: string }
  | { kind: "element"; tag: NotebookTag; children: NotebookNode[]; start?: number }
  | { kind: "image"; mediaId: string; alt: string; title: string }
  | { kind: "notice"; text: string }
export interface NotebookProjection { nodes: NotebookNode[]; warnings: string[]; mediaIds: string[] }

const LOCAL_MEDIA = /^local:\/\/media\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
export function notebookMediaId(src: unknown): string | null {
  return typeof src === "string" ? LOCAL_MEDIA.exec(src)?.[1] ?? null : null
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null

export function projectNotebookContent(value: unknown): NotebookProjection {
  const warnings = new Set<string>(), mediaIds = new Set<string>(), ancestors = new WeakSet<object>()
  let visited = 0
  const warn = (message: string) => { warnings.add(message) }
  function walk(value: unknown, depth: number): NotebookNode[] {
    if (++visited > 200_000 || depth > 128) {
      warn("正文结构超过安全阅读上限，部分内容未展开；原文未修改。")
      return [{ kind: "notice", text: "部分结构未展开" }]
    }
    const node = record(value)
    if (!node) { warn("存在无效正文节点，无法完整呈现。" ); return [] }
    if (ancestors.has(node)) { warn("正文存在循环结构，无法完整呈现。" ); return [] }
    ancestors.add(node)
    const children = (): NotebookNode[] => {
      if (node.content === undefined) return []
      if (!Array.isArray(node.content)) { warn("正文子节点结构不受支持。" ); return [] }
      return node.content.flatMap(child => walk(child, depth + 1))
    }
    let result: NotebookNode[]
    const attrs = record(node.attrs) ?? {}
    if (node.type === "text") {
      if (typeof node.text !== "string") warn("存在无效文字节点。")
      let text: NotebookNode = { kind: "text", text: typeof node.text === "string" ? node.text : "" }
      if (node.marks !== undefined && !Array.isArray(node.marks)) warn("存在不支持的文字样式结构。")
      const tags: Record<string, NotebookTag> = { bold: "strong", italic: "em", strike: "s", code: "code" }
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        const m = record(mark), tag = m && typeof m.type === "string" && Object.hasOwn(tags, m.type) ? tags[m.type] : undefined
        if (tag) text = { kind: "element", tag, children: [text] }
        else warn("存在不支持的文字样式，已保留文字但未应用该样式。")
      }
      result = [text]
    } else if (node.type === "image") {
      const id = notebookMediaId(attrs.src)
      if (id) {
        mediaIds.add(id)
        result = [{ kind: "image", mediaId: id, alt: typeof attrs.alt === "string" ? attrs.alt : "", title: typeof attrs.title === "string" ? attrs.title : "" }]
      } else {
        warn("存在非本机或无效图片引用，未发起远程请求。")
        result = [{ kind: "notice", text: typeof attrs.alt === "string" && attrs.alt ? `不支持的图片：${attrs.alt}` : "不支持的图片引用" }]
      }
    } else {
      const tags: Record<string, NotebookTag> = { doc: "div", paragraph: "p", bulletList: "ul", orderedList: "ol", listItem: "li", blockquote: "blockquote", codeBlock: "pre", hardBreak: "br" }
      let tag = typeof node.type === "string" && Object.hasOwn(tags, node.type) ? tags[node.type] : undefined
      if (node.type === "heading") {
        if (attrs.level === 1 || attrs.level === 2 || attrs.level === 3) tag = `h${attrs.level}` as NotebookTag
        else { tag = "p"; warn("标题级别不受支持，已按段落保留。") }
      }
      const safeChildren = children()
      if (tag) {
        const element: NotebookNode = { kind: "element", tag, children: safeChildren }
        if (tag === "ol" && attrs.start !== undefined) {
          if (Number.isSafeInteger(attrs.start) && Number(attrs.start) >= 1 && Number(attrs.start) <= 1_000_000) element.start = Number(attrs.start)
          else warn("有序列表起始序号无效，按1开始显示。")
        }
        result = [element]
        if (tag === "br" && safeChildren.length) {
          warn("换行节点含异常子节点，已另外保留。")
          result.push(...safeChildren)
        }
      } else {
        warn("存在不支持的正文节点；以下只保留可安全读取的文字和子节点，不代表完整呈现。")
        result = [{ kind: "notice", text: "不支持的正文结构" }]
        if (typeof node.text === "string") result.push({ kind: "text", text: node.text })
        result.push(...safeChildren)
      }
    }
    ancestors.delete(node)
    return result
  }
  if (value == null) return { nodes: [], warnings: [], mediaIds: [] }
  const content = record(value)
  if (!content) return { nodes: [], warnings: ["正文封装格式不受支持，无法完整呈现。"], mediaIds: [] }
  if (content.schemaVersion !== 1) warn("正文版本不受支持，以下仅为安全兼容阅读，不代表完整呈现。")
  if (record(content.doc)?.type !== "doc") warn("正文根结构不受支持。")
  const nodes = walk(content.doc, 0)
  return { nodes, warnings: [...warnings], mediaIds: [...mediaIds] }
}
