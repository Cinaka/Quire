import { assertAcceptanceLocation, type AcceptanceSpec } from "./guard"
import { preflightAcceptanceDb } from "./preflight"
declare const __QUIRE_P4_ACCEPTANCE__: boolean
declare const __QUIRE_P4_DAILY_ORIGIN__: string
declare const __QUIRE_P4_TEST_ORIGIN__: string
const root = document.getElementById("acceptance-root")
const enter = document.getElementById("enter-acceptance") as HTMLButtonElement | null
const confirmed = document.getElementById("confirm-isolation") as HTMLInputElement | null
const status = document.getElementById("acceptance-status")
let spec: AcceptanceSpec | null = null
try {
  spec = assertAcceptanceLocation({ enabled: typeof __QUIRE_P4_ACCEPTANCE__ !== "undefined" && __QUIRE_P4_ACCEPTANCE__,
    dailyOrigin: typeof __QUIRE_P4_DAILY_ORIGIN__ === "undefined" ? "" : __QUIRE_P4_DAILY_ORIGIN__,
    testOrigin: typeof __QUIRE_P4_TEST_ORIGIN__ === "undefined" ? "" : __QUIRE_P4_TEST_ORIGIN__ }, window.location)
  if (status) status.textContent = `日常 ${spec.dailyOrigin}；隔离 ${spec.testOrigin}。确认后仅进入专用验收库。`
} catch (error) { if (status) status.textContent = String(error); if (enter) enter.disabled = true }
enter?.addEventListener("click", async () => {
  if (!enter || !spec || !root || !confirmed?.checked || enter.disabled) return
  enter.disabled = true
  try {
    const pin = assertAcceptanceLocation(spec, window.location)
    if (localStorage.getItem("quire_access_token")) throw new Error("验收origin已有token，拒绝进入；不删除凭据")
    await preflightAcceptanceDb(indexedDB, pin)
    assertAcceptanceLocation(pin, window.location)
    // 所有业务/Vue/Dexie导入均在明确确认及只读预检之后；不加载原main、router或后台同步。
    const { mountAcceptance } = await import("./mount")
    await mountAcceptance(root, pin)
    document.getElementById("acceptance-gate")?.remove()
  } catch (error) { if (status) status.textContent = String(error); enter.disabled = false }
})
