<template>
  <section aria-label="预简隔离宿主">
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="bridgeError" role="alert">{{ bridgeError }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <template v-if="state.ready && !state.expired">
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
      <section v-if="state.target" class="first-save" aria-label="受保护的日记目标">
        <p>{{ state.target.entry.title || "无题" }} · {{ state.target.entry.entryDate }}</p>
        <p>已复核目标。这里只准备受保护租约，不跳转旧日记路由；实际编辑器尚待宿主接线。</p>
        <button type="button" :disabled="state.busy" @click="emitTarget">交给受保护的编辑宿主</button>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue"
import { createScheduleHost } from "@/shared/scheduleHost"
import type { DiaryTarget, ScheduleHostPort } from "@/shared/scheduleHostTypes"
import type { EntryUpdateDto } from "@/shared/types"
import type { ScheduleWorkspacePort } from "@/shared/scheduleWorkspace"
import ScheduleWorkspace from "./ScheduleWorkspace.vue"

// 只供隔离宿主显式注入，未进入App/router/DEV；不默认打开任何生产入口。
const props = defineProps<{ port: ScheduleHostPort }>()
const emit = defineEmits<{ "target-ready": [DiaryTarget] }>()
const host = createScheduleHost(props.port)
const state = ref(host.inspect())
const selectedDate = ref("")
const bridgeError = ref("")
const workspacePort = shallowRef<ScheduleWorkspacePort | null>(null)
const workspaceRef = ref<InstanceType<typeof ScheduleWorkspace> | null>(null)
const unsubscribe = host.subscribe(() => { state.value = host.inspect(); workspacePort.value = host.workspacePort() })
async function firstSave(): Promise<void> {
  if (workspaceRef.value && !workspaceRef.value.canCompose()) { bridgeError.value = "请先处理当前工作区编辑或确认，再执行首存"; return }
  bridgeError.value = ""
  if (await host.confirmFirstSave()) await workspaceRef.value?.refresh()
}
async function openTarget(id: string): Promise<void> { await host.openTarget(id) }
async function emitTarget(): Promise<void> {
  const id = state.value.target?.entry.id
  if (id && await host.openTarget(id)) { const target = host.inspect().target; if (target) emit("target-ready", target) }
}
async function prepareLeave(): Promise<boolean> {
  if (state.value.busy) return false
  return workspaceRef.value ? workspaceRef.value.prepareLeave() : true
}
async function saveTarget(update: EntryUpdateDto): Promise<boolean> { return host.saveTarget(update) }
defineExpose({ prepareLeave, saveTarget })
onMounted(() => { void host.initialize() })
onBeforeUnmount(() => { unsubscribe(); host.dispose() })
</script>

<style scoped>
.first-save { margin: 16px; padding: 14px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
input { margin: 8px; padding: 6px; background: var(--color-paper); color: var(--color-ink); }
button { margin: 6px; color: var(--color-bamboo); }
button:disabled { opacity: .5; }
[role="alert"] { color: var(--color-ji); }
</style>
