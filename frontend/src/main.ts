import "@/styles/index.css"

import { createApp } from "vue"

import { runSync } from "@/api/sync"
import { isLoggedIn } from "@/api/session"
import { setUnauthorizedHandler } from "@/api/request"
import App from "./App.vue"
import router from "./router"
import * as repo from "@/repo"

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
    if (import.meta.env.DEV && reconciled > 0) console.info(`[quire] 已校正 ${reconciled} 条图片关联`)
    if (import.meta.env.DEV && purged > 0) console.info(`[quire] 已清理 ${purged} 张孤儿图片`)
  })
  .catch((err) => console.warn("[quire] 图片对账 / 孤儿清理失败", err))

let syncTimer: number | null = null
function scheduleSync(delay = 5_000): void {
  if (!isLoggedIn()) return
  if (syncTimer !== null) window.clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    syncTimer = null
    void runSync()
  }, delay)
}

if (isLoggedIn()) void runSync()
window.addEventListener("online", () => scheduleSync(0))
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleSync(0)
})
window.setInterval(() => {
  if (document.visibilityState === "visible") scheduleSync(0)
}, 5 * 60_000)

if (import.meta.env.DEV) {
  Object.assign(window, { $repo: repo, $runSync: runSync })
  void import("@/shared/almanac").then((m) => Object.assign(window, { $almanac: m.getAlmanac }))
}
