<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-6">
    <header class="mb-5">
      <div class="text-4xl" style="font-family: var(--font-cn-serif)">
        {{ dayNum }}
      </div>
      <div class="mt-1 text-base" style="color: var(--color-ink-soft)">
        {{ monthLabel }} · {{ almanac?.weekday }}
      </div>
    </header>

    <AlmanacCard v-if="almanac" :almanac="almanac" />

    <button class="write-btn" type="button" @click="write">
      {{ todayEntries.length ? "再刻一简" : "刻一简" }}
    </button>

    <section v-if="todayEntries.length" class="mt-6">
      <h2 class="section-title">今日已记 {{ todayEntries.length }} 篇</h2>
      <ul class="entry-list">
        <li v-for="e in todayEntries" :key="e.id" @click="open(e.id)">
          <span class="entry-title">{{ e.title || "无题" }}</span>
          <span class="entry-preview">{{ preview(e.contentText) }}</span>
        </li>
      </ul>
    </section>

    <section class="mt-6">
      <h2 class="section-title">近作</h2>
      <button type="button" class="to-list" @click="router.push('/list')">成编</button>
      <ul v-if="recent.length" class="entry-list">
        <li v-for="e in recent" :key="e.id" @click="open(e.id)">
          <span class="entry-date">{{ e.entryDate.slice(5) }}</span>
          <span class="entry-title">{{ e.title || "无题" }}</span>
        </li>
      </ul>
      <p v-else class="empty">今日无事，也可留白</p>
    </section>

    <footer class="footer">本月已记 {{ monthDays }} 天</footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useRouter } from "vue-router"

import AlmanacCard from "@/components/AlmanacCard.vue"
import { entryRepo } from "@/repo"
import { getAlmanac, type AlmanacDay } from "@/shared/almanac"
import { todayLocal } from "@/shared/time"
import type { EntryListItem } from "@/shared/types"

const router = useRouter()

const today = todayLocal()
const almanac = ref<AlmanacDay | null>(null)
const todayEntries = ref<EntryListItem[]>([])
const recent = ref<EntryListItem[]>([])
const monthDays = ref(0)

const dayNum = computed(() => Number(today.slice(8, 10)))
const monthLabel = computed(() => `${Number(today.slice(5, 7))} 月`)

function preview(text: string): string {
  const s = text.replace(/\n/g, " ").trim()
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

async function load(): Promise<void> {
  almanac.value = getAlmanac(today)

  const mine = await entryRepo.list({ dateFrom: today, dateTo: today, pageSize: 50 })
  todayEntries.value = mine.items

  const latest = await entryRepo.list({ pageSize: 5, order: "entryDateDesc" })
  recent.value = latest.items

  const prefix = today.slice(0, 7)
  const counts = await entryRepo.countByDate(`${prefix}-01`, `${prefix}-31`)
  monthDays.value = Object.keys(counts).length
}

function write(): void {
  router.push("/entry/new")
}

function open(id: string): void {
  router.push(`/entry/${id}`)
}

onMounted(load)
</script>

<style scoped>
.write-btn {
  width: 100%;
  margin-top: 20px;
  padding: 14px;
  border: none;
  border-radius: var(--radius-card);
  background: var(--color-bamboo);
  color: #fff;
  font-family: var(--font-cn-serif);
  font-size: 19px;
  letter-spacing: 2px;
  cursor: pointer;
}

.write-btn:active {
  background: color-mix(in srgb, var(--color-bamboo) 85%, black);
}

.section-title {
  margin: 0 0 10px;
  font-size: 15px;
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
  font-size: 14px;
  color: var(--color-ink-faint);
  font-variant-numeric: tabular-nums;
}

.entry-title {
  flex-shrink: 0;
  font-size: 17px;
  color: var(--color-ink);
}

.entry-preview {
  overflow: hidden;
  font-size: 15px;
  color: var(--color-ink-faint);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty {
  margin: 0;
  font-family: var(--font-cn-serif);
  font-size: 16px;
  color: var(--color-ink-faint);
}

.footer {
  margin-top: 32px;
  text-align: center;
  font-size: 14px;
  color: var(--color-ink-faint);
}

.to-list {
  border: none;
  background: var(--color-ji);
  font-size: 12px;
  line-height: 1.6;
  color: white;
  cursor: pointer;
  padding: 5px;
  border-radius: 4px;
}
</style>
