<template>
  <main>
    <h1>P4 图片补齐与证据交接独立验收</h1>
    <p>隔离地址：{{ spec.testOrigin }} · 专用库：quire-p4-resource-acceptance</p>
    <p>日常地址：{{ spec.dailyOrigin }}；旧游客验收库也不使用。本页无真实账号、HTTP证明、上传、同步或清库按钮。</p>
    <p role="alert">只放本页提供的验收材料，不放真实日记或凭据。面板中的“云端证明”在本页均指本地模拟证明；通过本页不代表服务端或双设备验收通过。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p role="status" aria-live="polite">{{ notice }}</p>
    <div class="actions">
      <button type="button" :disabled="busy || Boolean(session) || Boolean(resolutionSession)" @click="seed">仅在空验收库创建一次夹具</button>
      <button type="button" :disabled="busy" @click="readStatus">读取验收状态（只读）</button>
      <button type="button" :disabled="busy" @click="downloadMaterial">下载验收材料JSON（不是保存确认）</button>
      <button type="button" :disabled="busy || Boolean(session) || Boolean(resolutionSession) || status?.stage === 'resolved'" @click="openSession">明确打开补齐面板</button>
      <button type="button" :disabled="busy || Boolean(session) || Boolean(resolutionSession) || !fileSavingSupported || status?.stage === 'resolved'" @click="openResolution">明确打开证据保存与交接面板</button>
    </div>
    <p>夹具含一个终态来源、一篇带图片引用的受保护日记、一份首次意图和一个候选；媒体行故意缺失。不重复追加、不覆盖、不重置。</p>
    <dl v-if="status">
      <dt>来源 / 日记 / 首次意图 / 候选</dt><dd>{{ status.sourceCount }} / {{ status.entryCount }} / {{ status.intentionCount }} / {{ status.candidateCount }}（补齐阶段1/1/1/1；明确交接后1/1/0/0）</dd>
      <dt>验收阶段 / 交接留档</dt><dd>{{ status.stage === 'resolved' ? '已明确交接（仅模拟证明）' : '受保护、尚未交接' }} / {{ status.handoffArchiveCount }}</dd>
      <dt>当前日记标题 / dirty</dt><dd>{{ status.entryTitle }} / {{ status.entryDirty }}（不自动P2同步）</dd>
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
    <section v-if="resolutionSession" aria-label="证据保存与交接验收">
      <p>本页模拟云端日记标题刻意与本机不同，用于区分两种选择。先读取双方、选择取舍及文件，再设置暂停、勾选并提交；重新读取或停止会清除暂停。先做取消，再最终交接；文件和已提交事务都不能因关闭撤销。</p>
      <div class="actions">
        <button type="button" :disabled="Boolean(waiting)" @click="armResolution('proof')">暂停下一次交接模拟证明（不发网络）</button>
        <button type="button" :disabled="Boolean(waiting)" @click="armResolution('transaction')">暂停下一次交接真实事务（最多10秒）</button>
        <button type="button" :disabled="!waiting" @click="resolutionSession.release()">放行当前交接暂停</button>
      </div>
      <p v-if="waiting" role="alert">已暂停：{{ waiting === 'proof' ? '本地模拟证明' : '真实IndexedDB事务内复验（请10秒内停止/关闭；此时证据文件可能已经保存）' }}。停止不能撤回已保存文件。</p>
      <ScheduleResourceConflictPanel :key="sessionKey" :port="resolutionSession.port" :source-id="sourceId" :context-key="`resource-resolution-${sessionKey}`" :pick-file="pickResourceConflictSaveTarget" :file-saving-supported="fileSavingSupported" @close="closeResolution" />
    </section>
    <p v-if="!fileSavingSupported" role="alert">当前浏览器没有所需保存接口。请使用支持showSaveFilePicker的安全上下文浏览器；不以下载链接替代真实保存回读确认。</p>
    <label>明确重新打开已保存双方证据JSON（只读，不重放选择）<input type="file" accept=".json,application/json" :disabled="busy || Boolean(session) || Boolean(resolutionSession)" @change="readSavedFile" /></label>
    <p>最终交接只允许一次。交接后关闭面板、读取状态并刷新重读；本机媒体与补齐留档仍为1/1，首次意图/候选为0/0，交接留档为1。不要清库或重建来重复选择另一分支。</p>
    <p>取消不能撤销已经提交的补齐。完成后请点“读取验收状态”再刷新页面、重新进入并只读核对持久化；已有完整图片再次准备会被拒绝，不会重复导入。</p>
  </main>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from "vue"
import ScheduleResourceConflictPanel from "@/components/schedules/ScheduleResourceConflictPanel.vue"
import { pickResourceConflictSaveTarget, resourceEvidenceSaveAvailable } from "@/io/scheduleResourceSavePicker"
import ScheduleResourceRepairPanel from "@/components/schedules/ScheduleResourceRepairPanel.vue"
import type { ResourceAcceptanceSpec } from "./guard"
import type { ResourceAcceptancePause } from "./barrier"
import { createResourceAcceptanceSession, seedResourceAcceptance } from "./runtime"
import { createResourceResolutionAcceptanceSession, inspectResourceAcceptanceLifecycle, readResourceAcceptanceSavedFile } from "./resolution"
import { resourceFixtureMaterial, RESOURCE_SOURCE_ID, RESOURCE_MEDIA_ID } from "./model"
import { deactivateResourceIdentity } from "./identity"
const props = defineProps<{ spec: ResourceAcceptanceSpec }>()
const sourceId = RESOURCE_SOURCE_ID, mediaOptions = [{ id: RESOURCE_MEDIA_ID, label: "验收：1×1非私人PNG（原图及缩略图）" }]
const session = shallowRef<ReturnType<typeof createResourceAcceptanceSession> | null>(null)
const resolutionSession = shallowRef<ReturnType<typeof createResourceResolutionAcceptanceSession> | null>(null)
const fileSavingSupported = resourceEvidenceSaveAvailable()
let alive = true, pageRevision = 0
const sessionKey = ref(0), waiting = ref<ResourceAcceptancePause | null>(null)
const status = ref<Awaited<ReturnType<typeof inspectResourceAcceptanceLifecycle>> | null>(null)
const busy = ref(false), error = ref(""), notice = ref("未自动创建夹具、读取文件或打开补齐面板。")
const urls = new Set<string>()
async function run(action: (check: () => void) => Promise<void>): Promise<void> {
  if (!alive || busy.value) return
  const revision = pageRevision
  const check = () => { if (!alive || revision !== pageRevision) throw new Error("旧验收页面已失效") }
  busy.value = true; error.value = ""
  try { check(); await action(check); check() } catch { if (alive && revision === pageRevision) error.value = "操作未确认：请核对专用配置、凭据和既有验收数据；没有覆盖、清除或自动接管。" }
  finally { busy.value = false }
}
async function seed(): Promise<void> { if (session.value || resolutionSession.value) return; await run(async check => { await seedResourceAcceptance(props.spec); check(); const current = await inspectResourceAcceptanceLifecycle(props.spec); check(); status.value = current; notice.value = "夹具已原子创建。请下载材料，再明确打开面板。" }) }
async function readStatus(): Promise<void> { await run(async check => { const current = await inspectResourceAcceptanceLifecycle(props.spec); check(); status.value = current; notice.value = "已只读核对验收阶段、图片与留档；本次读取没有执行补齐或交接。" }) }
async function downloadMaterial(): Promise<void> {
  await run(async check => {
    await inspectResourceAcceptanceLifecycle(props.spec); check()
    const url = URL.createObjectURL(new Blob([resourceFixtureMaterial()], { type: "application/json" })); urls.add(url)
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "quire-p4-resource-fixture-v1.json"
    document.body.appendChild(anchor); anchor.click(); anchor.remove()
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url) }, 5000)
    notice.value = "已发起验收材料下载；请自行确认文件落盘。这不是双方冲突保全/云端取舍的保存成功证明。"
  })
}
async function openSession(): Promise<void> {
  if (session.value || resolutionSession.value) return
  await run(async check => {
    const current = await inspectResourceAcceptanceLifecycle(props.spec); check(); status.value = current
    if (current.stage !== "protected") throw new Error("已交接不能重开补齐")
    const key = ++sessionKey.value
    session.value = createResourceAcceptanceSession(props.spec, point => { if (sessionKey.value === key) waiting.value = point })
    notice.value = "独占验收会话已打开；尚未读取文件、请求模拟证明或补齐。"
  })
}
async function openResolution(): Promise<void> {
  if (session.value || resolutionSession.value || !fileSavingSupported) return
  await run(async check => {
    const current = await inspectResourceAcceptanceLifecycle(props.spec); check(); status.value = current
    if (current.stage !== "protected" || current.mediaRows !== 1 || current.archiveCount !== 1 || !current.originalMatches || !current.thumbnailMatches) throw new Error("先完成补齐，或已经交接")
    const key = ++sessionKey.value
    resolutionSession.value = createResourceResolutionAcceptanceSession(props.spec, point => { if (sessionKey.value === key) waiting.value = point })
    notice.value = "保存交接会话已打开；尚未读取双方、选择文件或进行取舍。"
  })
}
async function readSavedFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ""
  if (!file || session.value || resolutionSession.value) return
  await run(async check => {
    const result = await readResourceAcceptanceSavedFile(props.spec, file); check()
    notice.value = result.handoffConfirmed ? "文件完整性与本次交接留档一致；只读回读完成，未重放选择。" : "文件完整性通过，但当前验收库尚未交接；文件存在不是业务交接成功。"
  })
}
function armResolution(point: ResourceAcceptancePause): void {
  notice.value = resolutionSession.value?.pauseNext(point) ? "已设置下一次交接暂停；请明确发起对应操作。" : "操作仍在进行，未设置新暂停。"
}
function closeResolution(): void { resolutionSession.value?.close(); resolutionSession.value = null; waiting.value = null; notice.value = "交接会话已关闭，文件或业务提交不会因此撤销；请重新读取状态。" }
function arm(point: ResourceAcceptancePause): void {
  notice.value = session.value?.pauseNext(point) ? "已设置下一次暂停；请在面板发起相应明确操作。" : "当前操作仍在进行，未设置新暂停。"
}
function closeSession(): void { session.value?.close(); session.value = null; waiting.value = null; notice.value = "会话已关闭。已提交内容不会撤销，请只读核对。" }
watch(() => [props.spec.enabled, props.spec.dailyOrigin, props.spec.testOrigin], () => { pageRevision++; closeSession(); closeResolution(); status.value = null; deactivateResourceIdentity() }, { flush: "sync" })
onBeforeUnmount(() => { alive = false; pageRevision++; closeSession(); closeResolution(); deactivateResourceIdentity(); for (const url of urls) URL.revokeObjectURL(url); urls.clear() })
</script>
<style scoped>
main { max-width: 960px; margin: 24px auto; padding: 16px; color: var(--color-ink); }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
button { padding: 8px 12px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; color: var(--color-bamboo); }
button:disabled { opacity: .5; }
[role="alert"] { color: var(--color-ji); }
dd { margin: 0 0 12px; }
</style>
