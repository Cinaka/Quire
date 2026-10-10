import type { DiaryTarget, DiaryTargetLease } from "./scheduleHostTypes"
import type { Entry, EntryUpdateDto, LocalDate } from "./types"
import { canOpenScheduleDiaryContent } from "./scheduleEditorContent"
import { assertDraftId, isDraftIso } from "./scheduleDrafts"
import { assertScheduleDate } from "./schedules"
import { todayLocal } from "./time"

export type ScheduleDiaryEditorBody = Pick<Entry, "entryDate" | "title" | "content" | "mood" | "weather" | "tagIds">
export interface ScheduleDiaryEditorPort {
  validate(): Promise<void>
  save(lease: DiaryTargetLease, update: EntryUpdateDto): Promise<DiaryTarget>
}
const fields = ["entryDate", "title", "content", "mood", "weather", "tagIds"] as const
const copy = <T>(value: T): T => structuredClone(value)
const expired = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && error.code === "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED")
function bodyOf(entry: Entry): ScheduleDiaryEditorBody {
  return copy({ entryDate: entry.entryDate, title: entry.title, content: entry.content, mood: entry.mood, weather: entry.weather, tagIds: entry.tagIds })
}
function validateBody(body: ScheduleDiaryEditorBody): void {
  assertScheduleDate(body.entryDate)
  if (typeof body.title !== "string" || body.title.length > 255 || !canOpenScheduleDiaryContent(body.content)) throw new Error("日记标题或正文不受支持，请保留输入并修正")
  if (![body.mood, body.weather].every(value => value === null || typeof value === "string") ||
    !Array.isArray(body.tagIds) || body.tagIds.some(id => typeof id !== "string" || !id)) throw new Error("日记元信息无效，请保留输入并修正")
}
function validateTarget(target: DiaryTarget): void {
  assertDraftId(target.lease.id)
  if (target.entry.id !== target.lease.id || target.entry.fromScheduleId !== target.lease.fromScheduleId ||
    target.entry.clientUpdatedAt !== target.lease.clientUpdatedAt || !isDraftIso(target.lease.clientUpdatedAt) ||
    target.entry.isDeleted !== 0 || (target.lease.fromScheduleId !== null && target.lease.fromScheduleId !== target.lease.id)) throw new Error("日记编辑目标与受保护租约不一致")
  validateBody(bodyOf(target.entry))
}
function delta(body: ScheduleDiaryEditorBody, baseline: ScheduleDiaryEditorBody): EntryUpdateDto {
  const result: EntryUpdateDto = {}
  // Object.assign保留每个字段的原类型；不发送未修改日期，避免时区变化后的隐式改期。
  for (const field of fields) if (JSON.stringify(body[field]) !== JSON.stringify(baseline[field])) Object.assign(result, { [field]: copy(body[field]) })
  return result
}

/** 私有目标会话：修改仅在内存，明确保存走固定上下文/修订端口。无自动安全草稿、网络或媒体上传。 */
export function createScheduleDiaryEditor(target: DiaryTarget, port: ScheduleDiaryEditorPort, clock: () => LocalDate = todayLocal) {
  target = copy(target); validateTarget(target)
  let baseline = bodyOf(target.entry)
  let lease = copy(target.lease)
  let active = true
  let disposed = false
  let snapshotFailed = false
  const listeners = new Set<() => void>()
  const state = { body: copy(baseline), dirty: false, busy: false, closed: false, expired: false, error: "",
    notice: "仅准备本机编辑。尚无自动安全草稿；未保存输入仅在本会话内，刷新或关闭页面可能丢失。" }
  function notify(): void { if (!disposed) for (const listener of listeners) listener() }
  function fail(error: unknown): void {
    state.error = String(error)
    state.notice = "保存未确认。当前输入保留在本会话；不要刷新，也不要用新租约自动覆盖其他修改。"
    if (expired(error)) invalidate(String(error))
    else notify()
  }
  function invalidate(reason = "账号或恢复上下文已失效；当前输入保留供明确复制，不再写入"): void {
    if (!active) return
    active = false; state.expired = true; state.busy = false; state.error = reason; notify()
  }
  function writable(): boolean { return active && !disposed && !state.closed && !state.busy }
  return {
    inspect() { return copy(state) },
    subscribe(listener: () => void): () => void { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    change(update: EntryUpdateDto): boolean {
      if (!writable()) return false
      try {
        if (!update || typeof update !== "object" || Array.isArray(update) || Object.keys(update).some(key => !fields.includes(key as typeof fields[number]))) throw new Error("日记编辑载荷无效，不接受来源/终态或未知字段")
        const patch = copy(update)
        if (Object.values(patch).some(value => value === undefined)) throw new Error("省略字段须不传，不能用undefined清除")
        const next = { ...state.body, ...patch }
        // 可复制但校验失败的输入也保留在内存，不退回旧正文冒充新输入。
        state.body = next; snapshotFailed = false
        state.dirty = Object.keys(delta(next, baseline)).length > 0
        validateBody(next)
        state.error = ""; state.notice = state.dirty ? "修改仅在本会话，尚未存为日记或安全草稿。" : "内容与本会话最后确认版本一致。"
        notify(); return true
      } catch (error) { snapshotFailed = true; state.dirty = true; fail(error); return false }
    },
    async save(): Promise<boolean> {
      if (!writable() || snapshotFailed) return false
      const capturedLease = copy(lease)
      let patch: EntryUpdateDto
      try {
        validateBody(state.body); patch = delta(state.body, baseline)
        if (patch.entryDate !== undefined) { const today = clock(); assertScheduleDate(today); if (patch.entryDate > today) throw new Error("已有日记不能改为未来日，不自动搬到预简") }
      } catch (error) { fail(error); return false }
      state.busy = true; state.error = ""; notify()
      try {
        await port.validate()
        if (!active || disposed) return false
        if (!Object.keys(patch).length) { state.notice = "没有待保存修改；未写入或确认云端。"; return true }
        const saved = copy(await port.save(capturedLease, copy(patch)))
        await port.validate()
        if (!active || disposed) return false
        validateTarget(saved)
        if (saved.lease.id !== capturedLease.id || saved.lease.fromScheduleId !== capturedLease.fromScheduleId ||
          saved.lease.clientUpdatedAt <= capturedLease.clientUpdatedAt) throw new Error("保存回执不能替换目标或倒退修订，请明确检查")
        const savedBody = bodyOf(saved.entry)
        for (const field of fields) if (JSON.stringify(savedBody[field]) !== JSON.stringify(state.body[field])) throw new Error("保存回执与确认输入不一致，未将旧输入标为已保存")
        lease = copy(saved.lease); baseline = savedBody; state.body = copy(baseline)
        state.dirty = false; state.notice = "日记已保存本机；未确认云端，原转换身份及首次快照不变。"; return true
      } catch (error) { if (active && !disposed) fail(error); return false }
      finally { if (!disposed) { state.busy = false; notify() } }
    },
    async prepareLeave(): Promise<boolean> {
      if (disposed || state.busy || state.dirty || snapshotFailed) return false
      if (state.closed) return true
      if (!active) return true // 无未保存输入时只允许离开，不重新授权写入。
      state.busy = true; notify()
      try { await port.validate(); if (!active || disposed) return false; state.closed = true; return true }
      catch (error) { if (active && !disposed) fail(error); return false }
      finally { if (!disposed) { state.busy = false; notify() } }
    },
    /** 用户明确确认后丢弃本会话未保存输入；不清meta.draft、不删Entry、不改任何业务数据。 */
    discardConfirmed(): boolean {
      if (disposed || state.busy) return false
      state.body = copy(baseline); state.dirty = false; snapshotFailed = false; state.closed = true
      state.notice = "已明确弃去本会话未保存修改，存储中的日记和安全草稿均未删除。"; notify(); return true
    },
    invalidate,
    /** 卸载仅停回调，inspect仍保留最后可复制输入；不能撤销已提交事务或保证刷新零丢失。 */
    dispose(): void { invalidate("编辑宿主已关闭；不自动保存或清除存储。"); disposed = true; listeners.clear() },
  }
}
export type ScheduleDiaryEditorSession = ReturnType<typeof createScheduleDiaryEditor>
