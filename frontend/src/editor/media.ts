import type { Editor } from "@tiptap/vue-3"

import { mediaRepo } from "@/repo"
import { parseLocalSrc, toLocalSrc } from "@/shared/text"

/** 只接受浏览器能解码的位图。HEIC 在多数浏览器里显示不出来，先拦掉 */
const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"]

/** 单张上限。超过这个尺寸的图存进 IndexedDB 会明显卡顿 */
const MAX_SIZE = 10 * 1024 * 1024

export interface InsertResult {
  inserted: number
  rejected: string[]
}

/**
 * 把文件写进本地库并插入图片节点。
 *
 * 关键点：先 await 落库、拿到 ID，再插入节点。
 * 反过来做（先插节点占位、异步补 ID）会在用户于写入完成前保存时
 * 留下一个指向不存在 ID 的节点，也就是永久碎图。
 */
export async function insertImages(editor: Editor, files: File[]): Promise<InsertResult> {
  const rejected: string[] = []
  let inserted = 0

  for (const file of files) {
    if (!ACCEPTED.includes(file.type)) {
      rejected.push(`${file.name}：不支持的格式`)
      continue
    }
    if (file.size > MAX_SIZE) {
      rejected.push(`${file.name}：超过 10 MB`)
      continue
    }

    // 此时 entryId 还是空字符串——这篇日记可能还没落库。
    // 保存时再由 mediaRepo.attach 认领，认领不到的由 purgeOrphans 清掉。
    const item = await mediaRepo.add(file)

    editor
      .chain()
      .focus()
      .setImage({ src: toLocalSrc(item.id), alt: file.name })
      .createParagraphNear()
      .run()

    inserted += 1
  }

  return { inserted, rejected }
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

    const n = node as { type?: string; attrs?: { src?: string }; content?: unknown[] }

    if (n.type === "image" && typeof n.attrs?.src === "string") {
      const id = parseLocalSrc(n.attrs.src)
      if (id && !ids.includes(id)) ids.push(id)
    }

    if (Array.isArray(n.content)) n.content.forEach(walk)
  }

  walk(doc)
  return ids
}
