import type { ScheduleDraftReadResult } from "@/db/scheduleDraftRepo"

import type { ScheduleEditorBody, ScheduleEditorSession } from "./scheduleEditor"

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** 无DOM交互适配器。组件必须按会话key重建，路由离开必须先prepareLeave。 */
export function createScheduleEditorPanel(session: ScheduleEditorSession) {
  const initial = session.inspect()
  let state = {
    body: { remindDate: initial.payload.remindDate, title: initial.payload.title, content: initial.payload.content } as ScheduleEditorBody,
    sourceStatus: initial.status as ScheduleDraftReadResult["status"],
    pending: 0, busy: false, closed: false, error: "", notice: "仅编辑本机；尚未确认云端保存。",
  }
  let revision = 0
  let snapshotFailed = false
  let disposed = false
  const listeners = new Set<() => void>()
  function notify(): void { if (!disposed) for (const listener of listeners) listener() }
  function writable(): boolean { return !disposed && !state.closed && !state.busy }
  function fail(error: unknown): void {
    state.error = message(error)
    state.notice = "操作失败。请保留当前文字；不能据此确认最新内容已存为安全草稿。"
  }
  function stop(): void { state.closed = true; session.close(); notify() }
  return {
    inspect() { return copy(state) },
    subscribe(listener: () => void): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async change(body: ScheduleEditorBody): Promise<boolean> {
      if (!writable()) return false
      let snapshot: ScheduleEditorBody
      try { snapshot = copy(body); snapshotFailed = false } catch (error) {
        revision += 1 // 新输入未能复制，旧保存响应不能抹掉此次错误。
        snapshotFailed = true
        fail(error); notify(); return false
      }
      state.body = snapshot
      const at = ++revision
      state.pending += 1
      state.error = ""
      state.notice = "安全草稿保存中；尚未保存为预简。"
      notify()
      try {
        const result = await session.persist(snapshot)
        if (disposed || state.closed) return false
        if (at === revision) {
          state.sourceStatus = result.status
          state.notice = "安全草稿已存本机；尚未保存为预简，也未上传云端。"
          state.error = ""
        }
        return true
      } catch (error) {
        if (!disposed && !state.closed && at === revision) fail(error)
        return false
      } finally { if (!disposed) { state.pending -= 1; notify() } }
    },
    async submit(): Promise<boolean> {
      if (!writable() || snapshotFailed) return false
      state.busy = true
      state.error = ""
      state.notice = "预简保存中。"
      notify()
      try {
        await session.submit(copy(state.body))
        if (disposed || state.closed) return false
        state.sourceStatus = "empty"
        state.notice = "预简已保存本机；日程云端同步尚未开放。"
        return true
      } catch (error) {
        if (!disposed && !state.closed) fail(error)
        return false
      } finally { if (!disposed) { state.busy = false; notify() } }
    },
    async prepareLeave(): Promise<boolean> {
      if (!writable()) return false
      state.busy = true
      notify()
      try {
        await session.flush()
        if (disposed || state.error) return false
        stop()
        return true
      } catch (error) {
        if (!disposed) fail(error)
        return false
      } finally { if (!disposed) { state.busy = false; notify() } }
    },
    /** 只在用户明确确认后调用；不由打开/卸载/来源冲突自动调用。 */
    async discardConfirmed(): Promise<boolean> {
      if (!writable()) return false
      state.busy = true
      notify()
      try {
        await session.discard()
        if (disposed) return false
        stop()
        return true
      } catch (error) {
        if (!disposed) fail(error)
        return false
      } finally { if (!disposed) { state.busy = false; notify() } }
    },
    /** 卸载兜底只停止旧回调；不能保证已排队/未落库文字完成保存。 */
    dispose(): void { stop(); disposed = true; listeners.clear() },
  }
}
