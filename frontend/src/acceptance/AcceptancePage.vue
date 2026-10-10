<template>
  <main>
    <h1>P4 独立浏览器验收</h1>
    <p>隔离地址：{{ spec.testOrigin }} · 专用库：quire-p4-acceptance</p>
    <p>日常地址：{{ spec.dailyOrigin }}。本页仅验证游客本地流程，无账号、云端、自动备份或数据重置。</p>
    <p role="alert">不要把真实日记或凭据放入验收库。未保存编辑仍需明确处理；刷新不能保证零丢失。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="actions">
      <button type="button" :disabled="busy" @click="seed">在空验收库创建测试数据</button>
      <button type="button" :disabled="busy" @click="toggleHost">{{ entered ? '关闭验收宿主（先检查未保存输入）' : '重新进入验收宿主' }}</button>
    </div>
    <p>夹具含今日、逾期、未来三个预简和一份未关联首存原稿。不会重复追加，已有数据时拒绝创建，不提供清库按钮。</p>
    <ScheduleHost v-if="entered" :key="hostKey" ref="hostRef" :port="localScheduleHostRepo" />
  </main>
</template>
<script setup lang="ts">
import { ref } from "vue"
import type { AcceptanceSpec } from "./guard"
import { initializeAcceptance, seedAcceptance } from "./fixtures"
import { localScheduleHostRepo } from "@/db/scheduleHostRepo"
import ScheduleHost from "@/components/schedules/ScheduleHost.vue"
const props = defineProps<{ spec: AcceptanceSpec }>()
const entered = ref(true)
const hostKey = ref(1)
const hostRef = ref<InstanceType<typeof ScheduleHost> | null>(null)
const busy = ref(false)
const error = ref("")
const notice = ref("")
async function canLeave(): Promise<boolean> { return !entered.value || Boolean(hostRef.value && await hostRef.value.prepareLeave()) }
async function seed(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ""
  try {
    if (!await canLeave()) { error.value = "请先处理宿主中的未保存编辑或确认"; return }
    await seedAcceptance(props.spec)
    notice.value = "测试数据已原子创建。可检查首存分流、到期/逾期转简及受保护日记编辑。"
    hostKey.value += 1; entered.value = true
  } catch (failure) { error.value = String(failure) }
  finally { busy.value = false }
}
async function toggleHost(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ""
  try {
    if (entered.value) { if (!await canLeave()) { error.value = "返回保护已阻止关闭，请明确保存或处理未保存输入"; return }; entered.value = false }
    else { await initializeAcceptance(props.spec); hostKey.value += 1; entered.value = true }
  } catch (failure) { error.value = String(failure) }
  finally { busy.value = false }
}
</script>
<style scoped>
main { max-width: 900px; margin: 24px auto; padding: 16px; color: var(--color-ink); }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }
button { padding: 8px; color: var(--color-bamboo); border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
button:disabled { opacity: .5; }
[role="alert"] { color: var(--color-ji); }
</style>
