<template>
  <div class="toolbar">
    <button
      v-for="b in buttons"
      :key="b.key"
      type="button"
      class="tb"
      :class="{ on: b.active() }"
      :title="b.title"
      @click="b.run"
    >
      {{ b.label }}
    </button>

    <span class="gap" />

    <button type="button" class="tb" title="插入图片" @click="pick">图</button>
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      multiple
      hidden
      @change="onPick"
    />
  </div>
</template>

<script setup lang="ts">
import type { Editor } from "@tiptap/vue-3"
import { ref } from "vue"

const props = defineProps<{ editor: Editor }>()
const emit = defineEmits<{ files: [File[]] }>()

const fileInput = ref<HTMLInputElement | null>(null)

function pick(): void {
  fileInput.value?.click()
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (files.length) emit("files", files)
  // 清空 value，否则连续选同一个文件不会触发 change
  input.value = ""
}

const buttons = [
  {
    key: "h1",
    label: "标",
    title: "标题",
    active: () => props.editor.isActive("heading", { level: 2 }),
    run: () => props.editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    key: "bold",
    label: "粗",
    title: "加粗",
    active: () => props.editor.isActive("bold"),
    run: () => props.editor.chain().focus().toggleBold().run(),
  },
  {
    key: "italic",
    label: "斜",
    title: "斜体",
    active: () => props.editor.isActive("italic"),
    run: () => props.editor.chain().focus().toggleItalic().run(),
  },
  {
    key: "bullet",
    label: "点",
    title: "无序列表",
    active: () => props.editor.isActive("bulletList"),
    run: () => props.editor.chain().focus().toggleBulletList().run(),
  },
  {
    key: "ordered",
    label: "序",
    title: "有序列表",
    active: () => props.editor.isActive("orderedList"),
    run: () => props.editor.chain().focus().toggleOrderedList().run(),
  },
  {
    key: "quote",
    label: "引",
    title: "引用",
    active: () => props.editor.isActive("blockquote"),
    run: () => props.editor.chain().focus().toggleBlockquote().run(),
  },
]
</script>

<style scoped>
.toolbar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  background: var(--color-paper);
}

.gap {
  flex: 1;
}

.tb {
  min-width: 32px;
  height: 32px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: var(--font-cn-kai);
  font-size: 16px;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.tb:hover {
  background: var(--color-paper-deep);
}

.tb.on {
  color: #fff;
  background: var(--color-bamboo);
}
</style>
