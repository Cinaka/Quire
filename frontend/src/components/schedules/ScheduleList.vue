<template>
  <section aria-label="预简列表" :aria-busy="loading">
    <p class="hint">仅显示本机记录；日程云端同步尚未开放。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">读取预简中…</p>
    <p v-else-if="!items.length && !error" class="hint">暂无预简。</p>
    <ul class="list">
      <li v-for="item in displayed" :key="item.row.id" class="card">
        <header><time :datetime="item.row.remindDate">{{ item.row.remindDate }}</time><span>{{ item.view.label }}</span></header>
        <h3>{{ item.row.title || "无题" }}</h3>
        <p class="preview">{{ item.view.preview }}</p>
        <div class="actions">
          <button v-if="item.view.canEdit" type="button" :disabled="blocked" @click="emit('edit', item.row.id)">编辑</button>
          <button v-if="item.view.canConvert" type="button" :disabled="blocked" @click="emit('convert-request', { id: item.row.id, expectedClientUpdatedAt: item.row.clientUpdatedAt, remindDate: item.row.remindDate })">刻成日记…</button>
          <button v-if="item.view.canInspect" type="button" :disabled="blocked" @click="emit('inspect-conversion', item.row.id)">查看转简结果</button>
          <button v-if="item.view.canRemove" type="button" :disabled="blocked" @click="emit('remove-request', item.row.id)">移入断简…</button>
          <button v-if="item.view.canRestore" type="button" :disabled="blocked" @click="emit('restore-request', item.row.id)">恢复预简</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { presentSchedule } from "@/shared/schedulePresentation"
import type { LocalDate, Schedule } from "@/shared/types"

const props = defineProps<{ items: readonly Schedule[]; today: LocalDate; loading?: boolean; busy?: boolean; error?: string }>()
const emit = defineEmits<{
  edit: [string]; "remove-request": [string]; "restore-request": [string]; "inspect-conversion": [string]
  "convert-request": [{ id: string; expectedClientUpdatedAt: string; remindDate: LocalDate }]
}>()
const displayed = computed(() => props.items.map(row => ({ row, view: presentSchedule(row, props.today) })))
const blocked = computed(() => Boolean(props.loading || props.busy || props.error))
</script>

<style scoped>
.hint { color: var(--color-ink-faint); font-size: 13px; }
.list { list-style: none; padding: 0; display: grid; gap: 12px; }
.card { padding: 14px; border: 1px solid var(--color-bamboo-soft); border-radius: 8px; }
header, .actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; }
header { font-size: 13px; color: var(--color-ink-soft); }
h3 { margin: 10px 0 6px; font-family: var(--font-cn-serif); }
.preview { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--color-ink-soft); }
.actions { justify-content: flex-start; }
button { color: var(--color-bamboo); cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
</style>
