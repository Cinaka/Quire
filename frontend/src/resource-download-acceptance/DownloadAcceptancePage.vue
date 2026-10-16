<template>
  <main>
    <h1>P4 图片下载与补齐独立验收</h1>
    <p>隔离地址：{{ spec.testOrigin }} · 专用库：quire-p4-resource-download-acceptance</p>
    <p>日常地址：{{ spec.dailyOrigin }}。原5181补齐/交接库与已保存文件均不使用、不迁移或清除。</p>
    <p role="alert">本页仅模拟云端证明与图片下载响应，使用真实SHA校验和本机IndexedDB写入。无真实账号、HTTP下载、同步或清库按钮。不要放真实日记或凭据。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p role="status" aria-live="polite">{{ notice }}</p>
    <div class="actions">
      <button type="button" :disabled="busy || Boolean(session)" @click="seed">仅在空下载验收库创建一次夹具</button>
      <button type="button" :disabled="busy || Boolean(session)" @click="open">明确打开模拟下载面板</button>
      <button type="button" :disabled="busy" @click="readStatus">读取下载验收状态（只读）</button>
    </div>
    <p>夹具：一个终态来源、一篇带缺失图片引用的受保护日记、一份首次意图和一个候选。仅在空专用库创建，不重复追加、覆盖或重置。</p>
    <dl v-if="status">
      <dt>来源 / 日记 / 首次意图 / 候选</dt><dd>{{ status.sourceCount }} / {{ status.entryCount }} / {{ status.intentionCount }} / {{ status.candidateCount }}（始终1/1/1/1）</dd>
      <dt>媒体行 / 下载补齐留档</dt><dd>{{ status.mediaRows }} / {{ status.archiveCount }}（确认前0/0，成功后1/1）</dd>
      <dt>实际原图 / 缩略图与夹具一致</dt><dd>{{ status.originalMatches ? '是' : '尚未补齐' }} / {{ status.thumbnailMatches ? '是' : '尚未补齐' }}</dd>
    </dl>
    <section v-if="session" aria-label="模拟下载与真实本机写入">
      <p>先勾选图片，再设置模拟证明或图片暂停，随后下载准备计划；准备成功后才设置写事务暂停、勾选确认并提交。重新选择/停止会清除旧暂停。</p>
      <div class="actions">
        <button type="button" :disabled="Boolean(waiting)" @click="arm('proof')">暂停下一次模拟证明</button>
        <button type="button" :disabled="Boolean(waiting)" @click="arm('image')">暂停下一次模拟图片响应</button>
        <button type="button" :disabled="Boolean(waiting)" @click="arm('transaction')">暂停下一次真实写事务（最多10秒）</button>
        <button type="button" :disabled="!waiting" @click="session.release()">放行当前暂停</button>
      </div>
      <p v-if="waiting" role="alert">已暂停：{{ waiting === 'transaction' ? '真实IndexedDB事务；请10秒内停止/关闭或放行' : waiting === 'image' ? '本地模拟图片响应（无网络）' : '本地模拟证明（无网络）' }}。可点面板停止或关闭。</p>
      <ScheduleResourceDownloadPanel :key="sessionKey" :port="session.port" :source-id="sourceId" :context-key="`download-demo-${sessionKey}`" :media-options="mediaOptions" @close="close" />
    </section>
    <p>请先做准备/图片响应取消、准备后关闭及事务取消测试，再最终确认补齐。补齐后只读核对、刷新重进；再次下载完整图片应被拒绝，不增加留档。</p>
    <p>停止或关闭不能撤销已提交内容。刷新会丢弃未确认的内存下载计划，但不能保证正在提交的事务未完成；请重新读取状态。不提供删除图片来重做测试的按钮。</p>
  </main>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue"
import ScheduleResourceDownloadPanel from "@/components/schedules/ScheduleResourceDownloadPanel.vue"
import type { DownloadAcceptanceSpec } from "./guard"
import type { DownloadAcceptancePause } from "./barrier"
import { createDownloadAcceptanceSession, inspectDownloadAcceptance, seedDownloadAcceptance } from "./runtime"
import { deactivateDownloadIdentity } from "./identity"
import { RESOURCE_SOURCE_ID, RESOURCE_MEDIA_ID } from "../resource-acceptance/model"
const props = defineProps<{ spec: DownloadAcceptanceSpec }>()
const sourceId = RESOURCE_SOURCE_ID, mediaOptions = [{ id: RESOURCE_MEDIA_ID, label: "验收：1×1非私人PNG原图及缩略图（本地模拟响应）" }]
const session = shallowRef<ReturnType<typeof createDownloadAcceptanceSession> | null>(null)
const sessionKey = ref(0), waiting = ref<DownloadAcceptancePause | null>(null)
const status = ref<Awaited<ReturnType<typeof inspectDownloadAcceptance>> | null>(null)
const busy = ref(false), error = ref(""), notice = ref("未自动创建夹具、下载图片、打开面板或写入业务数据。")
let alive = true, revision = 0
async function run(action: (check: () => void) => Promise<void>): Promise<void> {
  if (!alive || busy.value) return
  const current = revision, check = () => { if (!alive || current !== revision) throw new Error("旧下载验收页面已失效") }
  busy.value = true; error.value = ""
  try { check(); await action(check); check() }
  catch { if (alive && current === revision) error.value = "操作未确认：请核对独立配置、凭据与已有下载验收数据；没有覆盖、清除或自动接管。" }
  finally { busy.value = false }
}
async function seed(): Promise<void> {
  if (session.value) return
  await run(async check => { await seedDownloadAcceptance(props.spec); check(); const state = await inspectDownloadAcceptance(props.spec); check(); status.value = state; notice.value = "下载夹具已原子创建；可明确打开面板。" })
}
async function readStatus(): Promise<void> {
  await run(async check => { const state = await inspectDownloadAcceptance(props.spec); check(); status.value = state; notice.value = "已只读核对实际图片字节、保护和下载补齐留档；本次未下载或写入。" })
}
async function open(): Promise<void> {
  if (session.value) return
  await run(async check => {
    const state = await inspectDownloadAcceptance(props.spec); check(); status.value = state
    const key = ++sessionKey.value
    session.value = createDownloadAcceptanceSession(props.spec, point => { if (sessionKey.value === key) waiting.value = point })
    notice.value = "独占模拟下载面板已打开；尚未下载、准备计划或补齐。"
  })
}
function arm(point: DownloadAcceptancePause): void {
  notice.value = session.value?.pauseNext(point) ? "已设置下一次暂停；请明确发起对应操作。" : "操作仍在进行或会话已关闭，未设置新暂停。"
}
function close(): void { session.value?.close(); session.value = null; waiting.value = null; notice.value = "下载会话已关闭；已提交内容不会撤销，请重新读取状态。" }
watch(() => [props.spec.enabled, props.spec.dailyOrigin, props.spec.testOrigin], () => { revision++; close(); status.value = null; deactivateDownloadIdentity() }, { flush: "sync" })
onBeforeUnmount(() => { alive = false; revision++; close(); deactivateDownloadIdentity() })
</script>
<style scoped>
main { max-width: 960px; margin: 24px auto; padding: 16px; color: var(--color-ink); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
button { padding: 8px 12px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; color: var(--color-bamboo); }
button:disabled { opacity: .5; }
[role="alert"] { color: var(--color-ji); }
dd { margin: 0 0 12px; }
</style>
