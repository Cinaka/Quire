<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink } from "vue-router"
import { scheduleHostRepo } from "@/repo"
import { createScheduleRouteLeave } from "@/shared/scheduleRouteLeave"
import ScheduleHost from "@/components/schedules/ScheduleHost.vue"

// 单次挂载固定一个宿主；不从query/hash取账号、来源ID或动作，不因导航失败重建宿主。
const hostRef = ref<InstanceType<typeof ScheduleHost> | null>(null)
const leaveNotice = ref("")
const leaveGuard = createScheduleRouteLeave(() => hostRef.value)
onBeforeRouteLeave(async () => {
  const allowed = await leaveGuard.attempt()
  leaveNotice.value = allowed ? "" : leaveGuard.inspect().error || "离开检查进行中，请先保留当前输入。"
  return allowed
})
// /schedules的query/hash不承载页面状态；同组件更新不重挂载，也不消费任何动作参数。
onBeforeRouteUpdate(() => true)
onBeforeUnmount(() => leaveGuard.dispose())
</script>

<template>
  <section class="schedule-page">
    <header class="page-header">
      <h1>预简 / 待刻</h1>
      <p role="status">本机试用：可创建文字预简、改期、移入断简/恢复，以及到期后明确刻成日记。日程云端同步尚未开放。</p>
      <p>不会自动转简。请定期到设置中进行防蠹备份；此页不会自动认领、重置或清除本地数据。</p>
      <nav aria-label="页面导航"><RouterLink to="/">返回今简</RouterLink><RouterLink to="/list">简册</RouterLink><RouterLink to="/settings">设置 / 防蠹</RouterLink></nav>
    </header>
    <p v-if="leaveNotice" class="leave-notice" role="alert">{{ leaveNotice }}</p>
    <ScheduleHost ref="hostRef" :port="scheduleHostRepo" :first-save-enabled="false" />
  </section>
</template>

<style scoped>
.schedule-page { max-width: 800px; margin: 0 auto; padding: 16px; color: var(--color-ink); }
h1 { font-family: var(--font-cn-serif); font-size: 24px; }
.page-header p { color: var(--color-ink-faint); font-size: 13px; margin: 10px 0; }
nav { display: flex; gap: 18px; flex-wrap: wrap; }
a { color: var(--color-bamboo); }
.leave-notice { color: var(--color-ji); margin: 12px 0; }
</style>
