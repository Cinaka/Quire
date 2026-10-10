import { planFirstSave } from "./firstSave"
import type { DiaryTarget, FirstSaveFrame, FirstSavePlan, FirstSaveResult, ScheduleHostContext, ScheduleHostPort } from "./scheduleHostTypes"
import type { EntryUpdateDto, LocalDate } from "./types"
import type { ScheduleWorkspacePort } from "./scheduleWorkspace"
import { todayLocal } from "./time"

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** 无DOM宿主状态机；上下文捕获一次，重新进入必须创建新实例，不在旧操作后采样新账号。 */
export function createScheduleHost(port: ScheduleHostPort, clock: () => LocalDate = todayLocal) {
  let context: ScheduleHostContext | null = null
  let workspace: ScheduleWorkspacePort | null = null
  let stopWatch: (() => void) | null = null
  let active = true
  let request = 0
  const listeners = new Set<() => void>()
  const state = { ready: false, busy: false, expired: false, error: "", firstSaveError: "", notice: "",
    frame: null as FirstSaveFrame | null, plan: null as FirstSavePlan | null,
    target: null as DiaryTarget | null, firstResult: null as FirstSaveResult | null }
  function notify(): void { for (const listener of listeners) listener() }
  function invalidate(reason = "宿主上下文已失效，请重新进入；原存储内容不自动清除"): void {
    if (!active) return
    active = false; request += 1; stopWatch?.(); stopWatch = null; workspace = null
    state.expired = true; state.ready = false; state.busy = false; state.error = reason
    state.frame = null; state.plan = null; state.target = null; state.firstResult = null; notify()
  }
  function expired(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED")
  }
  function failed(error: unknown): void {
    if (expired(error)) invalidate(String(error))
    else { state.error = String(error); notify() }
  }
  async function frame(): Promise<boolean> {
    if (!active || !context || state.busy) return false
    const token = ++request; const captured = copy(context)
    state.frame = null; state.plan = null; state.firstSaveError = ""; notify()
    try {
      const result = await port.firstSaveFrame(captured); await port.validate(captured)
      if (!active || token !== request) return false
      state.frame = result ? copy(result) : null; notify(); return true
    } catch (error) {
      if (active && (token === request || expired(error))) {
        if (expired(error)) failed(error)
        else { state.firstSaveError = String(error); notify() }
      }
      return false
    }
  }
  async function run<T>(work: (captured: ScheduleHostContext) => Promise<T>, install: (result: T) => void): Promise<boolean> {
    if (!active || !context || !state.ready || state.busy) return false
    const captured = copy(context)
    state.busy = true; state.error = ""; notify()
    try {
      await port.validate(captured)
      const result = await work(captured); await port.validate(captured)
      if (!active) return false
      install(result); return true
    } catch (error) { if (active) failed(error); return false }
    finally { if (active) { state.busy = false; notify() } }
  }
  return {
    inspect() { return copy(state) },
    workspacePort(): ScheduleWorkspacePort | null { return workspace },
    contextKey(): string { return context ? JSON.stringify(context) : "" },
    subscribe(listener: () => void): () => void { if (active) listeners.add(listener); return () => { listeners.delete(listener) } },
    async initialize(): Promise<boolean> {
      if (!active || context || state.busy) return false
      state.busy = true; notify()
      try {
        const pin = await port.capture(); await port.validate(pin)
        if (!active) return false
        context = copy(pin); workspace = port.workspace(copy(pin)); state.ready = true
        stopWatch = port.watch(copy(pin), invalidate)
        if (!active) { stopWatch(); stopWatch = null; return false }
        state.busy = false; notify(); await frame(); return active
      } catch (error) { if (active) { state.busy = false; state.ready = false; workspace = null; stopWatch?.(); stopWatch = null; failed(error) }; return false }
    },
    refreshDraft: frame,
    preview(date: LocalDate): boolean {
      if (!active || state.busy || !state.frame) return false
      state.plan = null; state.error = ""
      try { state.plan = planFirstSave(state.frame, date, clock()); notify(); return true }
      catch (error) { failed(error); return false }
    },
    async confirmFirstSave(): Promise<boolean> {
      if (!state.plan) return false
      const plan = copy(state.plan)
      return run(captured => port.firstSave(captured, plan), result => {
        state.firstResult = copy(result); state.frame = null; state.plan = null
        state.notice = result.resource === "entry" ? "已首存为本机日记；未确认云端。" : "已首存为本机预简；未确认云端。"
      })
    },
    async openTarget(id: string): Promise<boolean> {
      if (!active || !context || !state.ready || state.busy) return false
      state.target = null; notify()
      return run(captured => port.openDiary(captured, id), result => { state.target = copy(result) })
    },
    async saveTarget(update: EntryUpdateDto): Promise<boolean> {
      if (!state.target) return false
      let snapshot: EntryUpdateDto
      try { snapshot = structuredClone(update) } catch (error) { failed(error); return false }
      const lease = copy(state.target.lease)
      return run(captured => port.saveDiary(captured, lease, snapshot), result => {
        state.target = copy(result); state.notice = "目标日记已保存本机，原转换身份不变；未确认云端。"
      })
    },
    async check(): Promise<boolean> {
      if (!active || !context) return false
      try { await port.validate(copy(context)); return active } catch (error) { if (active) failed(error); return false }
    },
    invalidate,
    dispose(): void { invalidate("宿主已关闭。"); listeners.clear() },
  }
}
