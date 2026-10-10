<template>
  <section aria-label="预简隔离宿主">
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="bridgeError" role="alert">{{ bridgeError }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <template v-if="state.ready && !state.expired">
      <fieldset v-show="!diarySession" :disabled="state.busy" class="work-area">
        <section class="first-save" aria-label="未关联日记草稿首次保存">
          <p>内部首存桥，仅处理明确读取的未关联日记安全草稿；不自动修改既有日记或预简。</p>
          <p v-if="state.firstSaveError" role="alert">{{ state.firstSaveError }}</p>
          <button type="button" :disabled="state.busy" @click="host.refreshDraft()">明确读取原日记安全草稿</button>
          <template v-if="state.frame">
            <p>{{ state.frame.draft.title || "无题" }} · 原草稿日 {{ state.frame.draft.entryDate }}</p>
            <label>首存日<input v-model="selectedDate" type="date" :disabled="state.busy" @input="host.preview(selectedDate)" /></label>
            <button type="button" :disabled="state.busy" @click="host.preview(selectedDate)">核对分流</button>
            <p v-if="state.plan">{{ state.plan.date }}：{{ state.plan.resource === "schedule" ? "保存为预简（仅文本）" : "保存为日记" }}。原稿与目标写入在同一事务处理。</p>
            <button v-if="state.plan" type="button" :disabled="state.busy" @click="firstSave">明确确认首次保存</button>
          </template>
        </section>
        <ScheduleWorkspace v-if="workspacePort" ref="workspaceRef" :port="workspacePort" :context-key="host.contextKey()" @open-entry="openTarget" @context-expired="host.invalidate()" />
      </fieldset>
    </template>
    <!-- 账号/恢复失效不卸载未保存文字：面板锁写，但保留副本与明确弃去。 -->
    <ScheduleDiaryPanel v-if="diarySession" :key="diaryKey" ref="diaryRef" class="first-save" :session="diarySession" @saved="refreshWorkspace" @leave="finishDiary" />
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue"
import { createScheduleHost } from "@/shared/scheduleHost"
import type { ScheduleHostPort } from "@/shared/scheduleHostTypes"
import type { ScheduleDiaryEditorSession } from "@/shared/scheduleDiaryEditor"
import type { EntryUpdateDto } from "@/shared/types"
import type { ScheduleWorkspacePort } from "@/shared/scheduleWorkspace"
import ScheduleWorkspace from "./ScheduleWorkspace.vue"
import ScheduleDiaryPanel from "./ScheduleDiaryPanel.vue"

// 显式注入的隐藏宿主，未进入App/router/DEV；固定会话key不随保存修订变化。
const props = defineProps<{ port: ScheduleHostPort }>()
const host = createScheduleHost(props.port)
const state = ref(host.inspect())
const selectedDate = ref("")
const bridgeError = ref("")
const workspacePort = shallowRef<ScheduleWorkspacePort | null>(null)
const workspaceRef = ref<InstanceType<typeof ScheduleWorkspace> | null>(null)
const diarySession = shallowRef<ScheduleDiaryEditorSession | null>(null)
const diaryRef = ref<InstanceType<typeof ScheduleDiaryPanel> | null>(null)
const diaryKey = ref(0)
const unsubscribe = host.subscribe(() => {
  state.value = host.inspect(); workspacePort.value = host.workspacePort()
  const next = host.diaryEditor()
  if (next && !next.inspect().closed) {
    if (diarySession.value !== next) diaryKey.value += 1
    diarySession.value = next
  } else diarySession.value = null
})
async function firstSave(): Promise<void> {
  if (diarySession.value || (workspaceRef.value && !workspaceRef.value.canCompose())) { bridgeError.value = "请先处理当前工作区编辑或确认，再执行首存"; return }
  bridgeError.value = ""
  if (await host.confirmFirstSave()) await workspaceRef.value?.refresh()
}
async function openTarget(id: string): Promise<void> {
  if (state.value.busy || diarySession.value || !workspaceRef.value?.canCompose()) { bridgeError.value = "请先处理当前编辑或确认，再打开关联日记"; return }
  bridgeError.value = ""
  await host.openTargetEditor(id)
}
async function refreshWorkspace(): Promise<void> { if (state.value.ready && !state.value.expired) await workspaceRef.value?.refresh() }
async function finishDiary(): Promise<void> {
  if (!await host.prepareTargetLeave()) return
  diarySession.value = null
  await refreshWorkspace()
}
async function prepareLeave(): Promise<boolean> {
  if (state.value.busy) return false
  if (diarySession.value) {
    if (!diaryRef.value || !await diaryRef.value.prepareLeave()) return false
    if (!await host.prepareTargetLeave()) return false
    diarySession.value = null
  }
  return workspaceRef.value ? workspaceRef.value.prepareLeave() : true
}
async function saveTarget(update: EntryUpdateDto): Promise<boolean> { return host.saveTarget(update) }
function beforeUnload(event: BeforeUnloadEvent): void {
  const current = diarySession.value?.inspect()
  if (state.value.busy || current?.dirty || current?.busy || diaryRef.value?.needsLeaveConfirmation()) {
    event.preventDefault(); event.returnValue = ""
  }
}
defineExpose({ prepareLeave, saveTarget })
onMounted(() => { window.addEventListener("beforeunload", beforeUnload); void host.initialize() })
onBeforeUnmount(() => { window.removeEventListener("beforeunload", beforeUnload); unsubscribe(); host.dispose() })
</script>

<style scoped>
.work-area { border: 0; margin: 0; padding: 0; min-width: 0; }
.first-save { margin: 16px; padding: 14px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
input { margin: 8px; padding: 6px; background: var(--color-paper); color: var(--color-ink); }
button { margin: 6px; color: var(--color-bamboo); }
button:disabled { opacity: .5; }
[role="alert"] { color: var(--color-ji); }
</style>
