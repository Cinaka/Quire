<script setup lang="ts">
import { onBeforeUnmount, shallowRef, ref, watch } from "vue"
import type { NotebookReadPort } from "@/repo"
import type { Entry } from "@/shared/types"
import NotebookPaper from "./NotebookPaper.vue"
const props = defineProps<{ port: NotebookReadPort; entryIds: readonly string[]; tagNames?: Record<string, string> }>()
const entries = shallowRef<Entry[]>([]), message = ref(""), loading = ref(false)
let seq = 0, stop: (() => void) | undefined, disposed = false
function clear(): number { entries.value = []; return ++seq }
async function reload(): Promise<void> {
  const mine = clear(), port = props.port, ids = [...new Set(props.entryIds)].slice(0, 2)
  loading.value = true
  message.value = ""
  try {
    const result = await Promise.all(ids.map(id => port.readEntry(id)))
    await port.assertCurrent()
    if (mine !== seq || disposed) return
    entries.value = result.filter((entry): entry is Entry => Boolean(entry))
    if (entries.value.length !== ids.length) message.value = "部分日记已删除或不再可读，请重新核对当前结果。"
    else if (!ids.length) message.value = "当前没有可读之简。"
  } catch { if (mine === seq && !disposed) message.value = "读取失败或阅读上下文已失效，请返回列表重新核验。" }
  finally { if (mine === seq && !disposed) loading.value = false }
}
watch(() => [props.port, ...props.entryIds], () => {
  stop?.()
  clear()
  try {
    stop = props.port.subscribe(props.entryIds.slice(0, 2), () => { void reload() }, () => { clear(); loading.value = false; message.value = "本机数据观察失败，已停止显示旧正文。" })
    void reload()
  } catch { loading.value = false; message.value = "阅读上下文已失效，请返回列表重新核验。" }
}, { immediate: true, flush: "sync" })
onBeforeUnmount(() => { disposed = true; clear(); stop?.() })
defineExpose({ reload })
</script>

<template>
  <section :aria-busy="loading" aria-label="简册只读阅读">
    <p v-if="loading" class="notebook-notice" role="status">读取本机日记中……</p>
    <p v-if="message" class="notebook-notice" role="status">{{ message }}</p>
    <div class="notebook-spread">
      <NotebookPaper v-for="entry in entries" :key="entry.id" :entry="entry" :port="port" :tag-names="tagNames" />
    </div>
    <button v-if="message && !loading" type="button" @click="reload">重新读取</button>
  </section>
</template>
