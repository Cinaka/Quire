<template>
  <div class="wrap">
    <EditorToolbar v-if="editor" :editor="editor" @files="onFiles" />

    <p v-if="warning" class="warning">{{ warning }}</p>

    <EditorContent :editor="editor" class="content" @drop.prevent="onDrop" />
  </div>
</template>

<script setup lang="ts">
import type { Content } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/vue-3"
import { onBeforeUnmount, ref } from "vue"

import EditorToolbar from "@/components/EditorToolbar.vue"
import { insertImages } from "@/editor/media"
import { buildExtensions } from "@/editor/schema"
import type { TiptapDoc } from "@/shared/types"

const props = defineProps<{ doc: TiptapDoc | null }>()
const emit = defineEmits<{ change: [TiptapDoc] }>()

const warning = ref("")

const editor = useEditor({
  // 必须转一次类型。TiptapDoc 里 content 是 unknown[]（P1-1 故意定得宽松，
  // 避免 shared 层依赖 Tiptap 的类型），而 Tiptap 要的是 JSONContent[]，
  // 两者不能直接赋值。转换只发生在这一处边界上。
  content: (props.doc ?? "") as Content,
  extensions: buildExtensions("今日之事，可入青简"),
  editorProps: {
    attributes: { class: "prose-diary" },

    // 粘贴图片走这里。返回 true 表示我们自己处理了，阻止 Tiptap 的默认行为
    // ——默认行为会把图片转成 base64 塞进文档。
    handlePaste(_view, event) {
      const files = Array.from(event.clipboardData?.files ?? [])
      if (!files.length) return false
      void onFiles(files)
      return true
    },
  },
  onUpdate({ editor: e }) {
    emit("change", e.getJSON() as unknown as TiptapDoc)
  },
})

async function onFiles(files: File[]): Promise<void> {
  if (!editor.value) return

  const { rejected } = await insertImages(editor.value, files)
  warning.value = rejected.join("；")

  if (rejected.length) {
    window.setTimeout(() => {
      warning.value = ""
    }, 4000)
  }
}

function onDrop(e: DragEvent): void {
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) void onFiles(files)
}

/** 父组件保存前调用，确保拿到的是最新内容 */
function snapshot(): TiptapDoc | null {
  return (editor.value?.getJSON() as unknown as TiptapDoc) ?? null
}

defineExpose({ snapshot })

onBeforeUnmount(() => {
  editor.value?.destroy()
})
</script>

<style scoped>
.warning {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--color-ji);
}
</style>

<style>
/* 非 scoped：ProseMirror 的 DOM 由编辑器动态生成，scoped 的属性选择器加不上去 */
.prose-diary {
  min-height: 40vh;
  outline: none;
  font-size: 17px;
  line-height: 1.9;
  color: var(--color-ink);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.prose-diary p {
  margin: 0 0 12px;
}

.prose-diary h1,
.prose-diary h2,
.prose-diary h3 {
  margin: 24px 0 10px;
  font-family: var(--font-cn-serif);
  line-height: 1.4;
}

.prose-diary blockquote {
  margin: 16px 0;
  padding-left: 14px;
  border-left: 3px solid var(--color-bamboo-soft);
  color: var(--color-ink-soft);
}

.prose-diary ul,
.prose-diary ol {
  padding-left: 22px;
}

.prose-diary code {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--color-paper-deep);
  font-size: 15px;
}

/* Placeholder 扩展注入的类名，只在文档为空时出现 */
.prose-diary p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
  color: var(--color-ink-faint);
}

.prose-diary > * {
  flex: 0 0 100%;
  min-width: 0;
}

.prose-diary > .local-image {
  flex: 0 0 calc((100% - 16px) / 3);
  margin: 0;
  aspect-ratio: 1;
}
</style>
