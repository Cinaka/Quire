<template>
  <section aria-label="编辑预简" :aria-busy="state.busy">
    <p v-if="state.sourceStatus === 'conflict' || state.sourceStatus === 'sourceUnavailable'" role="alert">{{ draftRecoveryMessage(state.sourceStatus) }}</p>
    <label class="field">待刻日期<input v-model="body.remindDate" type="date" :disabled="locked" @input="changed" /></label>
    <label class="field">标题<input v-model="body.title" type="text" maxlength="255" :disabled="locked" @input="changed" /></label>
    <ScheduleTextEditor :initial-content="initialContent" :disabled="locked" @change="contentChanged" @invalid="editorError = $event" />
    <p v-if="state.error || editorError" role="alert">{{ state.error || editorError }}</p>
    <p role="status" aria-live="polite">{{ state.notice }}</p>
    <div class="actions">
      <button type="button" :disabled="locked || Boolean(editorError) || state.sourceStatus === 'conflict' || state.sourceStatus === 'sourceUnavailable'" @click="save">保存预简</button>
      <button v-if="state.error" type="button" :disabled="locked || Boolean(editorError)" @click="changed">重试保存安全草稿</button>
      <button type="button" :disabled="locked" @click="leave">保留草稿并返回</button>
      <button type="button" :disabled="locked" @click="discard">弃去安全草稿…</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"
import { createScheduleEditorPanel } from "@/shared/scheduleEditorPanel"
import type { ScheduleEditorSession } from "@/shared/scheduleEditor"
import { draftRecoveryMessage } from "@/shared/schedulePresentation"
import type { EntryContent } from "@/shared/types"
import ScheduleTextEditor from "./ScheduleTextEditor.vue"

// 此组件不可复用为另一会话：父组件须以打开时固定的会话身份为key（不随保存ID变化），切换前await prepareLeave。
const props = defineProps<{ session: ScheduleEditorSession }>()
const emit = defineEmits<{ saved: []; leave: []; discarded: [] }>()
const panel = createScheduleEditorPanel(props.session)
const initialState = panel.inspect()
const state = ref(initialState)
const body = ref(structuredClone(initialState.body))
const initialContent = structuredClone(initialState.body.content)
const editorError = ref("")
const locked = computed(() => state.value.busy || state.value.closed)
const unsubscribe = panel.subscribe(() => { state.value = panel.inspect() })
function changed(): void { void panel.change({ ...body.value }) }
function contentChanged(content: EntryContent): void { body.value.content = content; editorError.value = ""; changed() }
async function save(): Promise<void> { if (await panel.submit()) emit("saved") }
async function prepareLeave(): Promise<boolean> { return !editorError.value && await panel.prepareLeave() }
async function leave(): Promise<void> { if (await prepareLeave()) emit("leave") }
async function discard(): Promise<void> {
  if (!window.confirm("只弃去安全草稿，已保存预简不删除。确定弃去？")) return
  if (await panel.discardConfirmed()) emit("discarded")
}
defineExpose({ prepareLeave })
onBeforeUnmount(() => { unsubscribe(); panel.dispose() })
</script>

<style scoped>
.field { display: grid; gap: 6px; margin: 12px 0; color: var(--color-ink-soft); }
input { padding: 8px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; background: var(--color-paper); color: var(--color-ink); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
button { color: var(--color-bamboo); cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
[role="alert"] { color: var(--color-ji); }
[role="status"] { color: var(--color-ink-faint); font-size: 13px; }
</style>
