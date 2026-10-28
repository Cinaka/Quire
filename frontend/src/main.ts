import "@/styles/index.css"
import { prepareUuid32Storage } from "@/db/uuid32Storage"

async function start(): Promise<void> {
  const root = document.getElementById("app")
  if (root) root.textContent = "正在检查本地库。若升级等待其他连接，请关闭其他青简标签页及旧版页面；此时不会启动后台同步。"
  try {
    const ready = await prepareUuid32Storage(() => window.confirm(
      "UUID32 本地切换：请先关闭其他青简标签页及旧版页面。继续将永久清空此站点浏览器中的测试日记、图片、标签、日程、草稿、离线队列和同步状态，并退出本机登录。不会删除服务器数据。确定以全新本地库开始吗？取消不会清空或启动自动同步。",
    ))
    if (!ready) { stopped("已取消切换，未清空本地数据。请勿打开旧版页面继续同步。"); return }
    // Importing the old entry only AFTER reset prevents hooks/router/background work racing it.
    try { await import("./bootstrap") }
    catch { stopped("应用加载失败，请关闭此页面并重新打开；不要退回旧版继续写入。") }
  } catch (error) {
    stopped(`初始化失败，应用及后台同步尚未启动：${error instanceof Error ? error.message : "无法访问本地数据库"}`)
  }
}
function stopped(message: string): void {
  const root = document.getElementById("app")
  if (!root) return
  root.replaceChildren()
  const text = document.createElement("p"), retry = document.createElement("button")
  text.textContent = message
  retry.textContent = "重新检查"
  retry.onclick = () => window.location.reload()
  root.append(text, retry)
}
void start()
