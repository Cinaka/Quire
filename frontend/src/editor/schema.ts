import Placeholder from "@tiptap/extension-placeholder"
import StarterKit from "@tiptap/starter-kit"

import { LocalImage } from "./extensions/LocalImage"

/**
 * 编辑器扩展清单。
 *
 * 这是内容格式的实际定义——schemaVersion 变不变，取决于这个列表变不变。
 * 加了新节点类型（比如待办、分割线）就要考虑升 CONTENT_SCHEMA_VERSION，
 * 因为老版本的渲染器碰到不认识的节点会直接丢掉内容。
 */
export function buildExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // 日记不需要横向分割线和硬换行的复杂行为，关掉减少 schema 面积
      horizontalRule: false,
    }),

    // allowBase64 必须关。开着的话粘贴图片会把 base64 直接塞进 JSON，
    // 一张手机照片能让单篇日记的 content 膨胀到几 MB，IndexedDB 很快就撑爆。
    LocalImage.configure({ allowBase64: false }),

    Placeholder.configure({ placeholder }),
  ]
}
