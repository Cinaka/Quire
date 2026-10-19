<template>
  <section aria-label="本机待刻提醒" class="schedule-reminder">
    <p v-if="state.status === 'ready' && state.summary" role="status" aria-live="polite">
      本机待刻 {{ state.summary.dueTotal }} 简：今日 {{ state.summary.dueToday }} 简，逾期 {{ state.summary.overdue }} 简。
      <span>按本机自然日 {{ state.summary.asOf }} 计算；不是云端全部数据。</span>
    </p>
    <p v-else-if="state.status === 'expired'" role="alert">提醒上下文已失效，请处理未保存输入后重新进入。未继续显示旧账号数量。</p>
    <p v-else-if="state.status === 'error'" role="alert">暂不能读取本机待刻数量；不代表没有待刻，请重试。</p>
    <p v-else role="status">正在读取本机待刻数量…</p>
    <button type="button" :disabled="state.status === 'loading' || state.status === 'expired'" @click="refresh">重新读取提醒</button>
    <button type="button" :disabled="state.status !== 'ready'" @click="emit('open')">查看预简工作区</button>
    <p>仅应用内提示，不自动转简或签到；关闭浏览器后不保证提醒。</p>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, watch } from "vue"
import { createScheduleReminder } from "@/shared/scheduleReminder"
import type { ScheduleReminderPort } from "@/shared/scheduleReminder"
const props = defineProps<{ port: ScheduleReminderPort; contextKey: string | number }>()
const emit = defineEmits<{ open: [] }>()
const controller = createScheduleReminder(props.port)
const state = shallowRef(controller.inspect())
const unsubscribe = controller.subscribe(() => { state.value = controller.inspect() })
let alive = true, watching = false, stopWatch: (() => void) | undefined, timer: number | undefined
function stopWatching(): void { stopWatch?.(); stopWatch = undefined }
async function refresh(): Promise<void> {
  await controller.refresh()
  if (!alive || state.value.status !== "ready" || watching || !props.port.watch) return
  watching = true
  try {
    stopWatch = props.port.watch(() => { void refresh() }, () => { controller.invalidate(); stopWatching() })
    if (!alive || state.value.status !== "ready") stopWatching()
  } catch { controller.invalidate() }
}
function visible(): void { if (document.visibilityState === "visible") void refresh() }
function focus(): void { void refresh() }
onMounted(() => {
  void refresh()
  timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh() }, 60_000)
  document.addEventListener("visibilitychange", visible)
  window.addEventListener("focus", focus)
})
watch(() => [props.contextKey, props.port], () => { controller.invalidate(); stopWatching() }, { flush: "sync" })
onBeforeUnmount(() => {
  alive = false; stopWatching()
  if (timer !== undefined) window.clearInterval(timer)
  document.removeEventListener("visibilitychange", visible); window.removeEventListener("focus", focus)
  unsubscribe(); controller.dispose()
})
</script>
<style scoped>
.schedule-reminder { border: 1px solid var(--color-bamboo-soft); border-radius: 8px; padding: 12px; margin-block: 12px; }
p { margin-block: 6px; }
button { margin-inline-end: 8px; padding: 6px; }
span { display: block; color: var(--color-ink-faint); }
</style>
