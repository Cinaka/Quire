<template>
  <section class="repair-panel" aria-label="证据文件补齐缺失图片" :aria-busy="state.busy">
    <h3>从证据文件补齐缺失图片</h3>
    <p>内部准备面板。仅补齐明确选择的缺失图片，不恢复日记或标签、不解除转简保护，也不自动同步。</p>
    <p class="identity">固定来源：{{ state.sourceId }}</p>
    <p>文件可能含私人日记与图片，请仅选择你信任的青简资源证据JSON文件。</p>
    <label>本机证据文件<input ref="fileInput" type="file" accept="application/json,.json" :disabled="locked" @change="chooseFile" /></label>
    <p v-if="state.fileInfo">已选：{{ state.fileInfo.name }} · {{ state.fileInfo.size }} 字节</p>
    <fieldset :disabled="locked">
      <legend>明确选择需补齐的图片（不默认全选）</legend>
      <label v-for="media in mediaOptions" :key="media.id" class="media-choice">
        <input type="checkbox" :checked="state.selectedIds.includes(media.id)" @change="selectMedia(media.id, $event)" />
        {{ media.label }} · {{ media.id }}
      </label>
    </fieldset>
    <button type="button" :disabled="locked || state.busy || !state.fileInfo || !state.selectedIds.length" @click="panel.prepare()">准备补齐计划（不写入）</button>
    <div v-if="state.preview" class="preview">
      <h4>待确认计划</h4>
      <p>文件格式：{{ state.preview.fileFormat }}</p>
      <ul>
        <li v-for="step in state.preview.steps" :key="step.mediaId">
          {{ step.mediaId }}：{{ step.createRow ? '新建缺失媒体行；' : '保留已有媒体行；' }}
          {{ step.fillOriginal ? '补原图；' : '保留原图；' }}{{ step.fillThumbnail ? '补缩略图' : '保留缩略图状态' }}
        </li>
      </ul>
      <p v-if="state.preview.unusedFileMediaIds.length">文件中未选择的图片不会导入：{{ state.preview.unusedFileMediaIds.join('、') }}</p>
      <label><input type="checkbox" :checked="state.confirmed" :disabled="locked || state.busy" @change="confirmPlan" />
        我确认仅补齐上述缺失图片；日记、标签、首次意图和冲突保护保持不变，不重放文件历史取舍。
      </label>
      <button type="button" :disabled="locked || state.busy || !state.confirmed" @click="panel.apply()">明确确认并补齐本机图片</button>
    </div>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p role="status" aria-live="polite">{{ state.notice }}</p>
    <p v-if="state.expired" role="alert">账号、来源或宿主上下文已变化，请关闭并重新打开核对。</p>
    <div class="actions">
      <button type="button" :disabled="locked" @click="panel.cancel()">停止后续步骤</button>
      <button type="button" :disabled="state.closed" @click="close">停止并关闭（不撤销已提交）</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { createScheduleResourceRepairPanel } from "@/shared/scheduleResourceRepairPanel"
import type { ResourceRepairPanelPort } from "@/shared/scheduleResourceRepairPanel"

// 每个固定账号/DB代际/来源会话须使用独占port，并以固定会话key挂载；不提供默认repo或网络。
// 本组件未挂载正式路由。上下文变化只使旧实例失效，父宿主须明确重新打开新实例。
const props = defineProps<{ port: ResourceRepairPanelPort; sourceId: string; contextKey: string; mediaOptions: { id: string; label: string }[] }>()
const emit = defineEmits<{ close: [] }>()
const panel = createScheduleResourceRepairPanel(props.port, props.sourceId, props.mediaOptions.map(row => row.id))
const state = ref(panel.inspect())
const fileInput = ref<HTMLInputElement | null>(null)
const unsubscribe = panel.subscribe(() => { state.value = panel.inspect() })
const locked = computed(() => state.value.expired || state.value.closed)
function chooseFile(event: Event): void {
  const input = event.target as HTMLInputElement, files = input.files
  panel.setFile(files?.length === 1 ? files.item(0) : null)
  input.value = "" // Allow explicitly choosing the same file again; the controller owns its File reference.
}
function selectMedia(id: string, event: Event): void {
  const selected = state.value.selectedIds.filter(value => value !== id)
  if ((event.target as HTMLInputElement).checked) selected.push(id)
  panel.select(selected)
}
function confirmPlan(event: Event): void { panel.confirm((event.target as HTMLInputElement).checked) }
function close(): void { panel.close(); emit("close") }
watch(() => [props.contextKey, props.sourceId, props.port, JSON.stringify(props.mediaOptions)], () => {
  panel.expire(); if (fileInput.value) fileInput.value.value = ""
}, { flush: "sync" })
onBeforeUnmount(() => { unsubscribe(); panel.dispose() })
</script>

<style scoped>
.repair-panel { display: grid; gap: 12px; padding: 16px; background: var(--color-paper); color: var(--color-ink); border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
.repair-panel p { margin: 0; overflow-wrap: anywhere; }
.identity { color: var(--color-ink-soft); }
fieldset, .preview { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
.media-choice { display: block; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; }
button { padding: 8px 12px; border: 1px solid var(--color-bamboo); border-radius: 6px; color: var(--color-ink); background: var(--color-bamboo-soft); cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
[role="alert"] { color: var(--color-ji); }
</style>
