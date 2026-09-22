import "@/styles/index.css"

import { createApp } from "vue"

import { setUnauthorizedHandler } from "@/api/request"
import { isLoggedIn } from "@/api/session"
import { runSync } from "@/api/sync"
import { emitBackgroundSync } from "@/api/syncEvents"
import { db } from "@/db/schema"
import * as repo from "@/repo"
import App from "./App.vue"
import router from "./router"

const app = createApp(App)
app.use(router)
app.mount("#app")

setUnauthorizedHandler(() => {
  if (router.currentRoute.value.name !== "auth") void router.push({ name: "auth" })
})

void repo.mediaRepo
  .reconcileAll()
  .then((reconciled) => repo.mediaRepo.purgeOrphans().then((purged) => ({ reconciled, purged })))
  .then(({ reconciled, purged }) => {
    if (import.meta.env.DEV && reconciled > 0) {
      console.info(`[quire] 已校正 ${reconciled} 条图片关联`)
    }
    if (import.meta.env.DEV && purged > 0) {
      console.info(`[quire] 已清理 ${purged} 张孤儿图片`)
    }
  })
  .catch((err) => console.warn("[quire] 图片对账 / 孤儿清理失败", err))

let syncTimer: number | null = null
let retryDelay = 15_000
const MAX_RETRY_DELAY = 5 * 60_000

function scheduleSync(delay = 5_000): void {
  if (!isLoggedIn()) return
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    syncTimer = null
    void runBackgroundSync()
  }, delay)
}

async function runBackgroundSync(): Promise<void> {
  if (!isLoggedIn()) return
  if (!navigator.onLine) {
    emitBackgroundSync({ phase: "offline" })
    return
  }
  emitBackgroundSync({ phase: "running" })
  try {
    await runSync()
    retryDelay = 15_000
    emitBackgroundSync({ phase: "success" })
  } catch (error) {
    const retryInSeconds = Math.round(retryDelay / 1000)
    const message = (error as Error).message
    emitBackgroundSync({ phase: "error", message, retryInSeconds })
    console.warn(`[quire] 后台同步失败，将在 ${retryInSeconds} 秒后重试`, error)
    scheduleSync(retryDelay)
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
  }
}

// 所有本地写操作统一触发五秒 debounce。同步引擎自己造成的 dirty 清零也会
// 触发一次，但下一轮没有待推数据，会立即结束，不会形成请求风暴。
db.entries.hook("creating", () => scheduleSync())
db.entries.hook("updating", () => scheduleSync())
db.entries.hook("deleting", () => scheduleSync())
db.tags.hook("creating", () => scheduleSync())
db.tags.hook("updating", () => scheduleSync())
db.tags.hook("deleting", () => scheduleSync())
db.media.hook("creating", () => scheduleSync())
db.media.hook("updating", () => scheduleSync())
db.media.hook("deleting", () => scheduleSync())

if (isLoggedIn()) scheduleSync(0)
window.addEventListener("offline", () => emitBackgroundSync({ phase: "offline" }))
window.addEventListener("online", () => {
  retryDelay = 15_000
  scheduleSync(0)
})
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleSync(0)
})
window.setInterval(() => {
  if (document.visibilityState === "visible") scheduleSync(0)
}, 5 * 60_000)

if (import.meta.env.DEV) {
  Object.assign(window, { $repo: repo, $runSync: runSync })
  void import("@/shared/almanac").then((module) => {
    Object.assign(window, { $almanac: module.getAlmanac })
  })
}
