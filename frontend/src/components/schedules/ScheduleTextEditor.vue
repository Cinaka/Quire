<template>
  <div>
    <p class="hint">预简仅支持文字与基础排版；图片、标签、心情和天气请在转简后添加。</p>
    <p v-if="warning" role="alert" class="warning">{{ warning }}</p>
    <div v-if="editor && !initialError" class="toolbar" aria-label="预简文字排版">
      <button v-for="button in buttons" :key="button.label" type="button" :disabled="disabled" :aria-pressed="button.active()" @click="button.run()">{{ button.label }}</button>
    </div>
    <EditorContent v-if="!initialError" :editor="editor" />
  </div>
</template>

<script setup lang="ts">
import type { Content } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/vue-3"
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { buildScheduleExtensions } from "@/editor/scheduleSchema"
import { assertScheduleContent } from "@/shared/schedules"
import { CONTENT_SCHEMA_VERSION, type EntryContent, type TiptapDoc } from "@/shared/types"

// initialContent仅用于挂载；父组件必须按编辑会话key重建，不能用新来源静默替换正文。
const props = defineProps<{ initialContent: EntryContent | null; disabled?: boolean }>()
const emit = defineEmits<{ change: [EntryContent]; invalid: [string] }>()
let initialError = ""
try { assertScheduleContent(props.initialContent) } catch (error) { initialError = String(error) }
const warning = ref(initialError)
const editor = useEditor({
  content: (initialError ? "" : props.initialContent?.doc ?? "") as Content,
  extensions: buildScheduleExtensions(), editable: !props.disabled && !initialError,
  editorProps: {
    attributes: { class: "prose-schedule", "aria-label": "预简正文" },
    handlePaste(_view, event) {
      const data = event.clipboardData
      if (data?.files.length || /<img\b|data:image\//i.test(data?.getData("text/html") ?? "")) {
        warning.value = "预简不接收图片或文件；请在转简后添加。"
        return true
      }
      return false
    },
    handleDrop(_view, event) {
      if (event.dataTransfer?.files.length || /<img\b|data:image\//i.test(event.dataTransfer?.getData("text/html") ?? "")) {
        warning.value = "预简不接收图片或文件；请在转简后添加。"
        return true
      }
      return false
    },
  },
  onUpdate({ editor: current }) {
    const content: EntryContent = { schemaVersion: CONTENT_SCHEMA_VERSION, doc: current.getJSON() as unknown as TiptapDoc }
    try { assertScheduleContent(content); emit("change", content) } catch (error) {
      warning.value = String(error)
      emit("invalid", warning.value)
    }
  },
})
const buttons = [
  { label: "标题", active: () => editor.value?.isActive("heading", { level: 2 }) ?? false, run: () => editor.value?.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: "加粗", active: () => editor.value?.isActive("bold") ?? false, run: () => editor.value?.chain().focus().toggleBold().run() },
  { label: "斜体", active: () => editor.value?.isActive("italic") ?? false, run: () => editor.value?.chain().focus().toggleItalic().run() },
  { label: "无序列表", active: () => editor.value?.isActive("bulletList") ?? false, run: () => editor.value?.chain().focus().toggleBulletList().run() },
  { label: "有序列表", active: () => editor.value?.isActive("orderedList") ?? false, run: () => editor.value?.chain().focus().toggleOrderedList().run() },
  { label: "引用", active: () => editor.value?.isActive("blockquote") ?? false, run: () => editor.value?.chain().focus().toggleBlockquote().run() },
]
watch(() => props.disabled, value => editor.value?.setEditable(!value && !initialError))
onMounted(() => { if (initialError) emit("invalid", initialError) })
onBeforeUnmount(() => editor.value?.destroy())
</script>

<style scoped>
.hint { font-size: 13px; color: var(--color-ink-faint); }
.warning { color: var(--color-ji); }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0; }
button { padding: 5px 8px; color: var(--color-ink-soft); border-radius: 5px; }
button[aria-pressed="true"] { background: var(--color-bamboo); color: white; }
:deep(.prose-schedule) { min-height: 30vh; outline: none; line-height: 1.9; color: var(--color-ink); overflow-wrap: anywhere; }
:deep(.prose-schedule blockquote) { border-left: 3px solid var(--color-bamboo-soft); padding-left: 12px; }
:deep(.prose-schedule ul), :deep(.prose-schedule ol) { padding-left: 24px; }
</style>
