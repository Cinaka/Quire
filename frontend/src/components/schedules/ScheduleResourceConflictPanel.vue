<template>
  <section class="conflict-panel" aria-label="匹配资源终态核对与证据保存" :aria-busy="state.busy">
    <h3>双方核对与证据保存</h3>
    <p>固定来源：{{ state.sourceId }}。仅处理资源已完整匹配的终态；不下载图片、不改共享标签，不进行永久弃去或自动同步。</p>
    <button type="button" :disabled="locked || state.busy" @click="panel.review()">明确读取当前双方版本</button>
    <div v-if="state.preview">
      <p>云端终态来源：{{ state.preview.cloudSourceTitle }}。两种选择均接受该来源；图片 {{ state.preview.mediaCount }} 张，标签：{{ state.preview.tagNames.join('、') || '无' }}。</p>
      <p>本来源首次意图 {{ state.preview.intentionCount }} 份、候选 {{ state.preview.candidateCount }} 份，交接前全部保留。</p>
      <div class="versions">
        <section v-for="(entry, side) in { 本机日记: state.preview.local, 云端当前日记: state.preview.cloud }" :key="side">
          <h4>{{ side }}</h4>
          <template v-if="entry"><p>{{ entry.date }} · {{ entry.deleted ? '已删除' : '未删除' }}</p><strong>{{ entry.title }}</strong><p>心情：{{ entry.mood || '无' }} · 天气：{{ entry.weather || '无' }}</p><pre>{{ entry.text }}</pre></template>
          <p v-else>当前无日记，不制造或恢复日记。</p>
        </section>
      </div>
      <p>此处只显示文字预览，不编辑正文；原格式、实际原图/缩略图、标签、首次意图及全部目标候选都进入双方证据文件。文件可能含私人内容，请保存在可信位置。</p>
      <fieldset :disabled="locked || state.busy || !state.preview.choices.length">
        <legend>明确选择（没有默认项）</legend>
        <label v-for="choice in state.preview.choices" :key="choice"><input type="radio" :name="`resource-choice-${state.sourceId}`" :checked="state.choice === choice" @change="panel.choose(choice)" />{{ choice === 'cloud-source-keep-diary' ? '接受云端来源，保留本机日记（后续由P2同步）' : '接受云端来源，采用云端当前日记' }}</label>
      </fieldset>
      <p v-if="!state.preview.choices.length" role="alert">当前仅可只读核对；缺失/不同资源、未知回执或其他保护问题须先另行处理。</p>
      <p v-if="!fileSavingSupported" role="alert">当前浏览器不支持所需文件保存接口；请使用支持的浏览器。下载链接不能替代独占写入与关闭回读确认。</p>
      <button type="button" :disabled="locked || state.busy || !state.choice || !fileSavingSupported" @click="panel.pickFile()">明确选择全新空证据文件</button>
      <p v-if="state.fileName">目标：{{ state.fileName }}（选择文件不等于已保存）</p>
      <label><input type="checkbox" :checked="state.confirmed" :disabled="locked || state.busy || !state.fileName" @change="confirm" />我已核对双方版本与选择，同意保存双方完整证据；仅在关闭并回读一致后，按此选择尝试本来源原子交接。</label>
      <button type="button" :disabled="locked || state.busy || !state.confirmed" @click="panel.resolve()">明确保存、回读并尝试交接</button>
    </div>
    <p v-if="state.error" role="alert">{{ state.error }}</p><p role="status" aria-live="polite">{{ state.notice }}</p>
    <p v-if="state.expired" role="alert">宿主上下文已变化，请关闭后重新核对。</p>
    <div class="actions"><button type="button" :disabled="locked" @click="panel.cancel()">停止后续步骤</button><button type="button" :disabled="state.closed" @click="close">停止并关闭（不撤销已提交）</button></div>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { createScheduleResourceConflictPanel } from "@/shared/scheduleResourceConflictPanel"
import type { ResourceConflictPanelPort, ResourceConflictSaveTarget } from "@/shared/scheduleResourceConflictPanel"
// Internal composition only: one fixed-context port/picker per session, keyed and explicitly reopened by its host.
const props = defineProps<{ port: ResourceConflictPanelPort; sourceId: string; contextKey: string; pickFile: () => Promise<ResourceConflictSaveTarget>; fileSavingSupported: boolean }>()
const emit = defineEmits<{ close: [] }>()
const panel = createScheduleResourceConflictPanel(props.port, props.sourceId, props.pickFile)
const state = ref(panel.inspect()), locked = computed(() => state.value.closed || state.value.expired)
const unsubscribe = panel.subscribe(() => { state.value = panel.inspect() })
function confirm(event: Event): void { panel.confirm((event.target as HTMLInputElement).checked) }
function close(): void { panel.close(); emit("close") }
watch(() => [props.port, props.sourceId, props.contextKey, props.pickFile, props.fileSavingSupported], () => panel.expire(), { flush: "sync" })
onBeforeUnmount(() => { unsubscribe(); panel.dispose() })
</script>
<style scoped>
.conflict-panel { display: grid; gap: 12px; padding: 16px; color: var(--color-ink); background: var(--color-paper); border: 1px solid var(--color-bamboo-soft); border-radius: 6px; overflow-wrap: anywhere; }
.versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.versions > section, fieldset { padding: 12px; border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
fieldset { display: grid; gap: 12px; } pre { white-space: pre-wrap; font: inherit; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; } button { padding: 8px 12px; color: var(--color-bamboo); border: 1px solid var(--color-bamboo-soft); border-radius: 6px; }
button:disabled { opacity: .5; } [role="alert"] { color: var(--color-ji); }
</style>
