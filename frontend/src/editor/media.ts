// 改后：这个文件只用到 core 的能力（state / view / chain / commands），
// 形参就该收基类。收基类时 vue-3 的 Editor 仍能传进来（子类兼容基类）。
import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"

import { mediaRepo } from "@/repo"
import { parseLocalSrc, toLocalSrc } from "@/shared/text"

/** 只接受浏览器能解码的位图。HEIC 在多数浏览器里显示不出来，先拦掉 */
const ACCEPTED = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]

/** 单张上限。超过这个尺寸的图存进 IndexedDB 会明显卡顿 */
const MAX_SIZE = 10 * 1024 * 1024

export interface InsertResult {
  inserted: number
  rejected: string[]
}

/**
 * 把文件写进本地库并插入图片节点。
 *
 * 关键点：
 *
 * 1. 先 await 所有合法文件落库，拿到 media ID。
 * 2. 所有图片一次性构造成连续 image 节点。
 * 3. 最后一次 transaction 插入：
 *
 *      image
 *      image
 *      image
 *      paragraph
 *
 * 4. 不再每插入一张图片就 createParagraphNear()。
 *
 * 这样连续的 image 节点才能由编辑器样式统一呈现为九宫格。
 *
 * 注意：
 * - src 永远使用 local://media/{id}
 * - 不写入 blob URL
 * - alt 原样保留
 */
export async function insertImages(
  editor: Editor,
  files: File[],
): Promise<InsertResult> {
  const rejected: string[] = []
  const nodes: Array<{
    type: "image"
    attrs: {
      src: string
      alt: string
    }
  }> = []

  let inserted = 0

  for (const file of files) {
    // ─────────────────────────────
    // 格式校验
    // ─────────────────────────────

    if (!ACCEPTED.includes(file.type)) {
      rejected.push(`${file.name}：不支持的格式`)
      continue
    }

    // ─────────────────────────────
    // 文件大小校验
    // ─────────────────────────────

    if (file.size > MAX_SIZE) {
      rejected.push(`${file.name}：超过 10 MB`)
      continue
    }

    // ─────────────────────────────
    // 先落库，再生成正文节点
    //
    // 此时 entryId 还是空字符串。
    // 这篇日记可能还没有落库。
    //
    // 保存时由 mediaRepo.attach 认领，
    // 认领不到的由 purgeOrphans 清理。
    // ─────────────────────────────

    const item = await mediaRepo.add(file)

    nodes.push({
      type: "image",
      // alt 不再写 file.name：文件名对读者无意义（微信图片_2026…、IMG_9527），
      // 还等于把设备上的文件命名习惯写进日记正文。P1 不提供图注入口，
      // 需要图注时再单独做一个编辑 UI，那时写进来的才是用户自己的文字。
      attrs: { src: toLocalSrc(item.id), alt: "" },
    })

    inserted += 1
  }

  // 没有成功插入的图片时，不修改编辑器内容。
  if (nodes.length === 0) {
    return {
      inserted,
      rejected,
    }
  }

  // ─────────────────────────────
  // 一次性插入全部图片
  //
  // 不再：
  //
  //   插图 → createParagraphNear()
  //   插图 → createParagraphNear()
  //   插图 → createParagraphNear()
  //
  // 而是：
  //
  //   image
  //   image
  //   image
  //   paragraph
  //
  // 连续 image 节点由 CSS 负责九宫格呈现。
  // ─────────────────────────────

  editor
    .chain()
    .focus()
    .insertContent([
      ...nodes,
      {
        type: "paragraph",
      },
    ])
    .run()

  return {
    inserted,
    rejected,
  }
}

/**
 * 在当前 ProseMirror 文档中寻找指定 media ID 对应的 image 节点。
 *
 * 不缓存 position。
 *
 * 因为每次 ProseMirror transaction 后 position 都可能发生变化，
 * 调用方只传 mediaId，每次移动时重新从当前 doc 查找。
 */
function imageAt(
  doc: ProseMirrorNode,
  mediaId: string,
): { pos: number; node: ProseMirrorNode } | null {
  let found: {
    pos: number
    node: ProseMirrorNode
  } | null = null

  doc.descendants((node, pos) => {
    if (found || node.type.name !== "image") {
      return
    }

    const id =
      typeof node.attrs.src === "string"
        ? parseLocalSrc(node.attrs.src)
        : null

    if (id === mediaId) {
      found = {
        pos,
        node,
      }
    }
  })

  return found
}

/**
 * 移动正文中的 image 节点。
 *
 * sourceId / targetId 都是 media ID，
 * 不接受、不缓存 ProseMirror position。
 *
 * side:
 * - "before"：移动到目标图片之前
 * - "after"：移动到目标图片之后
 *
 * 重要：
 * 不直接操作 DOM。
 * 不使用 SortableJS 直接搬 DOM。
 * 不使用 getJSON() + 数组 splice + setContent()。
 *
 * 而是直接创建 ProseMirror transaction，
 * 这样：
 *
 * - JSON 顺序会真正改变
 * - undo / redo 可以正常工作
 * - 当前选区不会因为 setContent() 整篇重建而被破坏
 * - Tiptap 状态与实际 DOM 保持一致
 */
export function moveImageNode(
  editor: Editor,
  sourceId: string,
  targetId: string,
  side: "before" | "after",
): boolean {
  // 同一张图片移动到自己前后没有意义。
  if (sourceId === targetId) {
    return false
  }

  // 每次调用都从当前 doc 重新计算 position。
  const source = imageAt(
    editor.state.doc,
    sourceId,
  )

  const target = imageAt(
    editor.state.doc,
    targetId,
  )

  if (!source || !target) {
    return false
  }

  // 目标插入位置：
  //
  // before：
  //   target.pos
  //
  // after：
  //   target.pos + target.node.nodeSize
  //
  // nodeSize 对 image 这种 atom node 通常为 1，
  // 但这里不要手写 +1，统一使用 node.nodeSize。
  const rawTarget =
    side === "before"
      ? target.pos
      : target.pos + target.node.nodeSize

  // 先删除 source。
  //
  // 注意：删除 source 后，target position 可能已经发生变化。
  // 所以不能直接使用 rawTarget。
  const tr = editor.state.tr.delete(
    source.pos,
    source.pos + source.node.nodeSize,
  )

  // 通过 transaction mapping 把删除前的位置
  // 映射到删除后的正确位置。
  //
  // before 使用 assoc = -1
  // after  使用 assoc = 1
  const mappedTarget = tr.mapping.map(
    rawTarget,
    side === "before" ? -1 : 1,
  )

  // 将原来的 ProseMirror node 插入新位置。
  //
  // 这里直接复用 source.node，
  // 所以 attrs 中的：
  //
  //   src
  //   alt
  //
  // 都会原样保留。
  //
  // 尤其不会把 blob URL 写进 attrs。
  tr.insert(mappedTarget, source.node)

  // 最终 dispatch transaction。
  //
  // 这是整个拖拽排序真正改变正文 JSON 顺序的地方。
  editor.view.dispatch(
    tr.scrollIntoView(),
  )

  return true
}
