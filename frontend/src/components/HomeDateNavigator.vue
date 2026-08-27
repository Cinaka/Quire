<template>
  <div class="date-navigator" aria-label="选择日记日期">
    <button type="button" aria-label="前一天" @click="step(-1)">‹</button>
    <input
      ref="inputRef"
      class="date-input"
      type="date"
      :value="props.modelValue"
      :max="props.max"
      aria-label="当前日期"
      @click="enhancePicker"
      @change="choose(($event.target as HTMLInputElement).value)"
    />
    <button
      type="button"
      aria-label="后一天"
      :disabled="props.modelValue >= props.max"
      @click="step(1)"
    >
      ›
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue"

import { addLocalDays, isLocalDate } from "@/shared/time"

const props = defineProps<{
  modelValue: string
  max: string
}>()

const emit = defineEmits<{
  "update:modelValue": [string]
  blocked: []
}>()

const inputRef = ref<HTMLInputElement | null>(null)

function choose(value: string): void {
  if (!isLocalDate(value)) return
  if (value > props.max) {
    emit("blocked")
    return
  }
  emit("update:modelValue", value)
}

function step(days: number): void {
  const next = addLocalDays(props.modelValue, days)
  if (next > props.max) {
    emit("blocked")
    return
  }
  emit("update:modelValue", next)
}

function enhancePicker(): void {
  const input = inputRef.value
  if (!input || !("showPicker" in input)) return
  try {
    input.showPicker()
  } catch {
    // 原生 date input 仍可正常操作；showPicker 只作增强。
  }
}
</script>

<style scoped>
.date-navigator {
  display: inline-grid;
  grid-template-columns: 36px minmax(140px, 1fr) 36px;
  align-items: center;
  gap: 6px;
}

.date-navigator button {
  display: grid;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--color-ink-faint) 35%, transparent);
  border-radius: 999px;
  background: var(--color-paper);
  color: var(--color-ink-soft);
  font-size: var(--text-section);
  place-items: center;
  cursor: pointer;
}

.date-navigator button:disabled {
  color: var(--color-ink-faint);
  cursor: not-allowed;
  opacity: 0.55;
}

.date-input {
  min-width: 0;
  height: 36px;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--color-ink-faint) 35%, transparent);
  border-radius: 8px;
  background: var(--color-paper);
  color: var(--color-ink);
  font: inherit;
  font-size: var(--text-body);
  line-height: var(--leading-body);
  cursor: pointer;
}
</style>
