<template>
  <main class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="head">
      <button type="button" class="plain" @click="router.push('/sync')">云笺</button>
      <h1>同步问题</h1>
      <span class="spacer" />
    </header>

    <section class="card">
      <div class="section-head">
        <h2>待处理上传</h2>
        <button v-if="pending.length" type="button" :disabled="busy" @click="retryAll">
          {{ busy ? "同步中……" : "重新同步" }}
        </button>
      </div>
      <p v-if="!pending.length" class="note">暂无待上传项目。</p>
      <article v-for="item in pending" :key="`${item.kind}:${item.id}`" class="issue">
        <strong>{{ item.label }}</strong>
        <p>{{ kindLabel(item.kind) }} · {{ item.detail }}</p>
        <code>{{ item.id }}</code>
      </article>
    </section>

    <section class="card">
      <h2>冲突留档</h2>
      <p v-if="!conflicts.length" class="note">暂无冲突。</p>
      <article v-for="item in conflicts" :key="`${item.entryId}:${item.at}`" class="issue">
        <strong>{{ item.local.title || item.server?.title || "无题" }}</strong>
        <p>本地编辑于 {{ item.local.clientUpdatedAt }}</p>
        <p v-if="item.server">云端编辑于 {{ item.server.clientUpdatedAt }}</p>
        <p v-else>云端版本尚未拉取；可以先保留本地并重新上传。</p>
        <div class="actions">
          <button type="button" @click="resolve(item.entryId, 'local')">保留本地</button>
          <button v-if="item.server" type="button" class="danger" @click="resolve(item.entryId, 'server')">采用云端</button>
        </div>
      </article>
    </section>

    <section class="card">
      <h2>同步错误</h2>
      <p v-if="!errors.length" class="note">暂无错误。</p>
      <article v-for="item in errors" :key="`${item.kind}:${item.id}`" class="issue">
        <strong>{{ item.kind }} · {{ item.id }}</strong>
        <p>{{ item.message || "未知错误" }} · 已尝试 {{ item.count }} 次</p>
        <p v-if="item.paused" class="paused">已暂停自动重试，避免持续消耗网络与电量。</p>
        <button type="button" @click="dismiss(item.kind, item.id)">
          {{ item.paused ? "解除暂停并重试" : "清除记录并重试" }}
        </button>
      </article>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue"
import { useRouter } from "vue-router"

import { runSync } from "@/api/sync"
import { syncRepo, type PendingSyncItem, type SyncConflict, type SyncErrorItem } from "@/repo"

const router = useRouter()
const pending = ref<PendingSyncItem[]>([])
const conflicts = ref<SyncConflict[]>([])
const errors = ref<SyncErrorItem[]>([])
const busy = ref(false)

function kindLabel(kind: PendingSyncItem["kind"]): string {
  return { entry: "日记", tag: "标签", media: "图片" }[kind]
}

async function load(): Promise<void> {
  const [nextPending, nextConflicts, nextErrors] = await Promise.all([
    syncRepo.pending(), syncRepo.conflicts(), syncRepo.errors(),
  ])
  pending.value = nextPending
  conflicts.value = nextConflicts
  errors.value = nextErrors
}

async function retryAll(): Promise<void> {
  busy.value = true
  try { await runSync(); await load() } finally { busy.value = false }
}

async function resolve(entryId: string, strategy: "local" | "server"): Promise<void> {
  const label = strategy === "local" ? "保留本地版本" : "采用云端版本"
  if (!window.confirm(`确定${label}？另一版本会从冲突列表移除。`)) return
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
.head, .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h1, h2 { margin: 0; font-family: var(--font-cn-serif); font-weight: normal; font-size: 20px; }
.spacer { width: 32px; }
.plain { padding: 6px 2px; border: 0; background: none; color: var(--color-ink-soft); cursor: pointer; }
.card { margin-top: 16px; padding: 14px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: var(--color-paper-deep); }
.issue { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.issue strong { color: var(--color-ink); font-size: 15px; overflow-wrap: anywhere; }
.issue p, .note { margin: 6px 0; color: var(--color-ink-faint); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.issue code { color: var(--color-ink-faint); font-size: 10px; overflow-wrap: anywhere; }
.paused { color: var(--color-ji) !important; }
.actions { display: flex; gap: 8px; }
button { padding: 7px 10px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: transparent; color: var(--color-ink-soft); cursor: pointer; }
button.danger { color: var(--color-ji); }
button:disabled { opacity: 0.5; cursor: default; }
</style>
