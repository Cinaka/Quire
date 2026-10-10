<template>
  <section class="workspace" aria-label="预简工作区" :aria-busy="state.loading || state.busy">
    <header><h2>预简 / 待刻</h2><p>内部准备组件；仅本机操作，云端日程尚未开放。</p></header>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <ScheduleEditorPanel v-if="session" :key="state.editorKey" ref="editorRef" :session="session" @saved="workspace.refresh()" @leave="finishEditor" @discarded="finishEditor" />
    <template v-else-if="!state.expired">
      <ScheduleDraftNotice :recovery="state.recovery" :busy="blocked" @resume="workspace.resume()" @discard-request="discardDraft" />
      <form class="filters" @submit.prevent="applyFilters">
        <label>查看<select v-model="filters.view" :disabled="blocked"><option value="pending">待刻</option><option value="converted">已转简</option><option value="deleted">断简预简</option></select></label>
        <label>日期起<input v-model="filters.dateFrom" type="date" :disabled="blocked" /></label>
        <label>日期止<input v-model="filters.dateTo" type="date" :disabled="blocked" /></label>
        <button type="submit" :disabled="blocked">应用筛选</button>
        <button type="button" :disabled="blocked" @click="workspace.refresh()">重新读取</button>
      </form>
      <form class="actions" @submit.prevent="workspace.openNew(newDate)">
        <label>新预简日期<input v-model="newDate" type="date" :disabled="blocked" /></label>
        <button type="submit" :disabled="blocked">留一简</button>
      </form>
      <ScheduleList :items="state.items" :today="state.today" :loading="state.loading" :busy="blocked" :error="state.error" @edit="workspace.edit($event)" @remove-request="workspace.requestAction('remove', $event)" @restore-request="workspace.requestAction('restore', $event)" @convert-request="requestConvert" @inspect-conversion="workspace.inspectConversion($event)" />
      <nav class="actions" aria-label="预简分页">
        <button type="button" :disabled="blocked || state.query.page <= 1" @click="page(-1)">上一页</button>
        <span>第 {{ state.query.page }} / {{ Math.max(1, Math.ceil(state.total / state.query.pageSize)) }} 页 · {{ state.total }} 简</span>
        <button type="button" :disabled="blocked || state.query.page * state.query.pageSize >= state.total" @click="page(1)">下一页</button>
      </nav>
    </template>
    <section v-if="state.prompt" role="dialog" aria-modal="false" aria-label="确认预简操作" class="confirmation">
      <template v-if="state.prompt.kind === 'convert'">
        <h3>刻成日记？</h3>
        <p>{{ state.prompt.source.title || "无题" }} · 原待刻日 {{ state.prompt.source.remindDate }}</p>
        <p>只转换已正式保存的来源；有该来源安全草稿时，请先处理草稿。</p>
        <label><input v-model="dateMode" type="radio" value="original" :disabled="state.busy" />保留原待刻日</label>
        <label v-if="state.prompt.source.remindDate < state.today"><input v-model="dateMode" type="radio" value="other" :disabled="state.busy" />明确选择另一已至之日</label>
        <input v-if="dateMode === 'other'" v-model="targetDate" type="date" :max="state.today" :disabled="state.busy" aria-label="转简目标日期" />
      </template>
      <template v-else><h3>{{ state.prompt.kind === 'remove' ? "移入断简？" : "恢复预简？" }}</h3><p>{{ state.prompt.source.title || "无题" }}。安全草稿不清除，原转换身份不重置。</p></template>
      <div class="actions"><button type="button" :disabled="state.busy" @click="confirm">明确确认</button><button type="button" :disabled="state.busy" @click="workspace.cancelPrompt()">取消</button></div>
    </section>
    <section v-if="state.result" class="confirmation" aria-label="转简结果">
      <p v-if="state.result.entryState === 'deleted'">关联日记已在断简中，不会重新生成；请在日记断简中处理。</p>
      <p v-else-if="state.result.entryState === 'purged'">关联日记已弃去或物理清理，转换身份保留，不会补生日记。</p>
      <p v-else-if="!state.result.canOpen">关联日记格式不受支持，请保留数据并使用兼容版本检查。</p>
      <p v-else>{{ state.result.entryTitle || "无题" }} · {{ state.result.entryDate }} · {{ state.result.created ? "已刻成日记" : "已有转换结果" }}</p>
      <p>{{ state.result.pendingConfirmation ? "仅本地完成，仍待日程云端确认。" : "本机保存有云端确认标记；本次查看未发网络请求。" }}</p>
      <button v-if="state.result.canOpen" type="button" :disabled="blocked" @click="openEntry">打开关联日记</button>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue"
import { createScheduleWorkspace, type ScheduleWorkspacePort, type ScheduleWorkspaceQuery } from "@/shared/scheduleWorkspace"
import type { ScheduleEditorSession } from "@/shared/scheduleEditor"
import { addLocalDays } from "@/shared/time"
import type { LocalDate } from "@/shared/types"
import ScheduleDraftNotice from "./ScheduleDraftNotice.vue"
import ScheduleEditorPanel from "./ScheduleEditorPanel.vue"
import ScheduleList from "./ScheduleList.vue"

// 只接受内部显式注入；未被路由/底栏/DEV引用。contextKey由未来宿主绑定账号与恢复代际。
const props = defineProps<{ port: ScheduleWorkspacePort; contextKey: string }>()
const emit = defineEmits<{ "open-entry": [string]; "context-expired": [] }>()
const workspace = createScheduleWorkspace(props.port)
const state = ref(workspace.inspect())
const session = shallowRef<ScheduleEditorSession | null>(null)
const editorRef = ref<InstanceType<typeof ScheduleEditorPanel> | null>(null)
const filters = reactive({ view: "pending" as ScheduleWorkspaceQuery["view"], dateFrom: "", dateTo: "" })
const newDate = ref(addLocalDays(state.value.today, 1))
const dateMode = ref<"original" | "other">("original")
const targetDate = ref("")
const blocked = computed(() => state.value.busy || state.value.loading || Boolean(state.value.prompt) || state.value.expired)
const unsubscribe = workspace.subscribe(() => { state.value = workspace.inspect(); session.value = workspace.editorSession() })
function applyFilters(): void {
  void workspace.setQuery({ view: filters.view, dateFrom: filters.dateFrom || undefined, dateTo: filters.dateTo || undefined, page: 1, pageSize: state.value.query.pageSize })
}
function page(delta: number): void { void workspace.setQuery({ ...state.value.query, page: state.value.query.page + delta }) }
function requestConvert(request: { id: string; expectedClientUpdatedAt: string; remindDate: LocalDate }): void {
  dateMode.value = "original"; targetDate.value = ""
  workspace.requestAction("convert", request.id, request.expectedClientUpdatedAt, request.remindDate)
}
async function confirm(): Promise<void> {
  await workspace.confirm(state.value.prompt?.kind === "convert" && dateMode.value === "other" ? targetDate.value : undefined)
}
async function discardDraft(): Promise<void> {
  if (window.confirm("明确弃去当前安全草稿？已保存预简不会删除。")) await workspace.discardRecoveryConfirmed()
}
async function finishEditor(): Promise<void> { await workspace.editorFinished() }
async function openEntry(): Promise<void> { const id = await workspace.openResultEntry(); if (id) emit("open-entry", id) }
async function prepareLeave(): Promise<boolean> {
  if (session.value) {
    if (!editorRef.value || !await editorRef.value.prepareLeave()) return false
    await workspace.editorFinished()
  }
  return workspace.canLeave()
}
function refreshOnFocus(): void { workspace.tick(); void workspace.refresh() }
function visibility(): void { if (document.visibilityState === "visible") refreshOnFocus() }
let timer: number | undefined
onMounted(() => {
  void workspace.initialize()
  timer = window.setInterval(() => workspace.tick(), 60_000)
  window.addEventListener("focus", refreshOnFocus)
  document.addEventListener("visibilitychange", visibility)
})
watch(() => props.contextKey, () => { workspace.invalidate(); emit("context-expired") }, { flush: "sync" })
function canCompose(): boolean {
  const current = workspace.inspect()
  return workspace.canLeave() && !current.loading && !current.prompt && !current.expired
}
defineExpose({ prepareLeave, refresh: workspace.refresh, canCompose })
onBeforeUnmount(() => {
  if (timer !== undefined) window.clearInterval(timer)
  window.removeEventListener("focus", refreshOnFocus)
  document.removeEventListener("visibilitychange", visibility)
  unsubscribe(); workspace.dispose()
})
</script>

<style scoped>
.workspace { max-width: 720px; margin: 0 auto; padding: 16px; color: var(--color-ink); }
header h2 { font-family: var(--font-cn-serif); }
header p { font-size: 13px; color: var(--color-ink-faint); }
.filters, .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin: 14px 0; }
.filters label { display: grid; gap: 4px; }
input, select { padding: 5px; border: 1px solid var(--color-bamboo-soft); background: var(--color-paper); color: var(--color-ink); }
.confirmation { padding: 16px; margin: 16px 0; border: 1px solid var(--color-bamboo-soft); border-radius: 8px; }
.confirmation label { display: block; margin: 8px 0; }
button { color: var(--color-bamboo); cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
[role="alert"] { color: var(--color-ji); }
</style>
