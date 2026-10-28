import type { Entry } from "./types"

/** Copy restore only: replace exact image attrs.src identities, not JSON/text substrings. */
export function remapBackupMediaRefs(content: Entry["content"], map: ReadonlyMap<string, string>): Entry["content"] {
  if (!content || !map.size) return content
  const copy = JSON.parse(JSON.stringify(content)) as NonNullable<Entry["content"]>
  const stack: unknown[] = [copy.doc]
  let visited = 0
  while (stack.length) {
    const raw = stack.pop()
    if (!raw || typeof raw !== "object") continue
    if (++visited > 200_000) throw new Error("备份正文结构过大，未导入")
    const node = raw as Record<string, unknown>
    if (node.type === "image" && node.attrs && typeof node.attrs === "object") {
      const attrs = node.attrs as Record<string, unknown>, src = attrs.src
      if (typeof src === "string" && src.startsWith("local://media/")) {
        const to = map.get(src.slice("local://media/".length))
        if (to) attrs.src = `local://media/${to}`
      }
    }
    if (Array.isArray(node.content)) stack.push(...node.content)
  }
  return copy
}
