import { mergeAttributes } from "@tiptap/core"
import Image from "@tiptap/extension-image"
import { VueNodeViewRenderer } from "@tiptap/vue-3"

import LocalImageView from "@/editor/LocalImageView.vue"

/**
 * 本地图片节点。
 *
 * 与官方 Image 的唯一区别是渲染层：src 里存的是 local://media/{id}，
 * 浏览器无法直接加载这种协议，所以必须用 NodeView 自己解析。
 *
 * 注意没有改 name，仍然是 "image"——保证粘贴 HTML / 导入 Markdown 时
 * 图片能落到这个节点上，而不是被当成未知节点丢弃。
 */
export const LocalImage = Image.extend({
  // 图片作为独立块，不参与行内混排。日记场景没有图文绕排的需求，
  // 而 inline 图片会让光标定位和删除行为变得难以预测。
  inline: false,
  group: "block",
  draggable: true,

  addNodeView() {
    return VueNodeViewRenderer(LocalImageView)
  },

  /**
   * 把 src 改写成 data-src，不让 local:// 落到真正的 src 属性上。
   *
   * 不改的后果：ProseMirror 构建文档视图时会先按这份规范生成一个
   * <img src="local://media/...">，浏览器看到 src 就发请求，而 local://
   * 不是它认识的协议，于是每张图报一次 ERR_UNKNOWN_URL_SCHEME。
   * 图片仍能正常显示（NodeView 随后接管、用 blob URL 渲染），
   * 但控制台会被刷屏，真正的报错容易被埋掉。
   *
   * 改成 data-src 是安全的：持久化走的是 Tiptap JSON（attrs.src 不变），
   * 这里只影响 HTML 序列化。应用内部复制粘贴也不受影响——ProseMirror
   * 会把完整 JSON 放在剪贴板的 data-pm-slice 里，不靠 img 的 src 恢复。
   */
  renderHTML({ HTMLAttributes }) {
    const { src, ...rest } = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
    return ["img", { ...rest, "data-src": src }]
  },
})
