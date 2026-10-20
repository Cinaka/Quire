<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue"
import { RouterLink } from "vue-router"
import { scheduleSyncRuntime } from "@/api/scheduleSyncRuntime"
const state = ref(scheduleSyncRuntime.inspect())
const stop = scheduleSyncRuntime.subscribe(() => { state.value = scheduleSyncRuntime.inspect() })
onBeforeUnmount(stop)
</script>
<template>
  <section class="schedule-sync" aria-label="独立日程同步状态">
    <h2>预简 / 待刻同步</h2>
    <p>单独处理日程与首次转换意图，不代替日记、标签、图片的P2同步。默认关闭，仅明确启用本次会话；刷新后需重新启用。请先确认备份及后端部署。</p>
    <p role="status">{{ state.message }}</p>
    <p v-if="state.reviewing" role="status">本页资源/终态核对尚未关闭，不能启用日程同步；关闭后仍需明确启用，不自动恢复。此保护不是跨标签页或跨设备锁。</p>
    <p v-if="state.pending">上次核对剩余：日程修订 {{ state.pending.dirty }}，转换意图 {{ state.pending.conversions }}，冲突 {{ state.pending.conflicts }}；{{ state.pending.pullContinuation ? '拉取仍有后续页' : '无已登记拉取续页' }}。不是所有设备的实时总数。</p>
    <button v-if="!state.enabled" type="button" :disabled="state.busy || state.reviewing" @click="scheduleSyncRuntime.enable()">明确启用本次会话日程同步（将开始上传/拉取）</button>
    <template v-else>
      <button type="button" :disabled="state.busy" @click="scheduleSyncRuntime.runNow()">立即核对 / 明确重试日程</button>
      <button type="button" @click="scheduleSyncRuntime.pause()">暂停本次会话日程同步</button>
    </template>
    <section v-if="state.issues.total" aria-label="本轮日程同步原因摘要">
      <h3>本轮原因摘要</h3>
      <p>仅含本次会话刚完成轮次的安全说明，不是持久错误历史，也不代表以下记录已解除保护。</p>
      <ul><li v-for="(item, index) in state.issues.items" :key="index">
        <strong>{{ item.stage === 'conversion' ? '首次转换' : item.stage === 'push' ? '日程上行' : item.stage === 'pull' ? '日程拉取' : '轮次核对' }} · {{ item.level === 'waiting' ? '正常暂留' : item.level === 'error' ? '请求或确认未完成' : '需要核对' }}</strong>
        <p>{{ item.message }}</p><p>来源：<code>{{ item.sourceId || '本轮未定位具体来源' }}</code></p>
      </li></ul>
      <p v-if="state.issues.omitted">摘要最多展开20条，另有 {{ state.issues.omitted }} 条未展开；未删除或自动处理这些记录。</p>
      <p>真实冲突请先暂停并等待在途轮次结束，再到预简核对区处理；未定位来源或无法解释时保留原库和防蠹备份，不强制清除。</p>
    </section>
    <p>暂停不撤销已发出请求或已提交结果。离线、未知回执和资源冲突不会清库、恢复日记或强制确认；请先处理原因再明确重试。</p>
    <RouterLink to="/schedules">进入预简 / 资源与终态核对</RouterLink>
  </section>
</template>
<style scoped>
.schedule-sync { margin-top: 16px; padding: 14px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: var(--color-paper-deep); }
h2 { font-family: var(--font-cn-serif); font-size: 20px; } p { margin: 10px 0; color: var(--color-ink-faint); font-size: 13px; }
button { margin: 6px 6px 6px 0; padding: 8px 12px; color: var(--color-bamboo); border: 1px solid var(--color-bamboo-soft); border-radius: 6px; } button:disabled { opacity: .5; }
a { color: var(--color-bamboo); }
</style>
