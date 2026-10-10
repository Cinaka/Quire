import type { ScheduleDiaryEditorSession } from "./scheduleDiaryEditor"
import type { EntryContent, EntryUpdateDto } from "./types"
import { assertScheduleEditorContent } from "./scheduleEditorContent"

/** 当前文本面板不能保真显示图片或未知字段；保留原正文只读，不删节点来迁就UI。 */
export function diaryPanelBodyMode(content: EntryContent | null): "text" | "retained" {
  try {
    assertScheduleEditorContent(content)
    const walk = (raw: unknown): void => {
      const node = raw as { type: string; attrs?: Record<string, unknown>; marks?: { type: string }[]; content?: unknown[] }
      if (Object.keys(node).some(key => !["type", "text", "content", "attrs", "marks"].includes(key))) throw new Error("unknown field")
      const allowed = node.type === "heading" ? ["level"] : node.type === "orderedList" ? ["start"] : node.type === "codeBlock" ? ["language"] : []
      if (node.attrs && Object.keys(node.attrs).some(key => !allowed.includes(key))) throw new Error("unknown attribute")
      const start = node.attrs?.start
      if (node.type === "orderedList" && start !== undefined && (typeof start !== "number" || !Number.isSafeInteger(start) || start < 1)) throw new Error("invalid list start")
      if (node.type === "codeBlock" && node.attrs?.language !== undefined && node.attrs.language !== null && typeof node.attrs.language !== "string") throw new Error("invalid code language")
      if (node.marks?.some(mark => Object.keys(mark).some(key => key !== "type"))) throw new Error("unknown mark attribute")
      for (const child of node.content ?? []) walk(child)
    }
    if (content) walk(content.doc)
    return "text"
  } catch { return "retained" }
}

/** DOM-independent面板适配器；session属于父宿主，卸载只解除订阅，不自行保存/弃去/释放租约。 */
export function createScheduleDiaryPanel(session: ScheduleDiaryEditorSession) {
  let disposed = false
  const listeners = new Set<() => void>()
  const state = { editor: session.inspect(), bodyMode: diaryPanelBodyMode(session.inspect().body.content),
    editorError: "", composing: false, leavePrompt: false, discardPrompt: false }
  function notify(): void { if (!disposed) for (const listener of listeners) listener() }
  const unsubscribe = session.subscribe(() => {
    if (!disposed) {
      state.editor = session.inspect()
      if (state.editor.expired && state.composing) {
        state.composing = false
        state.editorError = state.editorError || "上下文在输入期间失效，请另外复制编辑器中尚未确认的文字；会话副本可能未包含最后输入。"
      }
      notify()
    }
  })
  function blocked(): boolean { return disposed || state.editor.busy || state.editor.closed || state.editor.expired || state.composing }
  function pending(): boolean { return state.editor.dirty || state.editor.busy || state.composing || Boolean(state.editorError) }
  return {
    inspect() { return structuredClone(state) },
    subscribe(listener: () => void): () => void { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    changeMetadata(update: EntryUpdateDto): boolean {
      if (disposed || state.editor.busy || state.editor.closed || state.editor.expired) return false
      if (!update || Object.keys(update).some(key => !["entryDate", "title", "mood", "weather"].includes(key))) return false
      return session.change(update)
    },
    changeContent(content: EntryContent): boolean {
      if (disposed || state.editor.busy || state.editor.closed || state.editor.expired || state.bodyMode !== "text") return false
      if (diaryPanelBodyMode(content) !== "text") { state.editorError = "正文不能安全交给当前文本面板，未替换原正文；请保留并修正编辑器输入。"; notify(); return false }
      const result = session.change({ content })
      if (result) state.editorError = ""
      notify(); return result
    },
    editorInvalid(reason: string): void { if (!disposed) { state.editorError = reason || "编辑器输入未确认"; notify() } },
    setComposing(value: boolean): void { if (!disposed) { state.composing = value; notify() } },
    needsLeaveConfirmation(): boolean { return pending() },
    async save(): Promise<boolean> {
      if (blocked() || state.editorError) return false
      return session.save()
    },
    async prepareLeave(): Promise<boolean> {
      if (disposed || state.editor.busy || state.composing) return false
      if (state.editor.dirty || state.editorError) { state.leavePrompt = true; state.discardPrompt = false; notify(); return false }
      const result = await session.prepareLeave()
      if (result) { state.leavePrompt = false; notify() }
      return result
    },
    async saveAndLeave(): Promise<boolean> {
      if (blocked() || state.editorError || !await session.save()) return false
      const result = await session.prepareLeave()
      if (result) { state.leavePrompt = false; state.discardPrompt = false; notify() }
      return result
    },
    requestDiscard(): boolean {
      if (disposed || state.editor.busy || state.editor.closed || state.composing) return false
      state.discardPrompt = true; state.leavePrompt = false; notify(); return true
    },
    cancelPrompt(): void { if (!disposed && !state.editor.busy) { state.leavePrompt = false; state.discardPrompt = false; notify() } },
    confirmDiscard(): boolean {
      if (disposed || !state.discardPrompt || state.editor.busy || state.composing) return false
      if (!session.discardConfirmed()) return false
      state.editorError = ""; state.discardPrompt = false; state.leavePrompt = false; notify(); return true
    },
    inputForCopy(): string {
      try { return JSON.stringify(session.inspect().body, null, 2) }
      catch { return "当前输入含不可序列化结构，无法生成完整副本；请保留页面并逐项复制可见文字，不把此提示当作已备份。" }
    },
    dispose(): void { if (!disposed) { disposed = true; unsubscribe(); listeners.clear() } },
  }
}
