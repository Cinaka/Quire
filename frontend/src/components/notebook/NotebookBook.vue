<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import type { NotebookReadPort } from "@/repo"
import { notebookKeyAllowed, notebookVisibleIds } from "@/shared/notebookNavigation"
import NotebookReadingPane from "./NotebookReadingPane.vue"
const props = defineProps<{
  port: NotebookReadPort; ids: readonly string[]; anchor: string; width: number
  total: number; busy: boolean; hasMore: boolean; tagNames: Record<string, string>
}>()
const emit = defineEmits<{ move: [direction: -1 | 1]; edit: [id: string] }>()
const visible = computed(() => notebookVisibleIds(props.ids, props.anchor, props.width))
const index = computed(() => Math.max(0, props.ids.indexOf(props.anchor)))
const host = ref<HTMLElement | null>(null)
function keydown(event: KeyboardEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null
  const editable = Boolean(target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))
  if (event.defaultPrevented || !notebookKeyAllowed(event, editable, window.getSelection()?.toString() ?? "")) return
  event.preventDefault()
  if (!props.busy && (event.key === "ArrowRight" ? index.value + visible.value.length < props.ids.length || props.hasMore : index.value > 0)) emit("move", event.key === "ArrowRight" ? 1 : -1)
}
// The listener belongs to the focused reader, never the window.
onMounted(() => host.value?.addEventListener("keydown", keydown))
onBeforeUnmount(() => host.value?.removeEventListener("keydown", keydown))
</script>
<template>
  <section ref="host" class="notebook-book" tabindex="0" aria-label="简册阅读，可用左右方向键翻篇">
    <nav class="book-nav" aria-label="翻篇">
      <button type="button" :disabled="busy || index === 0" @click="emit('move', -1)">上一篇</button>
      <span role="status" aria-live="polite">{{ total ? `${index + 1}–${index + visible.length} / ${total} 篇` : '暂无日记' }}</span>
      <button type="button" :disabled="busy || (!hasMore && index + visible.length >= ids.length)" @click="emit('move', 1)">{{ busy ? '检简中…' : '下一篇' }}</button>
    </nav>
    <Transition name="book-turn" mode="out-in">
      <NotebookReadingPane :key="visible.join(':')" :port="port" :entry-ids="visible" :tag-names="tagNames" />
    </Transition>
    <nav class="book-nav" aria-label="明确进入编辑">
      <button v-for="(id, position) in visible" :key="id" type="button" :disabled="busy" @click="emit('edit', id)">编辑{{ visible.length > 1 ? (position ? '右页' : '左页') : '此简' }}</button>
    </nav>
  </section>
</template>
<style scoped>
.notebook-book { outline-offset: 5px; }
.book-nav { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 16px; margin: 16px 0; }
.book-nav button { padding: 8px 14px; border: 1px solid var(--color-ink-faint); border-radius: 4px; background: var(--color-paper); color: var(--color-ink); cursor: pointer; }
.book-nav button:disabled { opacity: .5; cursor: default; }
button:focus-visible, .notebook-book:focus-visible { outline: 2px solid var(--color-bamboo); outline-offset: 4px; }
.book-turn-enter-active, .book-turn-leave-active { transition: opacity 80ms ease, transform 80ms ease; }
.book-turn-enter-from { opacity: 0; transform: translateX(8px); }
.book-turn-leave-to { opacity: 0; transform: translateX(-8px); }
@media (prefers-reduced-motion: reduce) { .book-turn-enter-active, .book-turn-leave-active { transition: none; } .book-turn-enter-from, .book-turn-leave-to { transform: none; } }
</style>
