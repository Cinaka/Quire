<template>
  <main class="mx-auto w-full max-w-2xl px-4 py-4">
    <header class="head">
      <button type="button" class="plain" @click="router.push('/sync')">云笺</button>
      <h1>登录设备</h1>
      <span class="spacer" />
    </header>

    <section class="card">
      <div class="section-head">
        <h2>有效会话</h2>
        <button v-if="sessions.length > 1" type="button" :disabled="busy" @click="revokeOthers">
          退出其他设备
        </button>
      </div>
      <p v-if="loading" class="note">正在读取……</p>
      <p v-else-if="!sessions.length" class="note">没有可用会话，请重新登录。</p>
      <article v-for="item in sessions" :key="item.id" class="session">
        <div>
          <strong>{{ item.current ? "当前设备" : "其他设备" }}</strong>
          <p>登录于 {{ formatTime(item.createdAt) }}</p>
          <p>有效至 {{ formatTime(item.expiresAt) }}</p>
        </div>
        <button type="button" class="danger" :disabled="busy" @click="revoke(item)">
          {{ item.current ? "退出" : "撤销" }}
        </button>
      </article>
      <p v-if="message" class="message">{{ message }}</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue"
import { useRouter } from "vue-router"

import {
  listDeviceSessions,
  logout,
  revokeDeviceSession,
  revokeOtherSessions,
  type DeviceSession,
} from "@/api/session"

const router = useRouter()
const sessions = ref<DeviceSession[]>([])
const loading = ref(true)
const busy = ref(false)
const message = ref("")

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function load(): Promise<void> {
  loading.value = true
  try {
    sessions.value = await listDeviceSessions()
  } finally {
    loading.value = false
  }
}

async function revoke(item: DeviceSession): Promise<void> {
  const text = item.current ? "退出当前设备？" : "撤销这个设备的登录会话？"
  if (!window.confirm(text)) return
  busy.value = true
  try {
    if (item.current) {
      await logout()
      await router.replace("/auth")
      return
    }
    await revokeDeviceSession(item.id)
    message.value = "设备会话已撤销。"
    await load()
  } finally {
    busy.value = false
  }
}

async function revokeOthers(): Promise<void> {
  if (!window.confirm("退出除当前设备以外的所有设备？")) return
  busy.value = true
  try {
    const count = await revokeOtherSessions()
    message.value = `已撤销 ${count} 个其他设备会话。`
    await load()
  } finally {
    busy.value = false
  }
}

onMounted(() => void load())
</script>

<style scoped>
.head, .section-head, .session { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h1, h2 { margin: 0; font-family: var(--font-cn-serif); font-weight: normal; font-size: 20px; }
.spacer { width: 32px; }
.plain { padding: 6px 2px; border: 0; background: none; color: var(--color-ink-soft); cursor: pointer; }
.card { margin-top: 16px; padding: 14px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: var(--color-paper-deep); }
.session { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.session strong { color: var(--color-ink); font-size: 14px; }
.session p, .note, .message { margin: 4px 0; color: var(--color-ink-faint); font-size: 12px; line-height: 1.5; }
.message { color: var(--color-bamboo); }
button { padding: 7px 10px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: transparent; color: var(--color-ink-soft); cursor: pointer; }
button.danger { color: var(--color-ji); }
button:disabled { opacity: 0.5; cursor: default; }
</style>
