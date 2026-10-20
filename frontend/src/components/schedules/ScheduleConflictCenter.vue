<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue"
import { listScheduleConflictSources, createScheduleConflictSession, scheduleHostRepo } from "@/repo"
import type { ScheduleHostContext } from "@/shared/scheduleHostTypes"
import type { ConflictSource, ScheduleConflictSession, TerminalCenterAction, TerminalCenterPreview } from "@/shared/scheduleConflictCenterTypes"
import { TERMINAL_BLOCK_TEXT } from "@/shared/scheduleTerminalBlockers"
import { pickResourceWorkspaceEvidence } from "@/io/scheduleResourceWorkspacePicker"
import { resourceEvidenceSaveAvailable } from "@/io/scheduleResourceSavePicker"
import ScheduleResourceWorkspacePanel from "./ScheduleResourceWorkspacePanel.vue"
const props = defineProps<{ context: ScheduleHostContext }>()
const emit = defineEmits<{ close: [] }>()
const context = { ...props.context }, sources = ref<ConflictSource[]>([]), selected = ref<ConflictSource | null>(null)
const session = shallowRef<ScheduleConflictSession | null>(null), preview = ref<TerminalCenterPreview | null>(null)
const resourceOpen = ref(false), resourceRef = ref<InstanceType<typeof ScheduleResourceWorkspacePanel> | null>(null)
const busy = ref(false), expired = ref(false), error = ref(""), notice = ref(""), confirmedAction = ref<TerminalCenterAction | null>(null)
const fileSavingSupported = resourceEvidenceSaveAvailable(), pickFile = () => pickResourceWorkspaceEvidence()
let alive = true, stop: (() => void) | undefined
function invalidate() {
  expired.value = true; sources.value = []; preview.value = null; confirmedAction.value = null
  session.value?.cancel(); resourceRef.value?.expire()
  error.value = "账号或恢复上下文已变化，旧会话已锁定。资源名称输入仍可复制；请明确关闭，处理归属后重新进入。"
}
async function reload() {
  if (busy.value || resourceOpen.value || expired.value) return
  busy.value = true; error.value = ""
  try { const result = await listScheduleConflictSources(context); if (alive && !expired.value) sources.value = result }
  catch { if (alive) error.value = "来源列表无法安全读取，未忽略异常记录或清库。" }
  finally { if (alive) busy.value = false }
}
function select(row: ConflictSource) {
  if (busy.value || resourceOpen.value || expired.value) return
  session.value?.cancel(); session.value = null; preview.value = null; confirmedAction.value = null; notice.value = ""; error.value = ""
  try { session.value = createScheduleConflictSession(context, row.id); selected.value = { ...row } }
  catch { selected.value = null; error.value = "此入口需要登录账号与本地归属一致。请按既有备份/认领流程处理；游客仍可使用本机预简。" }
}
async function review() {
  if (!session.value || busy.value || resourceOpen.value || expired.value) return
  busy.value = true; preview.value = null; confirmedAction.value = null; error.value = ""; notice.value = ""
  try { const result = await session.value.review(); if (alive && !expired.value) preview.value = result }
  catch { if (alive && !expired.value) error.value = "本次核对未确认，可能离线、旧后端或版本/归属已变化。保留原库和文件，不自动重试或强制解锁。" }
  finally { if (alive) busy.value = false }
}
function openResources() {
  if (!session.value || busy.value || expired.value) return
  preview.value = null; confirmedAction.value = null; resourceOpen.value = true
}
function closeResources() { resourceOpen.value = false; preview.value = null; confirmedAction.value = null }
async function apply(action: TerminalCenterAction) {
  if (!session.value || !preview.value || confirmedAction.value !== action || busy.value || resourceOpen.value || expired.value || !fileSavingSupported) return
  if (action === "source" && !preview.value.sourceDeletionEnabled) return
  if (action !== "source" && action !== "observation" && !preview.value.choices.includes(action)) return
  busy.value = true; confirmedAction.value = null; error.value = ""; notice.value = ""
  let target: Awaited<ReturnType<typeof pickFile>> | null = null
  try {
    // 文件选择直接来自点击，不等网络之后再申请用户手势；取消不写库、不重放。
    target = await pickFile()
    if (!alive || expired.value) return
    const ok = await session.value.apply(action, true, target.handle)
    if (alive && !expired.value) notice.value = ok ? (action === "observation" ? "本机实物与当前云端观察已保存回读；不确认意图、不解除保护、不等于完整云端备份。" : "受支持处置已提交本机；不代表云端日记全部同步。请重新明确核对。") : "本次处置未确认。保留原库与可能已写入的证据文件；不宣称回滚或自动重试。"
  } catch { if (alive && !expired.value) error.value = "文件选择或处置未确认，请保留原库及文件；取消不启动后续操作。" }
  finally { target?.cancel(); if (alive) { busy.value = false; preview.value = null } }
}
async function prepareLeave(): Promise<boolean> {
  const allowed = !busy.value && !resourceOpen.value
  if (!allowed) notice.value = "请等待当前操作结束，并在资源面板中明确关闭；未保存名称不能直接丢弃。"
  return allowed
}
async function close() { if (await prepareLeave()) emit("close") }
function beforeUnload(event: BeforeUnloadEvent) { if (busy.value || resourceOpen.value) { event.preventDefault(); event.returnValue = "" } }
defineExpose({ prepareLeave })
onMounted(() => { stop = scheduleHostRepo.watch(context, invalidate); window.addEventListener("beforeunload", beforeUnload); void reload() })
onBeforeUnmount(() => { alive = false; stop?.(); session.value?.cancel(); window.removeEventListener("beforeunload", beforeUnload) })
</script>
<template>
  <section aria-label="资源冲突与终态核对" class="conflict-center">
    <h2>资源冲突 / 终态核对</h2>
    <p>只列本机已转简来源，不自动请求云端。选择来源后仍须明确读取；核对会使用当前登录账号访问服务器。没有默认取舍，不自动转简、认领、恢复日记或启动日程同步。</p>
    <button type="button" :disabled="busy || resourceOpen || expired" @click="reload">重新读取本机来源</button>
    <p v-if="!sources.length && !busy">当前没有可列出的本机已转简来源；这不表示云端没有冲突，也不表示所有数据已同步。</p>
    <ul><li v-for="row in sources" :key="row.id"><button type="button" :disabled="busy || resourceOpen || expired" @click="select(row)">{{ row.title || '无题' }} · {{ row.deleted ? '来源已移入断简' : '已转简' }} · {{ row.id }}</button></li></ul>
    <template v-if="session && selected">
      <p>当前固定来源：{{ selected.id }}。未保存的日记/预简已在进入本区前处理；核对期间不并行编辑。</p>
      <fieldset v-if="!resourceOpen" :disabled="busy || expired">
        <legend>明确选择核对方式</legend>
        <button type="button" @click="openResources">打开双方资源核对…</button>
        <button type="button" @click="review">明确读取云端终态与本机观察</button>
      </fieldset>
      <ScheduleResourceWorkspacePanel v-if="resourceOpen" ref="resourceRef" :expired="expired" :port="session.resources" :source-id="selected.id" :context-key="JSON.stringify(context)" :pick-file="pickFile" :file-saving-supported="fileSavingSupported" @close="closeResources" />
      <section v-if="preview && !resourceOpen" aria-label="终态观察结果">
        <p v-for="block in preview.blocks" :key="block">{{ TERMINAL_BLOCK_TEXT[block] }}</p>
        <p>本机引用实物{{ preview.completeLocalResources ? '已核对齐全' : '仍有缺口' }}；此观察不含云端图片字节或云端标签定义。</p>
        <p v-if="!fileSavingSupported" role="alert">此浏览器不支持新空文件的保存回读。可核对说明，不提供下载链接替代，也不开放处置。</p>
        <fieldset :disabled="busy || expired || !fileSavingSupported">
          <legend>保存与处置分别明确授权；每步完成必须重新核对</legend>
          <label><input type="checkbox" :checked="confirmedAction === 'observation'" @change="confirmedAction = ($event.target as HTMLInputElement).checked ? 'observation' : null" />仅保全本机实物与当前云端观察，不解除保护</label>
          <button :disabled="confirmedAction !== 'observation'" @click="apply('observation')">选新空文件并保存观察</button>
          <template v-if="preview.sourceDeletionEnabled"><label><input type="checkbox" :checked="confirmedAction === 'source'" @change="confirmedAction = ($event.target as HTMLInputElement).checked ? 'source' : null" />只接受已核对的云端来源删除状态；日记不变、原意图与保护继续保留</label><button :disabled="confirmedAction !== 'source'" @click="apply('source')">保存证据并明确接纳来源墓碑</button></template>
          <div v-for="choice in preview.choices" :key="choice"><label><input type="checkbox" :checked="confirmedAction === choice" @change="confirmedAction = ($event.target as HTMLInputElement).checked ? choice : null" />{{ choice === 'finish-cloud-purged' ? '仅收尾既有永久弃去意图：接纳已核对的云端缺失，不生成日记' : '仅处理既有永久弃去意图：交给P2清空软删墓碑，不恢复活动日记' }}</label><button :disabled="confirmedAction !== choice" @click="apply(choice)">保存证据并明确处理既有弃去意图</button></div>
        </fieldset>
      </section>
    </template>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
    <button type="button" @click="close">返回本机预简（先处理未保存输入）</button>
  </section>
</template>
<style scoped>
.conflict-center { display: grid; gap: 12px; overflow-wrap: anywhere; }
fieldset { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--color-bamboo-soft); }
button { padding: 8px 12px; } ul { display: grid; gap: 8px; padding-left: 20px; }
[role="alert"] { color: var(--color-ji); }
</style>
