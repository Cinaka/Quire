<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="head">
      <button type="button" class="plain" @click="router.push('/')">今简</button>
      <h1 class="page-title">成编</h1>
      <button type="button" class="plain accent" @click="router.push('/entry/new')">刻一简</button>
    </header>

    <input
      v-model="keyword"
      class="search"
      type="search"
      placeholder="搜标题与正文"
      enterkeyhint="search"
    />

    <div class="bar">
      <div class="orders">
        <button
          v-for="o in ORDERS"
          :key="o.value"
          type="button"
          class="chip"
          :class="{ on: order === o.value }"
          @click="order = o.value"
        >
          {{ o.label }}
        </button>
      </div>
      <span class="count">共 {{ total }} 简</span>
    </div>

    <p v-if="loading && !items.length" class="hint">检简中……</p>

    <template v-else-if="items.length">
      <section v-for="g in groups" :key="g.key" class="group">
        <h2 class="group-title">{{ g.label }}</h2>

        <ul class="list">
          <li v-for="e in g.items" :key="e.id">
            <button type="button" class="row" @click="open(e.id)">
              <span class="row-head">
                <span class="row-title">{{ e.title.trim() || "无题" }}</span>
                <span class="row-day">{{ dayLabel(e.entryDate) }}</span>
              </span>
              <span class="row-snippet">
                <span v-for="(p, i) in snippet(e)" :key="i" :class="{ hit: p.hit }">{{ p.text }}</span>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <button v-if="hasMore" type="button" class="more" :disabled="loading" @click="loadMore">
        {{ loading ? "检简中……" : "再展一卷" }}
      </button>
      <p v-else class="hint">已至卷末</p>
    </template>

    <p v-else class="empty">
      {{ keyword.trim() ? "遍卷未见此语。" : "简册尚空，今日宜落笔。" }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from "vue"
import { useRoute, useRouter } from "vue-router"

import { useEntryList } from "@/composables/useEntryList"
import { highlightParts, type TextPart } from "@/shared/text"
import type { EntryListItem, EntryOrder } from "@/shared/types"

const route = useRoute()
const router = useRouter()

const ORDERS: Array<{ value: EntryOrder; label: string }> = [
  { value: "entryDateDesc", label: "新在前" },
  { value: "entryDateAsc", label: "旧在前" },
  { value: "updatedAtDesc", label: "近改动" },
]

const { keyword, order, items, total, loading, hasMore, reload, loadMore } = useEntryList()

// 关键词与地址栏同步，方便刷新后仍在同一次检索里，也方便把结果链接发给自己。
// 用 replace 而不是 push：否则每敲一个字都会往历史栈里塞一条，后退键要按十几次。
onMounted(() => {
  const q = route.query.q
  if (typeof q === "string" && q) keyword.value = q
  void reload()
})

watch(keyword, (v) => {
  const q = v.trim()
  void router.replace({ query: q ? { q } : {} })
})

function open(id: string): void {
  void router.push(`/entry/${id}`)
}

function snippet(e: EntryListItem): TextPart[] {
  return highlightParts(e.contentText, keyword.value)
}

function dayLabel(entryDate: string): string {
  const [, m, d] = entryDate.split("-")
  return `${Number(m)}月${Number(d)}日`
}

/** 按月分组。仅对「已载入的这些」分组，不额外查库 */
const groups = computed(() => {
  const out: Array<{ key: string; label: string; items: EntryListItem[] }> = []

  for (const e of items.value) {
    const key = e.entryDate.slice(0, 7)
    const last = out[out.length - 1]
    if (last && last.key === key) {
      last.items.push(e)
    } else {
      const [y, m] = key.split("-")
      out.push({ key, label: `${y} 年 ${Number(m)} 月`, items: [e] })
    }
  }

  return out
})
</script>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.page-title {
  margin: 0;
  font-family: var(--font-cn-serif);
  font-size: 20px;
  line-height: 1.4;
  color: var(--color-ink);
}

.plain {
  padding: 6px 2px;
  border: none;
  background: none;
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.accent {
  color: var(--color-bamboo);
}

.search {
  width: 100%;
  margin: 12px 0 8px;
  padding: 8px 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: var(--color-paper-deep);
  outline: none;
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink);
}

.search:focus {
  border-color: var(--color-bamboo-soft);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.orders {
  display: flex;
  gap: 4px;
}

.chip {
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-card);
  background: transparent;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.chip.on {
  color: #fff;
  background: var(--color-bamboo);
}

.count,
.hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-ink-faint);
}

.hint {
  margin: 16px 0;
  text-align: center;
}

.group-title {
  margin: 20px 0 6px;
  font-family: var(--font-cn-serif);
  font-size: 12px;
  font-weight: normal;
  line-height: 1.6;
  color: var(--color-ink-faint);
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: block;
  width: 100%;
  padding: 10px 0;
  border: none;
  border-bottom: 1px solid var(--line-soft);
  background: none;
  text-align: left;
  cursor: pointer;
}

.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.row-title {
  font-family: var(--font-cn-serif);
  font-size: 20px;
  line-height: 1.4;
  color: var(--color-ink);
}

.row-day {
  flex: none;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-ink-faint);
}

.row-snippet {
  display: block;
  margin-top: 2px;
  overflow: hidden;
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink-soft);
  /* 摘要最多两行，长日记不至于把列表撑开 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.row-snippet .hit {
  color: var(--color-bamboo);
}

.more {
  display: block;
  width: 100%;
  margin: 20px 0;
  padding: 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-card);
  background: none;
  font-family: var(--font-cn-kai);
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-ink-soft);
  cursor: pointer;
}

.empty {
  margin: 48px 0;
  font-family: var(--font-cn-kai);
  font-size: 15px;
  line-height: 1.7;
  text-align: center;
  color: var(--color-ink-faint);
}
</style>
