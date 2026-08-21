import "@/styles/index.css"

import { createApp } from "vue"
import { createPinia } from "pinia"
import piniaPersist from "pinia-plugin-persistedstate"

import App from "./App.vue"
import router from "./router"

// 静态导入整个 repo 命名空间：既给下面的 purgeOrphans 用，
// 也让 DEV 调试句柄不再需要顶层 await import()
import * as repo from "@/repo"

const pinia = createPinia()
pinia.use(piniaPersist)

// 拆开链式调用，才能在 mount 之后继续往下写
const app = createApp(App)
app.use(pinia)
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
  .purgeOrphans()
  .then((n) => {
    if (import.meta.env.DEV && n > 0) console.info(`[quire] 已清理 ${n} 张孤儿图片`)
  })
  .catch((err) => {
    console.warn("[quire] purgeOrphans 失败", err)
  })

// DEV 调试句柄。P1 收尾前整块删除（索引页第七节有这条待办）
if (import.meta.env.DEV) {
  Object.assign(window, { $repo: repo, $router: router })
}
