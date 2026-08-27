<template>
  <div class="home mx-auto w-full max-w-2xl px-4 py-6">
    <header class="head mb-5">
      <div class="date-block">
        <div class="day-number">{{ dayNum }}</div>
        <div class="month-weekday">{{ monthLabel }} · {{ almanac?.weekday }}</div>
        <HomeDateNavigator
          v-model="selectedDate"
          :max="today"
          @blocked="showBlockedNotice"
        />
      </div>
      <button type="button" class="plain" @click="router.push('/settings')">设置</button>
    </header>

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <AlmanacCard v-if="almanac" :key="selectedDate" :almanac="almanac" />

    <section class="mt-6">
      <h2 v-if="dateEntries.length" class="section-title">
        {{ selectedDate === today ? "今日已记" : "当日已记" }} {{ dateEntries.length }} 篇
      </h2>
      <ul v-if="dateEntries.length" class="entry-list">
        <li v-for="entry in dateEntries" :key="entry.id" @click="open(entry.id)">
          <span class="entry-title">{{ entry.title || "无题" }}</span>
          <span class="entry-preview">{{ preview(entry.contentText) }}</span>
        </li>
      </ul>
      <div v-else class="empty-state">
        <BambooSlipEmpty />
        <p class="empty empty-hand">今日无事，也可留白</p>
      </div>
    </section>

    <button class="sign-in" type="button" disabled title="登录后可用">
      <span>上名青简</span>
      <small>登录后可用</small>
    </button>

    <section class="mt-6">
      <div class="sec-head">
        <h2 class="section-title">近作</h2>
        <button
          v-if="recent.length"
          type="button"
          class="plain accent"
          @click="router.push('/list')"
        >
          成编
        </button>
      </div>
      <ul v-if="recent.length" class="entry-list">
        <li v-for="entry in recent" :key="entry.id" @click="open(entry.id)">
          <span class="entry-date">{{ entry.entryDate.slice(5) }}</span>
          <span class="entry-title">{{ entry.title || "无题" }}</span>
        </li>
      </ul>
      <p v-else class="empty">简册尚空，今日宜落笔</p>
    </section>

    <footer class="footer">{{ Number(selectedDate.slice(5, 7)) }} 月已记 {{ monthDays }} 天</footer>

    <button type="button" class="write-fab" :aria-label="writeLabel" @click="write">
      {{ writeLabel }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useRouter } from "vue-router"

import AlmanacCard from "@/components/AlmanacCard.vue"
import BambooSlipEmpty from "@/components/BambooSlipEmpty.vue"
import HomeDateNavigator from "@/components/HomeDateNavigator.vue"
import { entryRepo } from "@/repo"
import { getAlmanac, type AlmanacDay } from "@/shared/almanac"
import { todayLocal } from "@/shared/time"
import type { EntryListItem } from "@/shared/types"

const router = useRouter()

const today = todayLocal()
const selectedDate = ref(today)
const almanac = ref<AlmanacDay | null>(null)
const dateEntries = ref<EntryListItem[]>([])
const recent = ref<EntryListItem[]>([])
const monthDays = ref(0)
const notice = ref("")
let loadSeq = 0

const dayNum = computed(() => Number(selectedDate.value.slice(8, 10)))
const monthLabel = computed(() => `${Number(selectedDate.value.slice(5, 7))} 月`)
const writeLabel = computed(() => {
  if (selectedDate.value !== today) return "补记一简"
  return dateEntries.value.length ? "再刻一简" : "刻一简"
})

function preview(text: string): string {
  const value = text.replace(/\n/g, " ").trim()
  return value.length > 40 ? `${value.slice(0, 40)}…` : value
}

async function load(): Promise<void> {
  const mine = ++loadSeq
  const date = selectedDate.value
  const nextAlmanac = getAlmanac(date)

  const [minePage, latest] = await Promise.all([
    entryRepo.list({ dateFrom: date, dateTo: date, pageSize: 50 }),
    entryRepo.list({ pageSize: 5, order: "entryDateDesc" }),
  ])

  const prefix = date.slice(0, 7)
  const counts = await entryRepo.countByDate(`${prefix}-01`, `${prefix}-31`)
  if (mine !== loadSeq) return

  almanac.value = nextAlmanac
  dateEntries.value = minePage.items
  recent.value = latest.items
  monthDays.value = Object.keys(counts).length
}

function showBlockedNotice(): void {
  notice.value = "预简（待刻）尚未开放，暂只能刻已至之日"
}

function write(): void {
  void router.push({ path: "/entry/new", query: { date: selectedDate.value } })
}

function open(id: string): void {
  void router.push(`/entry/${id}`)
}

watch(selectedDate, () => {
  notice.value = ""
  void load()
})

onMounted(() => {
  void load()
})
</script>

<style scoped>
.home {
  padding-bottom: 108px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.date-block {
  display: grid;
  gap: 4px;
}

.day-number {
  font-family: var(--font-cn-serif);
  font-size: var(--text-display);
  line-height: var(--leading-display);
  color: var(--color-ink);
}

.month-weekday {
  margin-bottom: 6px;
  font-size: var(--text-body);
  line-height: var(--leading-body);
  color: var(--color-ink-soft);
}

.notice {
  margin: 0 0 12px;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ji);
}

.section-title {
  margin: 0 0 10px;
  font-size: var(--text-section);
  line-height: var(--leading-section);
  font-weight: normal;
  letter-spacing: 1px;
  color: var(--color-ink-faint);
}

.entry-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.entry-list li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--color-ink) 6%, transparent);
  cursor: pointer;
}

.entry-date {
  flex-shrink: 0;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
  font-variant-numeric: tabular-nums;
}

.entry-title,
.entry-preview,
.empty,
.plain {
  font-size: var(--text-body);
  line-height: var(--leading-body);
}

.entry-title {
  flex-shrink: 0;
  font-family: var(--font-cn-serif);
  color: var(--color-ink);
}

.entry-preview {
  overflow: hidden;
  color: var(--color-ink-faint);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty-state {
  padding: 8px 0 4px;
  text-align: center;
}

.empty {
  margin: 0;
  font-family: var(--font-cn-serif);
  color: var(--color-ink-faint);
}

.empty-hand {
  font-family: var(--font-cn-hand);
}

.sign-in {
  display: grid;
  width: 100%;
  gap: 2px;
  margin-top: 20px;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--color-ink-faint) 30%, transparent);
  border-radius: var(--radius-card);
  background: var(--color-paper-deep);
  color: var(--color-ink-faint);
  font-family: var(--font-cn-serif);
  font-size: var(--text-body);
  line-height: var(--leading-body);
  cursor: not-allowed;
}

.sign-in small {
  font-family: var(--font-cn-sans);
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
}

.footer {
  margin-top: 32px;
  text-align: center;
  font-size: var(--text-caption);
  line-height: var(--leading-caption);
  color: var(--color-ink-faint);
}

.sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.plain {
  padding: 6px 2px;
  border: none;
  background: none;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.accent {
  color: var(--color-bamboo);
}

.write-fab {
  position: fixed;
  right: max(20px, calc((100vw - 672px) / 2 + 20px));
  bottom: calc(72px + env(safe-area-inset-bottom));
  z-index: 20;
  min-width: 52px;
  min-height: 52px;
  padding: 10px 16px;
  border: none;
  border-radius: 999px;
  background: var(--color-bamboo);
  color: #fff;
  font-family: var(--font-cn-serif);
  font-size: var(--text-body);
  line-height: var(--leading-body);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--color-ink) 18%, transparent);
  cursor: pointer;
}

@media (min-width: 768px) {
  .home {
    padding-bottom: 84px;
  }

  .write-fab {
    bottom: 28px;
  }
}
</style>
