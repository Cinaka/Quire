import { createApp, h, nextTick, ref, shallowRef } from "vue"
import NotebookReadingPane from "../../src/components/notebook/NotebookReadingPane.vue"
import { createLocalNotebookReadPort } from "../../src/db/notebookReadRepo"
import type { NotebookReadPort } from "../../src/db/notebookReadCore"
import { db, OWNER, EPOCH } from "./store"
import { fixtures, FIRST, SECOND, DELETED, MEDIA } from "./fixtures"

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(work: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 12000
  while (Date.now() < end) { if (work()) return; await delay(40) }
  throw new Error(`超时：${message}（保持标签页前台，排除后台节流后再核对）`)
}
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(x => x.toString(16).padStart(2, "0")).join("")
async function canonical(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return { type: value.type, size: value.size, sha256: hex(await crypto.subtle.digest("SHA-256", await value.arrayBuffer())) }
  if (Array.isArray(value)) return Promise.all(value.map(canonical))
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) result[key] = await canonical((value as Record<string, unknown>)[key])
    return result
  }
  return value
}
async function snapshot(): Promise<string> {
  // Capture all tables consistently; hash Blob bytes after the read transaction.
  const rows = await db.transaction("r", db.tables, async () => {
    const result: Record<string, unknown> = {}
    for (const table of db.tables) result[table.name] = await table.orderBy(":id").toArray()
    return result
  })
  return JSON.stringify(await canonical(rows))
}
export async function run(): Promise<void> {
  const report: { scope: string; database: string; browser: string; results: { name: string; passed: boolean; error?: string }[]; complete: boolean; urlsCreated: number; urlsRemaining: number; writeAttempts: unknown[]; intentionalEpochWrites: number; limitations: string[] } = {
    scope: "真实Vue/IndexedDB/生产读取适配器；模拟身份和固定材料；非正式入口",
    database: db.name, browser: navigator.userAgent, results: [], complete: false,
    urlsCreated: 0, urlsRemaining: 0, writeAttempts: [], intentionalEpochWrites: 0,
    limitations: ["身份/token/owner读取由测试模块提供，未验证/auth/me/JWT或跨账号正式接线", "未覆盖正式列表、同步、其他未运行的浏览器、真实私人日记和全库恢复", "字体/性能和正式生命周期留待P5-2/3集成验收"],
  }
  const output = document.querySelector<HTMLElement>("#report")!, status = document.querySelector<HTMLElement>("#status")!
  let watchWrites = false, subscriptions = 0
  const writes: { table: string; type: string }[] = []
  const liveUrls = new Set<string>(), ports: NotebookReadPort[] = []
  const makeUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL
  URL.createObjectURL = blob => { const url = makeUrl.call(URL, blob); liveUrls.add(url); report.urlsCreated++; return url }
  URL.revokeObjectURL = url => { liveUrls.delete(url); revokeUrl.call(URL, url) }
  db.use({ stack: "dbcore", name: "p5-test-write-audit", create: down => ({
    ...down, table(name) { const table = down.table(name); return { ...table, mutate(request) {
      if (watchWrites) writes.push({ table: name, type: request.type })
      return table.mutate(request)
    } } },
  }) })
  const visible = ref(false), ids = shallowRef<readonly string[]>([]), currentPort = shallowRef<NotebookReadPort>()
  const app = createApp({ render: () => visible.value && currentPort.value
    ? h(NotebookReadingPane, { port: currentPort.value, entryIds: ids.value }) : h("p", "阅读组件已卸载") })
  const container = document.querySelector<HTMLElement>("#reader")!
  const text = () => container.textContent ?? ""
  function tracked(port: NotebookReadPort): NotebookReadPort {
    const subscribe = (call: () => () => void) => {
      const stop = call(); subscriptions++; let stopped = false
      return () => { if (!stopped) { stopped = true; subscriptions--; stop() } }
    }
    return { ...port,
      subscribe: (...args) => subscribe(() => port.subscribe(...args)),
      subscribeMedia: (...args) => subscribe(() => port.subscribeMedia(...args)),
    }
  }
  function newPort(): NotebookReadPort {
    const port = createLocalNotebookReadPort({ ownerUserId: OWNER, generation: EPOCH, authGeneration: 1 })
    ports.push(port); return tracked(port)
  }
  async function show(entryIds: readonly string[], port = currentPort.value!): Promise<void> {
    currentPort.value = port; ids.value = entryIds; visible.value = true; await nextTick()
  }
  async function idle(): Promise<void> {
    await until(() => container.querySelector('[aria-busy="false"]') !== null, "正文读取结束")
    await delay(160)
    container.querySelector(".notebook-image")?.scrollIntoView({ block: "start" })
  }
  async function check(name: string, work: () => Promise<void>): Promise<void> {
    status.textContent = `验证中：${name}`
    try { await work(); report.results.push({ name, passed: true }) }
    catch (error) { report.results.push({ name, passed: false, error: error instanceof Error ? error.message : "未知错误" }); throw error }
    finally { output.textContent = JSON.stringify(report, null, 2) }
  }
  const noWrites = async (before: string) => {
    assert(await snapshot() === before, "阅读前后全部业务表（含Blob字节）不一致")
    assert(writes.length === 0, "阅读期间出现写入尝试")
  }
  let mounted = false
  try {
    assert(document.visibilityState === "visible" && innerHeight >= 480, "请保持页面在前台且窗口高度至少480px")
    assert(/^quire-p5-readcheck-/.test(db.name), "拒绝打开非测试库")
    await db.open()
    const fixed = fixtures()
    await db.transaction("rw", db.tables, async () => {
      await db.entries.bulkAdd(fixed.entries); await db.media.bulkAdd(fixed.media)
      await db.meta.bulkAdd([{ key: "ownerUserId", value: OWNER }, { key: "ownerGeneration", value: EPOCH }, { key: "syncCursor", value: "fixed-do-not-change" }, { key: "p4-fixture-intent", value: { pending: true } }])
    })
    watchWrites = true
    const before = await snapshot(), port = newPort()
    app.mount(container); mounted = true
    await check("真实读取事务：dirty正文、原图、已有缩略图、缺失与软删", async () => {
      const entry = await port.readEntry(FIRST)
      assert(entry?.dirty === 1, "dirty日记应可读")
      const original = await port.readMedia(entry, MEDIA[0]), thumb = await port.readMedia(entry, MEDIA[1]), missing = await port.readMedia(entry, MEDIA[2])
      assert(original.state === "ready" && !original.thumbnailOnly, "原图读取失败")
      assert(thumb.state === "ready" && thumb.thumbnailOnly, "没有明确使用已有缩略图")
      assert(missing.state === "missing", "缺失图片误报")
      assert(await port.readEntry(DELETED) === undefined, "软删日记未排除")
      await noWrites(before)
    })
    await check("真实Vue挂载：长文完整、文字转义与本机图片解码", async () => {
      await show([FIRST], port); await idle()
      await until(() => container.querySelectorAll("img").length === 2 && [...container.querySelectorAll("img")].every(image => image.complete && image.naturalWidth > 0), "两张本机图片解码")
      assert(text().includes("末段完整标记") && text().includes("<script>这必须是文字</script>"), "长文或转义文字缺失")
      assert(!container.querySelector("script"), "正文被注入脚本")
      assert(text().includes("仅有本机缩略图") && text().includes("本机图片未就绪"), "图片降级/缺失提示不完整")
      assert([...container.querySelectorAll("img")].every(image => image.src.startsWith("blob:")), "出现非本机Object URL图片")
      await noWrites(before)
    })
    await check("真实IntersectionObserver：离开可见区回收、返回重读", async () => {
      window.scrollTo(0, document.body.scrollHeight)
      await until(() => liveUrls.size === 0, "滚动离开图片后URL回收")
      container.querySelector(".notebook-image")?.scrollIntoView({ block: "start" })
      await until(() => liveUrls.size === 2 && container.querySelectorAll("img").length === 2, "返回图片后重新读取")
      await noWrites(before)
    })
    await check("真实组件换篇：旧图回收、未知版本与安全文本保留", async () => {
      await show([SECOND]); await idle()
      assert(text().includes("乙篇独有标记") && text().includes("未知节点的安全文字"), "未知内容没有保留可读信息")
      assert(container.querySelector('[role="note"]'), "未知版本缺少明确诊断")
      assert(!text().includes("首段标记") && liveUrls.size === 0, "换篇后保留旧正文/URL")
      await noWrites(before)
    })
    await check("真实组件软删空态", async () => {
      await show([DELETED]); await idle()
      assert(!container.querySelector("article") && text().includes("不再可读"), "软删记录仍显示")
      await noWrites(before)
    })
    await check("迟到读取：真实DB读取后延迟旧结果，不覆盖新篇", async () => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const slow: NotebookReadPort = { ...port, readEntry: async id => { const entry = await port.readEntry(id); if (id === FIRST) await gate; return entry } }
      try {
        await show([FIRST], slow); await delay(120)
        await show([SECOND], slow); await idle()
      } finally { release() }
      await delay(200)
      assert(text().includes("乙篇独有标记") && !text().includes("首段标记"), "迟到正文覆盖当前篇")
      await noWrites(before)
    })
    await check("关闭端口：已显示正文、URL与观察订阅清理", async () => {
      await show([FIRST], port); await idle()
      await until(() => liveUrls.size === 2, "显示图片")
      port.close()
      await until(() => !container.querySelector("article") && liveUrls.size === 0, "close清屏和URL释放")
      let rejected = false
      try { await port.readEntry(FIRST) } catch { rejected = true }
      assert(rejected, "关闭后仍允许读取")
      visible.value = false; await nextTick()
      assert(subscriptions === 0, "组件卸载后仍有订阅")
      await noWrites(before)
    })
    await check("真实meta代际变化：liveQuery触发失效，不保留旧正文", async () => {
      const fresh = newPort(); await show([FIRST], fresh); await idle()
      await until(() => liveUrls.size === 2, "新端口显示图片")
      // Audit the single explicit fixture mutation too; no blind write-audit window.
      const expected = JSON.parse(before) as { meta: { key: string; value: unknown }[] }
      const epoch = expected.meta.find(row => row.key === "ownerGeneration")
      assert(epoch, "缺少测试代际")
      epoch.value = "explicit-test-epoch-change"
      await db.meta.put({ key: "ownerGeneration", value: epoch.value })
      assert(writes.length === 1 && writes[0]?.table === "meta" && writes[0]?.type === "put", "代际测试出现额外写入尝试")
      report.intentionalEpochWrites = 1
      writes.length = 0
      const afterExplicitChange = JSON.stringify(expected)
      await until(() => !container.querySelector("article") && liveUrls.size === 0, "代际变化清屏")
      await noWrites(afterExplicitChange)
    })
    await check("没有API/云媒体请求与最终卸载零泄漏", async () => {
      visible.value = false; await nextTick(); ports.forEach(port => port.close())
      await delay(200)
      assert(liveUrls.size === 0 && subscriptions === 0, "最终URL/订阅未清理")
      const forbidden = performance.getEntriesByType("resource").filter(item => /\/(?:api|media)\//.test(new URL(item.name, location.href).pathname))
      assert(forbidden.length === 0, "阅读触发了API或云媒体请求")
      assert(writes.length === 0, "出现非夹具写入尝试")
    })
    report.complete = true
    status.textContent = "9项测试已通过（仅本测试范围）。复制下方报告并保留；不等于P5整体验收通过。"
  } catch (error) {
    status.textContent = `验证失败或未完成：${error instanceof Error ? error.message : "未知错误"}`
  } finally {
    try { if (mounted) app.unmount() } finally {
      ports.forEach(port => port.close()); db.close()
      report.urlsRemaining = liveUrls.size; report.writeAttempts = [...writes]
      for (const url of liveUrls) revokeUrl.call(URL, url)
      URL.createObjectURL = makeUrl; URL.revokeObjectURL = revokeUrl
      output.textContent = JSON.stringify(report, null, 2)
    }
  }
}
