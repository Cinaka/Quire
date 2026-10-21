import type { ScheduleSyncIssueSummary } from "./scheduleSyncIssues"
import type { ScheduleHostContext } from "./scheduleHostTypes"
import type { ScheduleSyncPending } from "./scheduleSync"
export interface ScheduleRuntimeCycle { issues?: ScheduleSyncIssueSummary; unsupported: boolean; failed: boolean; blocked: boolean; pending: ScheduleSyncPending | null; more: boolean }
export interface ScheduleRuntimePort {
  capture(): Promise<ScheduleHostContext>
  verify(context: ScheduleHostContext): Promise<void>
  run(context: ScheduleHostContext, active: () => boolean): Promise<ScheduleRuntimeCycle>
  watch(context: ScheduleHostContext, changed: () => void, expired: () => void): () => void
  online(): boolean; foreground(): boolean
  later(work: () => void, milliseconds: number): number; clear(timer: number): void
}
export type ScheduleRuntimePhase = "paused" | "enabling" | "running" | "offline" | "ready" | "pending" | "blocked" | "unsupported" | "error" | "expired"
export interface ScheduleRuntimeState { issues: ScheduleSyncIssueSummary; enabled: boolean; busy: boolean; reviewing: boolean; phase: ScheduleRuntimePhase; pending: ScheduleSyncPending | null; message: string }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** Opt-in, session-only, bounded automatic work. No P2 calls, storage writes or implicit identity recapture. */
export function createScheduleSyncRuntime(port: ScheduleRuntimePort) {
  const state: ScheduleRuntimeState = { issues: { total: 0, omitted: 0, items: [] }, enabled: false, busy: false, reviewing: false, phase: "paused", pending: null, message: "日程同步未启用；本机文字预简仍可使用。" }
  const listeners = new Set<() => void>()
  let context: ScheduleHostContext | null = null, timer: number | null = null, stop: (() => void) | null = null
  let generation = 0, changed = false, retries = 0, continuations = 0
  const notify = () => { for (const listener of listeners) { try { listener() } catch { /* one view cannot break synchronization */ } } }
  const clear = () => { if (timer !== null) port.clear(timer); timer = null }
  const active = (version: number) => state.enabled && version === generation
  const blocked = () => ["unsupported", "blocked", "expired"].includes(state.phase)
  function pause(expired = false) {
    generation++; state.enabled = false; context = null; clear(); const unsubscribe = stop; stop = null
    try { unsubscribe?.() } catch { /* cleanup must not revive a cancelled session */ }
    changed = false
    state.phase = expired ? "expired" : "paused"; state.pending = null; state.issues = { total: 0, omitted: 0, items: [] }
    state.message = expired ? "无法继续确认原账号、归属、恢复上下文或调度结果；旧会话已停止，请先核对再明确启用。" : "已暂停本次会话日程同步；已发出的请求或已提交结果不承诺撤销。"
    notify()
  }
  function request(delay = 1500) {
    if (!state.enabled || blocked()) return
    if (state.busy) { changed = true; return }
    if (!port.online()) { clear(); state.phase = "offline"; state.message = "日程离线，本机数据保留；联网后再核对。"; notify(); return }
    if (!port.foreground()) return
    if (timer !== null) return // coalesce writes; preserve backoff instead of resetting on every event.
    timer = port.later(() => { timer = null; void execute(false) }, delay)
  }
  async function execute(manual: boolean): Promise<boolean> {
    if (!state.enabled || !context || state.busy || (!manual && blocked())) return false
    if (manual) { retries = 0; continuations = 0 }
    clear()
    if (!port.online()) { state.phase = "offline"; state.message = "日程离线；未确认数据和转换意图保留。"; notify(); return false }
    if (!port.foreground()) return false
    const version = generation, pin = copy(context)
    state.busy = true; state.issues = { total: 0, omitted: 0, items: [] }; changed = false; state.phase = "running"; state.message = "正在核对日程：首次转换意图 → 上行 → 独立游标拉取。"; notify()
    let again = false, retryDelay = 0
    try {
      await port.verify(pin)
      if (!active(version)) return false
      const result = await port.run(pin, () => active(version))
      await port.verify(pin)
      if (!active(version)) return false
      state.pending = copy(result.pending)
      state.issues = copy(result.issues ?? { total: 0, omitted: 0, items: [] })
      if (result.unsupported) { state.phase = "unsupported"; state.message = "当前后端日程接口不可用（可能尚未部署）。已停止自动重试；保留本机数据，部署核实后再明确重试。" }
      else if (result.blocked) { state.phase = "blocked"; state.message = "日程仍有未确认转换或冲突，保留原意图/候选及P2保护；请到预简核对区处理后明确重试。" }
      else if (result.failed) {
        if (retries < 3) { retryDelay = 15_000 * 2 ** retries++; state.phase = "error"; state.message = `日程本轮未确认；${retryDelay / 1000}秒后有限重试，最多3次。P2日记同步不受此轮阻断。` }
        else { state.phase = "blocked"; state.message = "日程连续未确认，已停止自动重试；请检查网络/后端与原数据后明确重试。" }
      } else {
        retries = 0
        const pending = result.more || changed
        if (pending && continuations++ < 5) { state.phase = "pending"; state.message = "本轮日程已处理，仍有后续批次；稍后有界继续。"; again = true }
        else if (pending) { state.phase = "blocked"; state.message = "本次连续批次预算已用完，数据仍保留；请明确继续，不无限循环。" }
        else { continuations = 0; state.phase = "ready"; state.message = "本轮日程核对结束；不等于日记、资源或所有设备全部同步。" }
      }
      return !result.failed && !result.blocked && !result.unsupported
    } catch {
      if (active(version)) pause(true)
      return false
    } finally {
      state.busy = false; notify()
      if (active(version) && !blocked()) { if (retryDelay) request(retryDelay); else if (again) request(2000) }
    }
  }
  return {
    inspect: () => copy(state),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async enable(): Promise<boolean> {
      if (state.busy || state.enabled || state.reviewing) return false
      const version = ++generation
      state.busy = true; state.phase = "enabling"; state.message = "正在确认账号与本地归属；不自动认领或清库。"; notify()
      try {
        const pin = await port.capture(); await port.verify(pin)
        if (version !== generation) return false
        if (!pin.ownerUserId || pin.ownerUserId !== pin.authSubject) throw new Error("归属未确认")
        context = copy(pin); state.enabled = true; retries = 0; continuations = 0
        const unwatch = port.watch(copy(pin), () => request(), () => pause(true))
        if (!active(version)) { unwatch(); return false }
        stop = unwatch; state.phase = "pending"; state.message = "本次会话已启用；将开始明确授权的日程同步，刷新后需重新启用。"
        return true
      } catch { if (version === generation) pause(true); return false }
      finally { state.busy = false; notify(); if (active(version)) request(0) }
    },
    acquireManualReview(): (() => void) | null {
      if (state.enabled || state.busy || state.reviewing) return null
      state.reviewing = true; notify()
      let held = true
      return () => { if (!held) return; held = false; state.reviewing = false; notify() }
    },
    pause, request, runNow: () => execute(true),
  }
}
