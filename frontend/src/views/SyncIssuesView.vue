<template>
  <main class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="head">
      <button type="button" class="plain" @click="router.push('/sync')">云笺</button>
      <h1>同步问题</h1>
      <span class="spacer" />
    </header>

    <section class="card">
      <h2>冲突留档</h2>
      <p v-if="!conflicts.length" class="note">暂无冲突。</p>
      <article v-for="item in conflicts" :key="`${item.server.id}:${item.at}`" class="issue">
        <strong>{{ item.server.title || "无题" }}</strong>
        <p>{{ item.server.entryDate }} · 云端编辑于 {{ item.server.clientUpdatedAt }}</p>
        <div class="actions">
          <button type="button" @click="resolve(item.server.id, 'local')">保留本地</button>
          <button type="button" class="danger" @click="resolve(item.server.id, 'server')">
            采用云端
          </button>
        </div>
      </article>
    </section>

    <section class="card">
      <h2>同步错误</h2>
      <p v-if="!errors.length" class="note">暂无错误。</p>
      <article v-for="item in errors" :key="`${item.kind}:${item.id}`" class="issue">
        <strong>{{ item.kind }} · {{ item.id }}</strong>
        <p>{{ item.message || "未知错误" }} · 已尝试 {{ item.count }} 次</p>
        <button type="button" @click="dismiss(item.kind, item.id)">清除记录并重试</button>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue"
import { useRouter } from "vue-router"

import { runSync } from "@/api/sync"
import { syncRepo, type SyncConflict, type SyncErrorItem } from "@/repo"

const router = useRouter()
const conflicts = ref<SyncConflict[]>([])
const errors = ref<SyncErrorItem[]>([])

async function load(): Promise<void> {
  const [nextConflicts, nextErrors] = await Promise.all([
    syncRepo.conflicts(),
    syncRepo.errors(),
  ])
  conflicts.value = nextConflicts
  errors.value = nextErrors
}

async function resolve(entryId: string, strategy: "local" | "server"): Promise<void> {
  const label = strategy === "local" ? "保留本地版本" : "采用云端版本"
  if (!window.confirm(`确定${label}？另一版本仍只保留在本次冲突记录中。`)) return
  await syncRepo.resolveConflict(entryId, strategy)
  await runSync()
  await load()
}

async function dismiss(kind: string, id: string): Promise<void> {
  await syncRepo.dismissError(kind, id)
  await runSync()
  await load()
}

onMounted(() => void load())
</script>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h1, h2 { margin: 0; font-family: var(--font-cn-serif); font-weight: normal; font-size: 20px; }
.spacer { width: 32px; }
.plain { padding: 6px 2px; border: 0; background: none; color: var(--color-ink-soft); cursor: pointer; }
.card { margin-top: 16px; padding: 14px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: var(--color-paper-deep); }
.issue { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.issue strong { color: var(--color-ink); font-size: 15px; overflow-wrap: anywhere; }
.issue p, .note { margin: 6px 0; color: var(--color-ink-faint); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.actions { display: flex; gap: 8px; }
button { padding: 7px 10px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: transparent; color: var(--color-ink-soft); cursor: pointer; }
button.danger { color: var(--color-ji); }
</style>
