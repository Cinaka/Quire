<template>
  <main class="mx-auto w-full max-w-md px-4 py-10">
    <header class="intro">
      <p class="eyebrow">青简 · Quire</p>
      <h1>{{ registering ? "注册新账号" : "登录青简" }}</h1>
      <p>本地日记仍以浏览器为权威，登录后只做安全备份与多设备同步。</p>
    </header>

    <form class="card" @submit.prevent="submit">
      <label>
        邮箱
        <input v-model.trim="email" type="email" autocomplete="email" required />
      </label>
      <label>
        密码
        <input v-model="password" type="password" minlength="8" autocomplete="current-password" required />
      </label>
      <label v-if="registering">
        再输一次密码
        <input v-model="confirmPassword" type="password" minlength="8" autocomplete="new-password" required />
      </label>
      <p v-if="error" class="error">{{ error }}</p>
      <button type="submit" :disabled="busy">{{ busy ? "处理中……" : registering ? "注册并同步" : "登录并同步" }}</button>
      <button type="button" class="secondary" :disabled="busy" @click="registering = !registering">
        {{ registering ? "已有账号？去登录" : "没有账号？去注册" }}
      </button>
    </form>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { useRouter } from "vue-router"

import { claimLocalData, resetLocalForNewOwner } from "@/api/claim"
import { login, register } from "@/api/session"
import { runSync } from "@/api/sync"

const router = useRouter()
const email = ref("")
const password = ref("")
const confirmPassword = ref("")
const registering = ref(false)
const busy = ref(false)
const error = ref("")

async function submit(): Promise<void> {
  error.value = ""
  if (registering.value && password.value !== confirmPassword.value) {
    error.value = "两次输入的密码不一致。"
    return
  }
  busy.value = true
  try {
    const user = registering.value
      ? await register(email.value, password.value)
      : await login(email.value, password.value)
    const claim = await claimLocalData(user.id)
    if (claim.kind === "ownerMismatch") {
      const clear = window.confirm("当前浏览器已有另一个账号的数据。确定导出备份并清空本地，改用当前账号吗？")
      if (!clear) throw new Error("已取消切换账号")
      await resetLocalForNewOwner(user.id)
    }
    await runSync()
    await router.push("/")
  } catch (err) {
    error.value = (err as Error).message || "操作失败，请稍后重试。"
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.intro { text-align: center; }
.eyebrow { color: var(--color-bamboo); font-size: 12px; letter-spacing: 0.12em; }
h1 { margin: 10px 0; font-family: var(--font-cn-serif); font-weight: normal; font-size: 28px; }
.intro p:last-child { color: var(--color-ink-faint); font-size: 12px; line-height: 1.7; }
.card { display: grid; gap: 14px; margin-top: 24px; padding: 18px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: var(--color-paper-deep); }
label { display: grid; gap: 6px; color: var(--color-ink-soft); font-size: 12px; }
input { width: 100%; padding: 10px; border: 1px solid var(--line-soft); border-radius: var(--radius-card); background: var(--color-paper); color: var(--color-ink); }
button { padding: 10px; border: 1px solid var(--color-bamboo); border-radius: var(--radius-card); background: var(--color-bamboo); color: #fff; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.secondary { border-color: var(--line-soft); background: transparent; color: var(--color-ink-soft); }
.error { margin: 0; color: var(--color-ji); font-size: 12px; line-height: 1.6; }
</style>
