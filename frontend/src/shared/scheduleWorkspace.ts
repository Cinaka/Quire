import type { ScheduleDraftLease, ScheduleDraftReadResult } from "@/db/scheduleDraftRepo"
import type { LocalOwnerSnapshot } from "@/db/scheduleStateRepo"

import type { ScheduleEditorSession } from "./scheduleEditor"
import { canOpenScheduleDiaryContent } from "./scheduleEditorContent"
import { presentSchedule } from "./schedulePresentation"
import { assertNewScheduleDate, assertScheduleDate } from "./schedules"
import { isLocalDate, todayLocal } from "./time"
import { type LocalDate, type Paged, type Schedule, type ScheduleConvertResult } from "./types"

export interface ScheduleWorkspaceQuery {
  view: "pending" | "converted" | "deleted"
  page: number
  pageSize: number
  dateFrom?: LocalDate
  dateTo?: LocalDate
}
export type ScheduleWorkspaceOpen =
  | { kind: "new"; date: LocalDate }
  | { kind: "edit"; id: string; expectedClientUpdatedAt: string }
  | { kind: "resume"; lease: ScheduleDraftLease }
export interface ScheduleWorkspacePort {
  capture(): Promise<LocalOwnerSnapshot>
  validate(owner: LocalOwnerSnapshot): Promise<void>
  load(owner: LocalOwnerSnapshot, query: ScheduleWorkspaceQuery): Promise<{ records: Paged<Schedule>; recovery: ScheduleDraftReadResult }>
  open(owner: LocalOwnerSnapshot, target: ScheduleWorkspaceOpen): Promise<ScheduleEditorSession>
  discard(owner: LocalOwnerSnapshot, lease: ScheduleDraftLease): Promise<void>
  setDeleted(owner: LocalOwnerSnapshot, id: string, expectedRevision: string, deleted: boolean): Promise<void>
  convert(owner: LocalOwnerSnapshot, id: string, expectedRevision: string, entryDate?: LocalDate): Promise<ScheduleConvertResult>
  inspectConversion(owner: LocalOwnerSnapshot, id: string): Promise<ScheduleConvertResult>
}
export function parseWorkspaceQuery(raw: ScheduleWorkspaceQuery): ScheduleWorkspaceQuery {
  if (!raw || Object.keys(raw).some(key => !["view", "page", "pageSize", "dateFrom", "dateTo"].includes(key)) ||
    !["pending", "converted", "deleted"].includes(raw.view) ||
    !Number.isSafeInteger(raw.page) || raw.page < 1 || !Number.isSafeInteger(raw.pageSize) || raw.pageSize < 1 || raw.pageSize > 100) {
    throw new Error("预简列表筛选或分页参数无效")
  }
  if (raw.dateFrom !== undefined) assertScheduleDate(raw.dateFrom)
  if (raw.dateTo !== undefined) assertScheduleDate(raw.dateTo)
  if (raw.dateFrom && raw.dateTo && raw.dateFrom > raw.dateTo) throw new Error("预简日期区间无效")
  return { ...raw }
}
export function summarizeConversion(result: ScheduleConvertResult) {
  const entry = result.entry
  const canOpen = result.entryState === "active" && entry?.isDeleted === 0 && entry.id === result.schedule.id &&
    entry.fromScheduleId === result.schedule.id && typeof entry.title === "string" && isLocalDate(entry.entryDate) &&
    canOpenScheduleDiaryContent(entry.content)
  return { scheduleId: result.schedule.id, entryId: canOpen ? entry!.id : null,
    entryDate: entry && isLocalDate(entry.entryDate) ? entry.entryDate : null,
    entryTitle: typeof entry?.title === "string" ? entry.title : "",
    entryState: result.entryState, canOpen, created: result.created, pendingConfirmation: result.pendingConfirmation }
}
type Prompt = { kind: "remove" | "restore" | "convert"; source: Schedule }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** 内部无DOM容器。owner只捕获一次；失败不采纳新账号/恢复批次来重放旧动作。 */
export function createScheduleWorkspace(port: ScheduleWorkspacePort, clock: () => LocalDate = todayLocal) {
  let owner: LocalOwnerSnapshot | null = null
  let session: ScheduleEditorSession | null = null
  let request = 0
  let active = true
  let disposed = false
  const listeners = new Set<() => void>()
  const state = {
    today: clock(), query: { view: "pending", page: 1, pageSize: 20 } as ScheduleWorkspaceQuery,
    items: [] as Schedule[], total: 0, loading: false, busy: false, editing: false, editorKey: 0,
    recovery: null as ScheduleDraftReadResult | null, prompt: null as Prompt | null,
    result: null as ReturnType<typeof summarizeConversion> | null, error: "", notice: "", expired: false,
  }
  assertScheduleDate(state.today)
  function notify(): void { if (!disposed) for (const listener of listeners) listener() }
  function contextExpired(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED")
  }
  function fail(error: unknown): void {
    if (contextExpired(error)) {
      invalidate(errorText(error)); return
    }
    state.error = errorText(error); notify()
  }
  function closeUninstalled(value: unknown): void {
    if (value && typeof value === "object" && "close" in value && typeof value.close === "function") value.close()
  }
  function tick(): void { const day = clock(); assertScheduleDate(day); state.today = day }
  function available(): boolean { return active && owner !== null && !state.busy && !state.loading && !state.editing && !state.prompt }
  function selected(id: string): Schedule {
    const source = state.items.find(row => row.id === id)
    if (!source || !presentSchedule(source, state.today).usable) throw new Error("请重新读取有效预简，未采用旧列表动作")
    return copy(source)
  }
  async function load(): Promise<boolean> {
    if (!active || !owner || state.busy) return false
    const token = ++request
    const captured = copy(owner)
    const query = copy(state.query)
    state.loading = true; state.items = []; state.total = 0; state.recovery = null; state.error = ""; tick(); notify()
    try {
      const data = await port.load(captured, query)
      await port.validate(captured)
      if (!active || token !== request) return false
      state.items = copy(data.records.items); state.total = data.records.total
      state.query.page = data.records.page; state.recovery = copy(data.recovery)
      return true
    } catch (error) { if (active && (token === request || contextExpired(error))) fail(error); return false }
    finally { if (active && token === request) { state.loading = false; notify() } }
  }
  async function run<T>(work: (captured: LocalOwnerSnapshot) => Promise<T>, install: (result: T) => void): Promise<boolean> {
    if (!active || !owner || state.busy) return false
    const captured = copy(owner)
    state.busy = true; state.error = ""; tick(); notify()
    let returned: unknown
    try {
      const result = await work(captured)
      returned = result
      await port.validate(captured)
      if (!active) {
        // 打开结果尚未装入时也要关闭旧会话，不让它成为无主编辑器。
        closeUninstalled(result)
        return false
      }
      install(result)
      return true
    } catch (error) { closeUninstalled(returned); if (active) fail(error); return false }
    finally { if (active) { state.busy = false; notify() } }
  }
  async function open(target: ScheduleWorkspaceOpen): Promise<boolean> {
    if (!available()) return false
    return run(captured => port.open(captured, target), result => {
      session = result; state.editing = true; state.editorKey += 1; state.result = null
    })
  }
  function invalidate(reason = "账号或恢复批次已变化，请重新进入；未重放旧操作。"): void {
    active = false; request += 1; session?.close(); session = null
    state.items = []; state.total = 0; state.recovery = null; state.prompt = null; state.result = null
    state.editing = false; state.busy = false; state.loading = false; state.expired = true; state.error = reason; notify()
  }
  return {
    inspect() { return copy(state) },
    editorSession(): ScheduleEditorSession | null { return session },
    subscribe(listener: () => void): () => void { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    async initialize(): Promise<boolean> {
      if (!active || owner || state.loading) return false
      state.loading = true; notify()
      try { owner = copy(await port.capture()); if (!active) return false; state.loading = false; return await load() }
      catch (error) { if (active) { state.loading = false; fail(error) }; return false }
    },
    refresh: load,
    tick(): void { if (active) { tick(); notify() } },
    async setQuery(raw: ScheduleWorkspaceQuery): Promise<boolean> {
      if (!active || !owner || state.busy || state.editing || state.prompt) return false
      try { state.query = parseWorkspaceQuery(raw) } catch (error) { fail(error); return false }
      return load()
    },
    async openNew(date: LocalDate): Promise<boolean> {
      if (!available()) return false
      try { tick(); assertNewScheduleDate(date, state.today) } catch (error) { fail(error); return false }
      return open({ kind: "new", date })
    },
    async edit(id: string): Promise<boolean> {
      if (!available()) return false
      try {
        const row = selected(id)
        if (!presentSchedule(row, state.today).canEdit) throw new Error("此预简不可编辑")
        return await open({ kind: "edit", id, expectedClientUpdatedAt: row.clientUpdatedAt })
      } catch (error) { fail(error); return false }
    },
    async resume(): Promise<boolean> {
      if (!available() || !state.recovery?.draft) return false
      return open({ kind: "resume", lease: copy(state.recovery.lease) })
    },
    async discardRecoveryConfirmed(): Promise<boolean> {
      if (!available() || !state.recovery?.draft) return false
      const lease = copy(state.recovery.lease)
      const ok = await run(captured => port.discard(captured, lease), () => { state.notice = "已弃去安全草稿；已保存预简未删除。" })
      if (ok) await load()
      return ok
    },
    /** 只能接已经prepareLeave/明确弃去成功的面板事件，不能绕过安全草稿检查。 */
    async editorFinished(): Promise<boolean> {
      if (!session || !session.inspect().closed) { fail(new Error("请先完成安全草稿返回检查")); return false }
      session = null; state.editing = false; notify()
      return load()
    },
    requestAction(kind: Prompt["kind"], id: string, expectedRevision?: string, remindDate?: LocalDate): boolean {
      if (!available()) return false
      try {
        tick()
        const source = selected(id)
        const view = presentSchedule(source, state.today)
        if ((kind === "remove" && !view.canRemove) || (kind === "restore" && !view.canRestore) ||
          (kind === "convert" && !view.canConvert) || !["remove", "restore", "convert"].includes(kind)) throw new Error("此预简不能执行该操作")
        if (kind === "convert" && (expectedRevision !== source.clientUpdatedAt || remindDate !== source.remindDate)) {
          throw new Error("转简请求与当前列表修订不符，请重新读取")
        }
        state.prompt = { kind, source }; state.result = null; state.error = ""; notify(); return true
      } catch (error) { fail(error); return false }
    },
    cancelPrompt(): void { if (active && !state.busy) { state.prompt = null; notify() } },
    async confirm(entryDate?: LocalDate): Promise<boolean> {
      if (!active || !owner || state.busy || state.editing || !state.prompt) return false
      const prompt = copy(state.prompt)
      try {
        tick()
        if (prompt.kind === "convert" && entryDate !== undefined) {
          assertScheduleDate(entryDate)
          if (prompt.source.remindDate >= state.today || entryDate > state.today) throw new Error("只有逾期预简可明确选择另一已至之日")
        } else if (entryDate !== undefined) throw new Error("非转简操作不接受目标日期")
      } catch (error) { fail(error); return false }
      const ok = await run(async captured => {
        if (prompt.kind === "convert") return port.convert(captured, prompt.source.id, prompt.source.clientUpdatedAt, entryDate)
        await port.setDeleted(captured, prompt.source.id, prompt.source.clientUpdatedAt, prompt.kind === "remove")
        return null
      }, result => {
        state.prompt = null
        if (result) { state.result = summarizeConversion(result); state.notice = "转简结果已读取；不代表云端确认。" }
        else state.notice = prompt.kind === "remove" ? "预简已移入断简；安全草稿未清除。" : "预简已恢复；原转换身份保持不变。"
      })
      if (ok) await load()
      return ok
    },
    async inspectConversion(id: string): Promise<boolean> {
      if (!available()) return false
      return run(captured => port.inspectConversion(captured, id), result => { state.result = summarizeConversion(result) })
    },
    /** 点击打开前重读实际Entry状态，不拿旧弹窗或首次快照复活日记。 */
    async openResultEntry(): Promise<string | null> {
      if (!available() || !state.result) return null
      const id = state.result.scheduleId
      let entryId: string | null = null
      await run(captured => port.inspectConversion(captured, id), result => {
        state.result = summarizeConversion(result); entryId = state.result.entryId
      })
      return entryId
    },
    canLeave(): boolean { return active && !state.busy && !state.editing },
    invalidate,
    dispose(): void { invalidate("预简页面已关闭。"); disposed = true; listeners.clear() },
  }
}
