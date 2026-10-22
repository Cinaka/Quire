<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { createNotebookImageLoader } from "@/capabilities/notebookImageLoader"
import type { NotebookReadPort } from "@/repo"
import type { Entry } from "@/shared/types"
const props = defineProps<{ entry: Entry; port: NotebookReadPort; mediaId: string; alt: string; title: string }>()
const target = ref<HTMLElement | null>(null), url = ref(""), status = ref("本机图片尚未读取")
const loader = createNotebookImageLoader(state => { url.value = state.url; status.value = state.message })
let visible = false, observer: IntersectionObserver | undefined, stop: (() => void) | undefined
function load(): void { if (visible) void loader.load(props.port, props.entry, props.mediaId); else loader.clear() }
function refresh(): void {
  stop?.()
  stop = undefined
  loader.clear()
  if (!visible) return
  try {
    stop = props.port.subscribeMedia(props.entry.id, props.mediaId, load, () => loader.clear("本机图片观察失败"))
    load()
  } catch { loader.clear("阅读上下文已失效") }
}
watch(() => [props.entry, props.mediaId, props.port] as const, refresh, { flush: "sync" })
onMounted(() => {
  if (typeof IntersectionObserver !== "function") { visible = true; refresh(); return }
  observer = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting)
    refresh()
  }, { rootMargin: "160px" })
  if (target.value) observer.observe(target.value)
})
onBeforeUnmount(() => { observer?.disconnect(); stop?.(); loader.close() })
</script>

<template>
  <figure ref="target" class="notebook-image">
    <img v-if="url" :src="url" :alt="alt" :title="title || undefined" decoding="async" @error="loader.clear('本机图片无法解码')" />
    <figcaption v-if="status" role="status">{{ status }}</figcaption>
  </figure>
</template>
