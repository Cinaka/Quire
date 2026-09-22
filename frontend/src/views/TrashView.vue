<template>
  <div class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="head">
      <button type="button" class="plain" @click="router.push('/settings')">设置</button>
      <h1 class="page-title">断简</h1>
      <button v-if="items.length" type="button" class="plain danger" @click="purgeAll">尽弃</button>
    </header>

    <p class="note">残简可复原。彻底弃去会先同步墓碑，确认上云后再从当前设备清除。</p>
    <p v-if="loading && !items.length" class="hint">检简中……</p>

    <template v-else-if="items.length">
      <ul class="list">
        <li v-for="e in items" :key="e.id" class="row">
          <div class="row-main">
            <span class="row-title">{{ e.title.trim() || "无题" }}</span>
            <span class="row-meta">{{ dayLabel(e.entryDate) }} · 弃于 {{ deletedLabel(e) }}</span>
            <span class="row-snippet">{{ digest(e) }}</span>
          </div>
          <div class="row-act">
            <button type="button" class="plain accent" @click="restore(e.id)">复原</button>
            <button type="button" class="plain danger" @click="purge(e.id)">弃去</button>
          </div>
        </li>
      </ul>
      <button v-if="hasMore" type="button" class="more" :disabled="loading" @click="loadMore">
        {{ loading ? "检简中……" : "再展一卷" }}
      </button>
      <p v-else-if="page > 1" class="end">已至卷末</p>
    </template>
    <p v-else class="empty">断简无残卷。</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue"
import { useRouter } from "vue-router"

import { useEntryList } from "@/composables/useEntryList"
import { entryRepo } from "@/repo"
import { formatLocal } from "@/shared/time"
import type { EntryListItem } from "@/shared/types"

const router = useRouter()
const { items, loading, hasMore, page, reload, loadMore } = useEntryList({ onlyDeleted: true })

onMounted(() => { void reload() })

function dayLabel(entryDate: string): string {
  const [, m, d] = entryDate.split("-")
  return `${Number(m)}月${Number(d)}日`
}

function deletedLabel(e: EntryListItem): string {
  return e.deletedAt ? formatLocal(e.deletedAt) : "—"
}

function digest(e: EntryListItem): string {
  const flat = e.contentText.replace(/\s+/g, " ").trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

async function restore(id: string): Promise<void> {
  await entryRepo.restore(id)
  await reload()
}

async function purge(id: string): Promise<void> {
  if (!window.confirm("彻底弃去这一简？确认同步后，本机正文与图片将不可复原。")) return
  await entryRepo.purge(id)
  await reload()
}

async function purgeAll(): Promise<void> {
  if (!window.confirm("清空断简？全部残简会先同步墓碑，之后从本机清除。")) return
  // pendingPurges 会立刻从断简列表隐藏，所以每轮继续读取第一页即可自然前进。
  for (;;) {
    const next = await entryRepo.list({ onlyDeleted: true, pageSize: 50 })
    if (!next.items.length) break
    for (const entry of next.items) await entryRepo.purge(entry.id)
  }
  await reload()
}
</script>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.page-title { margin: 0; font-family: var(--font-cn-serif); font-size: 20px; line-height: 1.4; color: var(--color-ink); }
.plain { padding: 6px 2px; border: none; background: none; font-size: 15px; line-height: 1.7; color: var(--color-ink-soft); cursor: pointer; }
.accent { color: var(--color-bamboo); }
.danger { color: var(--color-ji); }
.note, .hint { margin: 8px 0 4px; font-size: 12px; line-height: 1.6; color: var(--color-ink-faint); }
.hint { margin: 16px 0; text-align: center; }
.list { margin: 0; padding: 0; list-style: none; }
.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line-soft); }
.row-main { min-width: 0; }
.row-title { display: block; font-family: var(--font-cn-serif); font-size: 20px; line-height: 1.4; color: var(--color-ink); }
.row-meta { display: block; font-size: 12px; line-height: 1.6; color: var(--color-ink-faint); }
.row-snippet { display: block; margin-top: 2px; font-size: 15px; line-height: 1.7; color: var(--color-ink-soft); }
.row-act { flex: none; display: flex; gap: 8px; }
.more { display: block; width: 100%; margin: 20px 0; padding: 10px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: none; font-family: var(--font-cn-kai); font-size: 15px; line-height: 1.7; color: var(--color-ink-soft); cursor: pointer; }
.end { margin: 20px 0; font-family: var(--font-cn-kai); font-size: 12px; line-height: 1.6; text-align: center; color: var(--color-ink-faint); }
.empty { margin: 48px 0; font-family: var(--font-cn-kai); font-size: 15px; line-height: 1.7; text-align: center; color: var(--color-ink-faint); }
</style>
