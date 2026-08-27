import "@/styles/index.css"

import { createApp } from "vue"

import App from "./App.vue"
import router from "./router"
// 静态导入整个 repo 命名空间：既给下面的 purgeOrphans 用，
// 也让 DEV 调试句柄不再需要顶层 await import()
import * as repo from "@/repo"

// 拆开链式调用，才能在 mount 之后继续往下写
const app = createApp(App)
app.use(router)
app.mount("#app")

/**
 * 清理孤儿图片。三个刻意的选择：
 *   1. 放在 mount 之后 —— 它跟首屏渲染没有任何关系，不能让它挡在前面
 *   2. 不 await（fire-and-forget）—— 失败了也不该影响应用启动
 *   3. 默认只清 24 小时之前的 —— 正在另一个标签页里编辑、还没保存的图片
 *      entryId 同样是空串。不设这个窗口就会把它们删掉，用户那边表现为
 *      「图片突然变空白」，且完全无法归因。
 */
void repo.mediaRepo
  .reconcileAll()
  .then((reconciled) =>
    repo.mediaRepo.purgeOrphans().then((purged) => ({ reconciled, purged })),
  )
  .then(({ reconciled, purged }) => {
    if (import.meta.env.DEV && reconciled > 0) {
      console.info(`[quire] 已校正 ${reconciled} 条图片关联`)
    }
    if (import.meta.env.DEV && purged > 0) {
      console.info(`[quire] 已清理 ${purged} 张孤儿图片`)
    }
  })
  .catch((err) => {
    // 对账失败时 then 链不会进入 purge：宁可暂留孤儿，也不能误删正文仍引用的图。
    console.warn("[quire] 图片对账 / 孤儿清理失败", err)
  })

// DEV 调试句柄，生产构建整块摇掉。铁律 10 依赖这两个句柄，P1 阶段保留。
// $router 已删：那是 P1-4 验收组件复用串文 bug 时的一次性工具。
// $almanac 用动态 import 挂：农历库 gzip 98 KB，静态导入会把它拽进 dev 的
// 初始依赖图；也不用顶层 await，那会挂住整个模块求值、拖长 dev 首屏。
if (import.meta.env.DEV) {
  Object.assign(window, { $repo: repo })
  void import("@/shared/almanac").then((m) => {
    Object.assign(window, { $almanac: m.getAlmanac })
  })
}
