<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue"
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRoute } from "vue-router"
import { entryNewDestination, scheduleHostRepo } from "@/repo"
import { createScheduleRouteLeave } from "@/shared/scheduleRouteLeave"
import type { ScheduleHostContext } from "@/shared/scheduleHostTypes"
import EntryEditView from "./EntryEditView.vue"
import ScheduleHost from "@/components/schedules/ScheduleHost.vue"

const route = useRoute()
const requestedDate = route.query.date
const destination = ref<{ mode: "diary" } | { mode: "schedule"; date: string; firstSave: boolean; context: ScheduleHostContext } | null>(null)
const error = ref("")
const notice = ref("")
const hostRef = ref<InstanceType<typeof ScheduleHost> | null>(null)
const leaveGuard = createScheduleRouteLeave(() => hostRef.value)
let alive = true
onMounted(async () => {
  try {
    const result = await entryNewDestination.read(requestedDate)
    if (alive) destination.value = result
  } catch { if (alive) error.value = "新建日期、数据归属或原稿无法安全确认；未挂载自动保存器，也未覆盖草稿。请先保留原数据并检查。" }
})
onBeforeRouteUpdate(to => {
  if (JSON.stringify(to.query.date) !== JSON.stringify(requestedDate)) {
    notice.value = "当前新建会话不随地址参数换日期；请先保存或处理草稿，再重新进入。"
    return false
  }
  return true
})
onBeforeRouteLeave(async () => {
  if (destination.value?.mode !== "schedule") return true // 普通日记仍由原编辑器自己的守卫处理。
  const ok = await leaveGuard.attempt()
  notice.value = ok ? "" : leaveGuard.inspect().error || "请先处理当前编辑后重试导航。"
  return ok
})
onBeforeUnmount(() => { alive = false; leaveGuard.dispose() })
</script>

<template>
  <EntryEditView v-if="destination?.mode === 'diary'" />
  <section v-else class="first-entry">
    <header><h1>首存为预简 / 待刻</h1><RouterLink to="/">返回今简</RouterLink> · <RouterLink to="/schedules">预简工作区</RouterLink></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!destination" role="status">正在核对新建日期与原安全草稿…</p>
    <template v-else-if="destination.mode === 'schedule'">
      <p>本次进入日期 {{ destination.date }}。未来文字存入预简；今天与过去的普通新建仍使用原日记编辑器。云端日程同步尚未开放。</p>
      <p v-if="destination.firstSave">已有未关联原稿，未覆盖或自动迁移。请先核对下方只读副本及首存日；图片、标签、心情或天气不能随未来预简写入，不会被自动删掉。</p>
      <p v-else>仅接受文字预简；正式保存前是独立安全草稿。已有预简草稿时，请先明确恢复或处理，未套用本次日期覆盖旧稿。</p>
      <ScheduleHost ref="hostRef" :port="scheduleHostRepo" :context="destination.context" :first-save-enabled="destination.firstSave" :initial-compose-date="destination.firstSave ? undefined : destination.date" :initial-first-save-date="destination.firstSave ? destination.date : undefined" />
    </template>
    <p v-if="notice" role="alert">{{ notice }}</p>
  </section>
</template>

<style scoped>
.first-entry { max-width: 800px; margin: 0 auto; padding: 16px; color: var(--color-ink); }
h1 { font-family: var(--font-cn-serif); font-size: 24px; }
p { margin: 12px 0; }
a { color: var(--color-bamboo); }
[role="alert"] { color: var(--color-ji); }
</style>
