<template>
  <section class="resource-workspace" aria-label="资源差异统一核对与明确交接" :aria-busy="state.busy">
    <h3>双方资源核对</h3>
    <p>固定来源：{{ state.sourceId }}。两种选择都接受云端终态来源；没有默认取舍，不自动发布或同步，不删除共享标签或其他日记。</p>
    <fieldset :disabled="locked || state.busy || state.closeRequested">
      <legend>一、保存或读取原证据</legend>
      <p>文件包含私人正文、原图、缩略图、标签和首次意图，请保存在可信位置。准备实物可能下载当前云端图片，但不会补齐本机或解除保护。</p>
      <label><input type="checkbox" :checked="state.downloadConfirmed" @change="downloadConfirmation" />我同意读取双方当前版本，并下载本来源完整云端图片用于保全。</label>
      <button type="button" :disabled="!state.downloadConfirmed" @click="panel.prepareEvidence()">明确准备双方实物</button>
      <p v-if="!fileSavingSupported" role="alert">浏览器不支持所需保存接口。可读取原文件；下载链接不能替代独占写入与关闭回读。</p>
      <button type="button" :disabled="!state.evidenceTicket || !fileSavingSupported" @click="panel.saveEvidence()">选择全新空文件并保存回读</button>
      <label>读取原双方实物JSON文件<input type="file" accept="application/json,.json" @change="readFile" /></label>
      <p v-if="state.fileName">当前文件：{{ state.fileName }}。{{ state.fileSaved ? '已由本次保存流程回读' : '原文件；需核对当前版本' }}。</p>
      <button type="button" :disabled="!state.fileName" @click="panel.readCurrent()">明确重读当前文件并核对状态</button>
    </fieldset>
    <template v-if="state.preview">
      <div class="versions">
        <section v-for="(entry, side) in { 本机日记: state.preview.local, 云端日记: state.preview.cloud }" :key="side">
          <h4>{{ side }}</h4><p>{{ entry.date }}</p><strong>{{ entry.title }}</strong><pre>{{ entry.text }}</pre>
          <p>标签：{{ entry.tags.map(tag => tag.name).join('、') || '无' }}。正文预览最多12000字符，完整内容保存在原文件。</p>
        </section>
      </div>
      <p>本机图片 {{ state.preview.localMediaCount }} 张，云端图片 {{ state.preview.cloudMediaCount }} 张。预览不编辑正文，也不把文件当成备份恢复或首次转换确认。</p>
      <p v-for="blocker in state.preview.blockers" :key="blocker" role="alert">{{ blockText[blocker] }}</p>
      <p v-if="state.preview.plan">原准备阶段：{{ stageText[state.preview.plan.stage] }}。使用原计划和原标签ID，不另建一套。独立名称：{{ state.preview.plan.names.map(row => row.name).join('、') }}。</p>
      <fieldset :disabled="locked || state.busy || state.closeRequested || terminalPlan">
        <legend>二、明确选择日记正文（没有默认项）</legend>
        <label v-for="choice in choices" :key="choice"><input type="radio" :name="`resource-workspace-${state.sourceId}`" :checked="state.choice === choice" :disabled="!!state.preview.plan && state.preview.plan.choice !== choice" @change="panel.choose(choice)" />{{ choice === 'cloud-source-keep-diary' ? '保留本机日记正文' : '采用云端当前日记正文' }}</label>
      </fieldset>
    </template>
    <section v-if="state.names.length" aria-label="独立标签明确命名">
      <h4>独立标签名称输入</h4>
      <p>每个标签须明确填写新名称，不预填、不自动加后缀、不把同名归并成其他ID。未保存输入不会因切换选择或重读文件而被静默丢弃。</p>
      <label v-for="row in state.names" :key="row.from">{{ originalTagName(row.from) }} 的新名称<input type="text" maxlength="32" :value="row.name" :disabled="locked || state.busy || state.closeRequested || !state.preview" @input="nameInput(row.from, $event)" /></label>
      <button type="button" :disabled="state.busy || locked" @click="discardRequested = true">弃去未保存名称…</button>
      <div v-if="discardRequested" role="alert"><p>仅清空本次名称输入，不弃去任何持久计划或已发布标签。</p><button type="button" @click="discardRequested = false">取消，保留输入</button><button type="button" :disabled="state.busy || locked" @click="discardNames">明确弃去名称输入</button></div>
    </section>
    <fieldset v-if="state.preview && state.choice" :disabled="locked || state.busy || state.closeRequested">
      <legend>三、逐步单独确认</legend>
      <div v-for="action in actions" :key="action.key">
        <template v-if="panel.can(action.key)"><p>{{ action.warning }}</p><label><input type="checkbox" :checked="state.confirmedAction === action.key" @change="confirm(action.key, $event)" />{{ action.confirmation }}</label><button type="button" :disabled="state.confirmedAction !== action.key" @click="panel.apply(action.key)">{{ action.label }}</button></template>
      </div>
      <p v-if="!actions.some(action => panel.can(action.key))">当前没有可确认的操作。请查看受阻说明；本页不强制解锁、恢复已删日记、永久弃去或修改共享定义。</p>
    </fieldset>
    <p v-if="state.error" role="alert">{{ state.error }}</p><p role="status" aria-live="polite">{{ state.notice }}</p>
    <p v-if="state.expired" role="alert">宿主来源、账号或恢复上下文已变化；旧面板已锁定。名称输入仅留在本页供核对，请关闭后重新建立会话。</p>
    <button type="button" :disabled="locked" @click="panel.cancel()">停止后续步骤（保留名称输入）</button>
    <button type="button" :disabled="state.closed" @click="panel.requestClose()">关闭工作区…</button>
    <div v-if="state.closeRequested" role="alertdialog" aria-label="确认关闭资源工作区"><p>关闭会清除本页未保存的名称输入，并停止后续步骤；已落盘文件、已发起发布及已提交交接不会被撤销。</p><button type="button" @click="panel.confirmClose(false)">取消关闭，保留输入</button><button type="button" @click="closeConfirmed">明确关闭</button></div>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { createScheduleResourceWorkspacePanel } from "@/shared/scheduleResourceWorkspacePanel"
import type { WorkspaceAction } from "@/shared/scheduleResourceWorkspacePanel"
import { RESOURCE_WORKSPACE_BLOCK_TEXT } from "@/shared/scheduleResourceWorkspaceTypes"
import type { ResourceWorkspacePort, ResourceWorkspaceSaveTarget } from "@/shared/scheduleResourceWorkspaceTypes"
import type { SharedTagCopyChoice } from "@/shared/scheduleSharedTagCopy"
const props = defineProps<{ port: ResourceWorkspacePort; sourceId: string; contextKey: string; pickFile: () => Promise<ResourceWorkspaceSaveTarget>; fileSavingSupported: boolean }>()
const emit = defineEmits<{ close: [] }>()
const panel = createScheduleResourceWorkspacePanel(props.port, props.sourceId, props.pickFile)
const state = ref(panel.inspect()), locked = computed(() => state.value.closed || state.value.expired), discardRequested = ref(false)
const unsubscribe = panel.subscribe(() => { state.value = panel.inspect() })
const choices: SharedTagCopyChoice[] = ["cloud-source-use-diary", "cloud-source-keep-diary"], blockText = RESOURCE_WORKSPACE_BLOCK_TEXT
const stageText = { prepared: "仅本机准备", started: "发布结果待核对", confirmed: "历史标签存在确认", "handed-off": "已有本机交接留档", stale: "旧恢复批次，不可续写" }
const terminalPlan = computed(() => ["stale", "handed-off"].includes(state.value.preview?.plan?.stage ?? ""))
const actions: Array<{ key: WorkspaceAction; label: string; confirmation: string; warning: string }> = [
  { key: "direct", label: "按明确选择尝试直接交接", confirmation: "我已核对正文和双方文件，确认本来源按所选版本交接。", warning: "只适用于原共享标签定义一致等已支持条件；失败不改走独立标签。" },
  { key: "names", label: "明确保存独立命名准备", confirmation: "我确认全部新名称与所选正文，仅保存本机原ID准备。", warning: "这一步不发布标签、不替换日记引用。" },
  { key: "publish", label: "明确发布或用原ID重新核对", confirmation: "我同意使用原ID和原名称发布/核对独立标签，服务端可能新增标签。", warning: "响应丢失仍保留原准备；不自动删除远端标签，不按未发布弃去。" },
  { key: "handoff", label: "复核存在并尝试本机引用交接", confirmation: "我确认所选正文和原独立标签；只读复核通过后尝试本机原子交接。", warning: "标签缺失不补建；两种正文选择都产生P2待上传日记修订，原共享资源仍保护，不等于云端已同步。" },
]
function downloadConfirmation(event: Event) { panel.confirmDownload((event.target as HTMLInputElement).checked) }
function confirm(action: WorkspaceAction, event: Event) { panel.confirm(action, (event.target as HTMLInputElement).checked) }
function originalTagName(from: string) { const preview = state.value.preview; const tags = state.value.choice === "cloud-source-keep-diary" ? preview?.local.tags : preview?.cloud.tags; return tags?.find(tag => tag.id === from)?.name ?? from }
function nameInput(from: string, event: Event) { panel.setName(from, (event.target as HTMLInputElement).value) }
async function readFile(event: Event) { const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ""; if (file) await panel.readFile(file, file.name) }
function discardNames() { panel.discardNames(true); discardRequested.value = false }
function closeConfirmed() { if (panel.confirmClose(true)) emit("close") }
watch(() => [props.port, props.sourceId, props.contextKey, props.pickFile, props.fileSavingSupported], () => { discardRequested.value = false; panel.expire() }, { flush: "sync" })
onBeforeUnmount(() => { unsubscribe(); panel.dispose() })
</script>
<style scoped>
.resource-workspace { display: grid; gap: 12px; padding: 16px; color: var(--color-ink); background: var(--color-paper); border: 1px solid var(--color-bamboo-soft); border-radius: 6px; overflow-wrap: anywhere; }
.versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
fieldset, .versions > section { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
label { display: block; } pre { white-space: pre-wrap; font: inherit; } button { padding: 8px 12px; color: var(--color-bamboo); border: 1px solid var(--color-bamboo-soft); border-radius: 6px; } button:disabled { opacity: .5; } [role="alert"] { color: var(--color-ji); }
</style>
