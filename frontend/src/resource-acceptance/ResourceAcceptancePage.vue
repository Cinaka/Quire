<template>
  <main>
    <h1>P4 图片补齐独立验收</h1>
    <p>隔离地址：{{ spec.testOrigin }} · 专用库：quire-p4-resource-acceptance</p>
    <p>日常地址：{{ spec.dailyOrigin }}；旧游客验收库也不使用。本页无真实账号、HTTP证明、上传、同步或清库按钮。</p>
    <p role="alert">只放本页提供的验收材料，不放真实日记或凭据。面板中的“云端证明”在本页均指本地模拟证明；通过本页不代表服务端或双设备验收通过。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p role="status" aria-live="polite">{{ notice }}</p>
    <div class="actions">
      <button type="button" :disabled="busy || Boolean(session)" @click="seed">仅在空验收库创建一次夹具</button>
      <button type="button" :disabled="busy" @click="readStatus">读取验收状态（只读）</button>
      <button type="button" :disabled="busy" @click="downloadMaterial">下载验收材料JSON（不是保存确认）</button>
      <button type="button" :disabled="busy || Boolean(session)" @click="openSession">明确打开补齐面板</button>
    </div>
    <p>夹具含一个终态来源、一篇带图片引用的受保护日记、一份首次意图和一个候选；媒体行故意缺失。不重复追加、不覆盖、不重置。</p>
    <dl v-if="status">
      <dt>来源 / 日记 / 首次意图 / 候选</dt><dd>{{ status.sourceCount }} / {{ status.entryCount }} / {{ status.intentionCount }} / {{ status.candidateCount }}（须一直保持）</dd>
      <dt>本机媒体行 / 补齐留档</dt><dd>{{ status.mediaRows }} / {{ status.archiveCount }}</dd>
      <dt>实际原图 / 缩略图摘要与夹具一致</dt><dd>{{ status.originalMatches ? '是' : '尚未补齐或不同' }} / {{ status.thumbnailMatches ? '是' : '尚未补齐或不同' }}</dd>
    </dl>
    <section v-if="session" aria-label="可控取消验收">
      <p>先完成文件与图片选择，再设置暂停；换文件/选择会取消旧计划和暂停设置。</p>
      <div class="actions">
        <button type="button" :disabled="Boolean(waiting)" @click="arm('proof')">暂停下一次模拟证明（不发网络）</button>
        <button type="button" :disabled="Boolean(waiting)" @click="arm('transaction')">暂停下一次真实写事务（最多10秒）</button>
        <button type="button" :disabled="!waiting" @click="session.release()">放行当前暂停</button>
      </div>
      <p v-if="waiting" role="alert">已暂停：{{ waiting === 'proof' ? '本地模拟证明' : '真实IndexedDB事务内复验（请10秒内停止/关闭或放行；超时会失败并须重开计划）' }}。可点面板“停止后续步骤”或“停止并关闭”。</p>
      <ScheduleResourceRepairPanel :key="sessionKey" :port="session.port" :source-id="sourceId" :context-key="`resource-demo-${sessionKey}`" :media-options="mediaOptions" @close="closeSession" />
    </section>
    <p>取消不能撤销已经提交的补齐。完成后请点“读取验收状态”再刷新页面、重新进入并只读核对持久化；已有完整图片再次准备会被拒绝，不会重复导入。</p>
  </main>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef } from "vue"
import ScheduleResourceRepairPanel from "@/components/schedules/ScheduleResourceRepairPanel.vue"
import type { ResourceAcceptanceSpec } from "./guard"
import type { ResourceAcceptancePause } from "./barrier"
import { createResourceAcceptanceSession, inspectResourceAcceptance, seedResourceAcceptance } from "./runtime"
import { resourceFixtureMaterial, RESOURCE_SOURCE_ID, RESOURCE_MEDIA_ID } from "./model"
import { deactivateResourceIdentity } from "./identity"
const props = defineProps<{ spec: ResourceAcceptanceSpec }>()
const sourceId = RESOURCE_SOURCE_ID, mediaOptions = [{ id: RESOURCE_MEDIA_ID, label: "验收：1×1非私人PNG（原图及缩略图）" }]
const session = shallowRef<ReturnType<typeof createResourceAcceptanceSession> | null>(null)
const sessionKey = ref(0), waiting = ref<ResourceAcceptancePause | null>(null)
const status = ref<Awaited<ReturnType<typeof inspectResourceAcceptance>> | null>(null)
const busy = ref(false), error = ref(""), notice = ref("未自动创建夹具、读取文件或打开补齐面板。")
const urls = new Set<string>()
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ""
  try { await action() } catch { error.value = "操作未确认：请核对专用配置、凭据和既有验收数据；没有覆盖、清除或自动接管。" }
  finally { busy.value = false }
}
async function seed(): Promise<void> { if (session.value) return; await run(async () => { await seedResourceAcceptance(props.spec); status.value = await inspectResourceAcceptance(props.spec); notice.value = "夹具已原子创建。请下载材料，再明确打开面板。" }) }
async function readStatus(): Promise<void> { await run(async () => { status.value = await inspectResourceAcceptance(props.spec); notice.value = "已只读核对夹具及实际图片摘要；没有执行补齐。" }) }
async function downloadMaterial(): Promise<void> {
  await run(async () => {
    await inspectResourceAcceptance(props.spec)
    const url = URL.createObjectURL(new Blob([resourceFixtureMaterial()], { type: "application/json" })); urls.add(url)
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "quire-p4-resource-fixture-v1.json"
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 5000)
    notice.value = "已发起验收材料下载；请自行确认文件落盘。这不是双方冲突保全/云端取舍的保存成功证明。"
  })
}
async function openSession(): Promise<void> {
  if (session.value) return
  await run(async () => {
    status.value = await inspectResourceAcceptance(props.spec)
    const key = ++sessionKey.value
    session.value = createResourceAcceptanceSession(props.spec, point => { if (sessionKey.value === key) waiting.value = point })
    notice.value = "独占验收会话已打开；尚未读取文件、请求模拟证明或补齐。"
  })
}
function arm(point: ResourceAcceptancePause): void {
  notice.value = session.value?.pauseNext(point) ? "已设置下一次暂停；请在面板发起相应明确操作。" : "当前操作仍在进行，未设置新暂停。"
}
function closeSession(): void { session.value?.close(); session.value = null; waiting.value = null; notice.value = "会话已关闭。已提交内容不会撤销，请只读核对。" }
onBeforeUnmount(() => { closeSession(); deactivateResourceIdentity(); for (const url of urls) URL.revokeObjectURL(url); urls.clear() })
</script>
<style scoped>
main { max-width: 960px; margin: 24px auto; padding: 16px; color: var(--color-ink); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
button { padding: 8px 12px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; color: var(--color-bamboo); }
button:disabled { opacity: .5; }
[role="alert"] { color: var(--color-ji); }
dd { margin: 0 0 12px; }
</style>
