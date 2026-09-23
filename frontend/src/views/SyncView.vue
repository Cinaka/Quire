<template>
  <main class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="head">
      <button type="button" class="plain" @click="router.push('/')">今简</button>
      <h1>云笺</h1>
      <span class="spacer" />
    </header>

    <section class="card">
      <h2>同步状态</h2>
      <template v-if="loggedIn">
        <dl class="kv">
          <div><dt>本地归属</dt><dd>{{ status.ownerUserId || "读取中" }}</dd></div>
          <div><dt>网络状态</dt><dd>{{ networkLabel }}</dd></div>
          <div><dt>上次同步</dt><dd>{{ status.lastSyncAt || "尚未完成" }}</dd></div>
          <div>
            <dt>待上传</dt>
            <dd>
              {{ status.dirtyTotal }} 项
              <small>日记 {{ status.dirtyEntries }} / 标签 {{ status.dirtyTags }} / 图片 {{ status.dirtyMedia }}</small>
            </dd>
          </div>
          <div><dt>冲突留档</dt><dd>{{ status.conflictCount }} 项</dd></div>
          <div><dt>同步错误</dt><dd>{{ status.errorCount }} 项</dd></div>
        </dl>
        <p v-if="message" class="message" :class="{ bad: failed }">{{ message }}</p>
        <button type="button" class="primary" :disabled="busy || backgroundBusy || offline" @click="syncNow">
          {{ busy || backgroundBusy ? "正在同步……" : offline ? "当前离线" : "立即同步" }}
        </button>
        <button
          v-if="status.dirtyTotal || status.conflictCount || status.errorCount"
          type="button"
          class="secondary"
          :disabled="busy || backgroundBusy"
          @click="router.push('/sync/issues')"
        >
          查看待处理项、冲突与错误
        </button>
        <button type="button" class="secondary" :disabled="busy || backgroundBusy" @click="router.push('/sync/sessions')">
          管理登录设备
        </button>
        <button type="button" class="secondary" :disabled="busy || backgroundBusy" @click="signOut">退出登录</button>
      </template>
      <template v-else>
        <p class="note">尚未登录。登录后，本地简册会先备份，再安全上行。</p>
        <button type="button" class="primary" @click="router.push('/auth')">登录或注册</button>
      </template>
    </section>

    <section class="card">
      <h2>本地优先</h2>
      <p class="note">IndexedDB 始终是当前设备的权威副本。同步顺序固定为先推后拉，未上传的本地内容不会被云端覆盖。</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue"
import { useRouter } from "vue-router"

import { isLoggedIn, logout } from "@/api/session"
import { runSync } from "@/api/sync"
import { onBackgroundSync, type BackgroundSyncState } from "@/api/syncEvents"
import { syncRepo, type SyncStatus } from "@/repo"

const router = useRouter()
const loggedIn = ref(isLoggedIn())
const status = ref<SyncStatus>({
  ownerUserId: "",
  lastSyncAt: "",
  dirtyEntries: 0,
  dirtyTags: 0,
  dirtyMedia: 0,
  dirtyTotal: 0,
  conflictCount: 0,
  errorCount: 0,
})
const busy = ref(false)
const backgroundBusy = ref(false)
const offline = ref(!navigator.onLine)
const failed = ref(false)
const message = ref(offline.value ? "当前离线，恢复网络后会自动同步。" : "")
let stopBackgroundEvents: (() => void) | null = null

const networkLabel = computed(() => {
  if (offline.value) return "离线"
  if (busy.value || backgroundBusy.value) return "在线 · 正在同步"
  return "在线"
})

async function refresh(): Promise<void> {
  loggedIn.value = isLoggedIn()
  status.value = await syncRepo.status()
}

async function handleBackgroundState(state: BackgroundSyncState): Promise<void> {
  offline.value = state.phase === "offline" ? true : !navigator.onLine
  backgroundBusy.value = state.phase === "running"
  if (state.phase === "running") {
    failed.value = false
    message.value = "正在后台同步……"
    return
  }
  if (state.phase === "offline") {
    failed.value = true
    message.value = "当前离线，恢复网络后会自动同步。"
    return
  }
  await refresh()
  if (state.phase === "success") {
    failed.value = false
    message.value = status.value.dirtyTotal ? `仍有 ${status.value.dirtyTotal} 项待处理。` : "自动同步完成。"
  } else {
    failed.value = true
    message.value = `后台同步失败：${state.message}；${state.retryInSeconds} 秒后重试。`
  }
}

async function syncNow(): Promise<void> {
  busy.value = true
  failed.value = false
  message.value = ""
  try {
    await runSync()
    await refresh()
    if (status.value.dirtyTotal) {
      message.value = `仍有 ${status.value.dirtyTotal} 项待处理，可打开下方问题页面查看。`
      failed.value = true
    } else if (status.value.conflictCount || status.value.errorCount) {
      message.value = "数据已传输，但仍有冲突或错误记录需要确认。"
      failed.value = true
    } else {
      message.value = "同步完成。"
    }
  } catch (error) {
    failed.value = true
    message.value = `同步失败：${(error as Error).message}`
    await refresh()
  } finally {
    busy.value = false
  }
}

async function signOut(): Promise<void> {
  busy.value = true
  try {
    await logout()
    await refresh()
    await router.push("/auth")
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  stopBackgroundEvents = onBackgroundSync((state) => void handleBackgroundState(state))
  void refresh()
})
onUnmounted(() => stopBackgroundEvents?.())
</script>

<style scoped>
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.head h1, .card h2 { margin: 0; font-family: var(--font-cn-serif); font-weight: normal; color: var(--color-ink); font-size: 20px; }
.spacer { width: 32px; }
.plain { padding: 6px 2px; border: 0; background: none; color: var(--color-ink-soft); cursor: pointer; }
.card { margin-top: 16px; padding: 14px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: var(--color-paper-deep); }
.kv { margin: 10px 0; }
.kv div { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; }
.kv dt { color: var(--color-ink-faint); font-size: 12px; }
.kv dd { margin: 0; max-width: 72%; overflow-wrap: anywhere; color: var(--color-ink); font-size: 12px; text-align: right; }
.kv small { display: block; margin-top: 2px; color: var(--color-ink-faint); }
.note, .message { color: var(--color-ink-faint); font-size: 12px; line-height: 1.6; }
.message { color: var(--color-bamboo); }
.message.bad { color: var(--color-ji); }
.primary, .secondary { width: 100%; margin-top: 8px; padding: 10px; border-radius: var(--radius-card); cursor: pointer; }
.primary { border: 1px solid var(--color-bamboo); background: var(--color-bamboo); color: white; }
.secondary { border: 1px solid var(--line-soft); background: transparent; color: var(--color-ink-soft); }
button:disabled { opacity: 0.5; cursor: default; }
</style>
