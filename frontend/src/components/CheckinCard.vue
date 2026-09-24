<template>
  <section class="checkin-card" aria-labelledby="checkin-title">
    <div class="checkin-head">
      <div>
        <p id="checkin-title" class="title">上名青简</p>
        <p class="streak">
          {{ summary ? `已连续 ${currentStreak} 日` : "每日一记，留名青简" }}
        </p>
      </div>
      <button
        type="button"
        :disabled="loading || checkingIn || checkedInToday || offline"
        @click="$emit('submit')"
      >
        {{ buttonLabel }}
      </button>
    </div>

    <p v-if="stale" class="hint">当前展示的是上次读取结果</p>
    <p v-if="error" class="error" role="status">
      {{ error }}
      <button v-if="!offline" type="button" class="retry" @click="$emit('retry')">
        重试
      </button>
    </p>

    <div v-if="summary" class="calendar" :aria-label="`${summary.year} 年 ${summary.month} 月签到日历`">
      <span v-for="label in weekLabels" :key="label" class="weekday">{{ label }}</span>
      <span
        v-for="(cell, index) in cells"
        :key="cell ?? `blank-${index}`"
        class="day"
        :class="{
          blank: cell === null,
          checked: cell !== null && checkedDates.has(cell),
          today: cell === summary.today,
          future: cell !== null && cell > summary.today,
        }"
        :aria-label="cell ? dayLabel(cell) : undefined"
      >
        {{ cell ? Number(cell.slice(8, 10)) : "" }}
      </span>
    </div>
    <p v-else-if="loading" class="hint" role="status">正在展开签到册……</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue"

import type { MonthCheckinSummary } from "@/api/checkins"
import type { LocalDate } from "@/shared/types"

const props = defineProps<{
  summary: MonthCheckinSummary | null
  loading: boolean
  checkingIn: boolean
  offline: boolean
  stale: boolean
  error: string
  checkedInToday: boolean
  currentStreak: number
}>()

defineEmits<{
  submit: []
  retry: []
}>()

const weekLabels = ["日", "一", "二", "三", "四", "五", "六"]
const checkedDates = computed(() => new Set(props.summary?.checkinDates ?? []))

const buttonLabel = computed(() => {
  if (props.checkingIn) return "正在上名……"
  if (props.checkedInToday) return "今日已上名"
  if (props.offline) return "离线不可签到"
  if (props.loading) return "读取中……"
  return "上名青简"
})

const cells = computed<Array<LocalDate | null>>(() => {
  if (!props.summary) return []
  const { year, month } = props.summary
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const result: Array<LocalDate | null> = Array.from({ length: firstWeekday }, () => null)
  for (let day = 1; day <= days; day += 1) {
    result.push(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    )
  }
  return result
})

function dayLabel(value: LocalDate): string {
  const checked = checkedDates.value.has(value) ? "，已签到" : "，未签到"
  const today = value === props.summary?.today ? "，今天" : ""
  return `${Number(value.slice(5, 7))} 月 ${Number(value.slice(8, 10))} 日${today}${checked}`
}
</script>

<style scoped>
.checkin-card {
  margin-top: 20px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--color-bamboo) 24%, transparent);
  border-radius: var(--radius-card);
  background: var(--color-paper-deep);
}

.checkin-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.title,
.streak,
.hint,
.error {
  margin: 0;
}

.title {
  font-family: var(--font-cn-serif);
  font-size: var(--text-section);
  line-height: var(--leading-section);
  color: var(--color-ink);
}

.streak,
.hint,
.error,
.weekday,
.day {
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
}

.streak,
.hint {
  margin-top: 3px;
  color: var(--color-ink-faint);
}

.checkin-head > button {
  flex: none;
  min-width: 92px;
  padding: 8px 12px;
  border: 1px solid var(--color-bamboo);
  border-radius: var(--radius-card);
  background: var(--color-bamboo);
  color: #fff;
  cursor: pointer;
}

.checkin-head > button:disabled {
  border-color: color-mix(in srgb, var(--color-ink-faint) 24%, transparent);
  background: transparent;
  color: var(--color-ink-faint);
  cursor: default;
}

.error {
  margin-top: 8px;
  color: var(--color-ji);
}

.retry {
  margin-left: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-bamboo);
  text-decoration: underline;
  cursor: pointer;
}

.calendar {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 5px;
  margin-top: 12px;
}

.weekday,
.day {
  display: grid;
  min-height: 28px;
  place-items: center;
  color: var(--color-ink-faint);
  font-variant-numeric: tabular-nums;
}

.day {
  border: 1px solid transparent;
  border-radius: 4px;
}

.day.checked {
  background: color-mix(in srgb, var(--color-bamboo) 18%, transparent);
  color: var(--color-bamboo);
}

.day.today {
  border-color: var(--color-bamboo);
}

.day.future,
.day.blank {
  opacity: 0.35;
}
</style>
