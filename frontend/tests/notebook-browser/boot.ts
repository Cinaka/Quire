import { testOrigin } from "./isolation"
const button = document.querySelector<HTMLButtonElement>("#start")!
const status = document.querySelector<HTMLElement>("#status")!
if (!testOrigin(location)) {
  status.textContent = "拒绝运行：只能在 http://127.0.0.1:5183/ 打开；没有导入数据库或业务模块。"
} else {
  button.disabled = false
  button.textContent = "创建随机测试库并运行一次"
  button.addEventListener("click", async () => {
    button.disabled = true
    status.textContent = "验证进行中……"
    const open = indexedDB.open.bind(indexedDB), remove = indexedDB.deleteDatabase.bind(indexedDB)
    indexedDB.open = (name: string, version?: number) => {
      if (!name.startsWith("quire-p5-readcheck-")) throw new Error("测试拒绝打开非测试库")
      return version === undefined ? open(name) : open(name, version)
    }
    indexedDB.deleteDatabase = () => { throw new Error("本验证禁止删除数据库") }
    try { const { run } = await import("./run"); await run() }
    catch (error) { status.textContent = `验证未完成：${error instanceof Error ? error.message : "未知错误"}` }
    finally { indexedDB.open = open; indexedDB.deleteDatabase = remove }
  }, { once: true })
}
