<template>
  <section aria-label="受保护的日记编辑" :aria-busy="state.editor.busy" @compositionstart.capture="compositionStarted" @compositionend.capture="compositionEnded">
    <h2>再刻一简</h2>
    <p role="status" aria-live="polite">{{ state.editor.notice }}</p>
    <p class="hint">未保存修改仅在本会话内，没有自动安全草稿；刷新或关闭可能丢失。图片上传与标签编辑尚未接线。</p>
    <label class="field">日记日期<input :value="state.editor.body.entryDate" type="date" :disabled="locked" @input="changeField('entryDate', $event)" /></label>
    <label class="field">标题<input :value="state.editor.body.title" type="text" :disabled="locked" @input="changeField('title', $event)" /></label>
    <div class="metadata">
      <label class="field">心情<input :value="state.editor.body.mood ?? ''" type="text" :disabled="locked" @input="changeField('mood', $event)" /></label>
      <label class="field">天气<input :value="state.editor.body.weather ?? ''" type="text" :disabled="locked" @input="changeField('weather', $event)" /></label>
    </div>
    <p>标签：{{ state.editor.body.tagIds.join('、') || '无' }}（原值保留）</p>
    <ScheduleTextEditor v-if="state.bodyMode === 'text'" :initial-content="initialContent" :disabled="locked" diary-mode @change="panel.changeContent($event)" @invalid="panel.editorInvalid($event)" />
    <section v-else aria-label="原正文只读保留">
      <p class="hint">原正文含图片或当前文本面板不能保真的字段，本批只读保留；修改标题等不会重写正文。</p>
      <pre>{{ retainedText || '无可显示文字；完整正文结构在下方副本中保留。' }}</pre>
    </section>
    <p v-if="state.editor.error || state.editorError" role="alert">{{ state.editor.error || state.editorError }}</p>
    <div class="actions">
      <button type="button" :disabled="locked || state.composing || Boolean(state.editorError)" @click="save">保存日记</button>
      <button type="button" :disabled="state.editor.busy || state.composing" @click="leave">返回预简</button>
      <button type="button" :disabled="state.editor.busy || state.composing || state.editor.closed" @click="panel.requestDiscard()">弃去本次未保存修改…</button>
      <button type="button" @click="showCopy = !showCopy">{{ showCopy ? '收起输入副本' : '查看输入副本' }}</button>
    </div>
    <section v-if="state.leavePrompt || state.discardPrompt" role="dialog" aria-modal="false" aria-label="处理未保存修改" class="confirmation">
      <template v-if="state.discardPrompt">
        <p>确定弃去本次未保存修改并返回？已存日记、预简与安全草稿都不会删除。</p>
        <button type="button" :disabled="state.editor.busy || state.composing" @click="discard">明确弃去并返回</button>
      </template>
      <template v-else>
        <p>还有未保存或未确认的编辑器输入。请明确保存，或确认弃去；不会自动丢弃。</p>
        <button type="button" :disabled="locked || state.composing || Boolean(state.editorError)" @click="saveAndLeave">保存并返回</button>
        <button type="button" :disabled="state.editor.busy || state.composing" @click="panel.requestDiscard()">选择弃去…</button>
      </template>
      <button type="button" :disabled="state.editor.busy" @click="panel.cancelPrompt()">取消返回，保留输入</button>
    </section>
    <p v-if="showCopy && state.editorError" role="alert">副本仅含最后可接受的会话快照，不包含尚未确认的编辑器输入；请另外复制编辑器中的可见正文。</p>
    <label v-if="showCopy" class="field">当前会话 JSON 副本（不是包含图片字节的防蠹备份）<textarea :value="copyText" readonly rows="12" /></label>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue"
import { createScheduleDiaryPanel } from "@/shared/scheduleDiaryPanel"
import type { ScheduleDiaryEditorSession } from "@/shared/scheduleDiaryEditor"
import { toPlainText } from "@/shared/text"
import ScheduleTextEditor from "./ScheduleTextEditor.vue"

// 父宿主以固定会话key重建；保存修订变化不能重挂载、替换正文或重置光标。
const props = defineProps<{ session: ScheduleDiaryEditorSession }>()
const emit = defineEmits<{ saved: []; leave: [] }>()
const panel = createScheduleDiaryPanel(props.session)
const initialState = panel.inspect()
const initialContent = structuredClone(initialState.editor.body.content)
const state = ref(initialState)
const showCopy = ref(false)
const locked = computed(() => state.value.editor.busy || state.value.editor.closed || state.value.editor.expired)
const retainedText = computed(() => { try { return toPlainText(state.value.editor.body.content) } catch { return "当前正文不能安全显示，请保留页面并检查原值。" } })
const copyText = computed(() => { void state.value; return panel.inputForCopy() })
const unsubscribe = panel.subscribe(() => { state.value = panel.inspect() })
function changeField(field: "entryDate" | "title" | "mood" | "weather", event: Event): void {
  const value = (event.target as HTMLInputElement).value
  if (field === "entryDate") panel.changeMetadata({ entryDate: value })
  else if (field === "title") panel.changeMetadata({ title: value })
  else if (field === "mood") panel.changeMetadata({ mood: value || null })
  else panel.changeMetadata({ weather: value || null })
}
let compositionGeneration = 0
function compositionStarted(): void { compositionGeneration += 1; panel.setComposing(true) }
async function compositionEnded(): Promise<void> { const version = compositionGeneration; await nextTick(); if (version === compositionGeneration) panel.setComposing(false) }
async function save(): Promise<void> { if (await panel.save()) emit("saved") }
async function prepareLeave(): Promise<boolean> { return panel.prepareLeave() }
async function leave(): Promise<void> { if (await prepareLeave()) emit("leave") }
async function saveAndLeave(): Promise<void> { if (await panel.saveAndLeave()) { emit("saved"); emit("leave") } }
function discard(): void { if (panel.confirmDiscard()) emit("leave") }
function needsLeaveConfirmation(): boolean { return panel.needsLeaveConfirmation() }
defineExpose({ prepareLeave, needsLeaveConfirmation })
onBeforeUnmount(() => { compositionGeneration += 1; unsubscribe(); panel.dispose() })
</script>

<style scoped>
section { color: var(--color-ink); }
h2 { font-family: var(--font-cn-serif); }
.field { display: grid; gap: 6px; margin: 12px 0; }
.metadata, .actions { display: flex; flex-wrap: wrap; gap: 12px; }
input, textarea { padding: 8px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; background: var(--color-paper); color: var(--color-ink); }
textarea, pre { overflow-wrap: anywhere; white-space: pre-wrap; }
button { color: var(--color-bamboo); cursor: pointer; margin: 6px; }
button:disabled { opacity: .5; cursor: not-allowed; }
.hint, [role="status"] { color: var(--color-ink-faint); font-size: 13px; }
[role="alert"] { color: var(--color-ji); }
.confirmation { border: 1px solid var(--color-bamboo-soft); border-radius: 6px; padding: 12px; margin: 12px 0; }
</style>
