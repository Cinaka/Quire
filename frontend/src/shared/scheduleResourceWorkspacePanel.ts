import type { ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import type { SharedTagCopyChoice, SharedTagCopyName } from "./scheduleSharedTagCopy"
import type { ResourceWorkspacePort, ResourceWorkspacePreview, ResourceWorkspaceSaveTarget, ResourceWorkspaceOutcome } from "./scheduleResourceWorkspaceTypes"
import { RESOURCE_WORKSPACE_BLOCK_TEXT } from "./scheduleResourceWorkspaceTypes"
import { scheduleEntryId } from "./schedules"

export type WorkspaceAction = "names" | "publish" | "handoff" | "direct"
export interface ResourceWorkspacePanelState {
  sourceId: string; fileName: string; fileSaved: boolean; downloadConfirmed: boolean; evidenceTicket: number
  preview: ResourceWorkspacePreview | null; choice: SharedTagCopyChoice | null; names: SharedTagCopyName[]
  confirmedAction: WorkspaceAction | null; busy: boolean; closed: boolean; expired: boolean; closeRequested: boolean
  notice: string; error: string
}
const choices: SharedTagCopyChoice[] = ["cloud-source-use-diary", "cloud-source-keep-diary"]
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const stopped = "已停止后续步骤；已保存文件、已发起发布或已经提交的交接不会因停止而撤销，请重新核对。"
/** Injection-only UI, no implicit DB/HTTP/picker/auto-resume. File objects never enter renderable state. */
export function createScheduleResourceWorkspacePanel(port: ResourceWorkspacePort, sourceId: string, pick: () => Promise<ResourceWorkspaceSaveTarget>) {
  if (scheduleEntryId(sourceId) !== sourceId) throw new Error("来源身份无效")
  const state: ResourceWorkspacePanelState = { sourceId, fileName: "", fileSaved: false, downloadConfirmed: false, evidenceTicket: 0,
    preview: null, choice: null, names: [], confirmedAction: null, busy: false, closed: false, expired: false, closeRequested: false,
    notice: "先明确保存双方实物证据，或读取原证据文件。没有默认取舍，不自动发布或同步。", error: "" }
  let file: ConflictEvidenceReadableFile | null = null, target: ResourceWorkspaceSaveTarget | null = null, revision = 0
  const listeners = new Set<() => void>(), publish = () => { for (const listener of listeners) listener() }
  const active = () => !state.closed && !state.expired
  const hasNames = () => state.names.some(row => row.name.length > 0)
  const cancelTarget = () => { const old = target; target = null; try { old?.cancel() } catch { state.expired = true } }
  const stop = () => { revision++; state.preview = null; state.confirmedAction = null; state.evidenceTicket = 0
    state.downloadConfirmed = false; cancelTarget(); try { port.cancel() } catch { state.expired = true }; state.notice = stopped }
  const cleanInput = () => { if (!hasNames()) return true; state.error = "仍有未保存的独立名称，请先明确保存准备或弃去名称输入；不会直接覆盖。"; publish(); return false }
  const eligible = (action: WorkspaceAction) => {
    if (!["names", "publish", "handoff", "direct"].includes(action)) return false
    const view = state.preview, choice = state.choice
    if (!view || !choice || !file) return false
    if (view.blockers.some(code => ["shared_images", "current_state_changed", "stale_plan", "historical_handoff"].includes(code))) return false
    if (action === "names") return !view.plan && view.independentChoices.includes(choice) && state.names.length > 0 && state.names.every(row => row.name.trim() === row.name && row.name.length > 0 && row.name.length <= 32)
    if (action === "direct") return !view.plan && view.directChoices.includes(choice) && !hasNames()
    if (!view.plan || view.plan.choice !== choice) return false
    return action === "publish" ? ["prepared", "started", "confirmed"].includes(view.plan.stage) : view.plan.stage === "confirmed"
  }
  const check = (run: number) => { if (!active() || run !== revision) throw new Error("旧面板已失效") }
  const run = async (task: (version: number) => Promise<boolean>) => {
    if (!active() || state.busy || state.closeRequested) return false
    const version = ++revision; state.busy = true; state.confirmedAction = null; state.error = ""; publish()
    try { check(version); return await task(version) }
    catch { if (active() && version === revision) { state.preview = null; state.evidenceTicket = 0; try { port.cancel() } catch { state.expired = true }; state.error = "本次未确认。可能是离线、旧后端、文件/上下文变化或其他保护；保留文件与原ID重新核对，不自动重试，也不宣称撤销已提交内容。" }; return false }
    finally { state.busy = false; publish() }
  }
  const validate = (raw: ResourceWorkspacePreview): ResourceWorkspacePreview => {
    const value = copy(raw)
    if (!value || value.sourceId !== sourceId || !Array.isArray(value.directChoices) || !Array.isArray(value.independentChoices) ||
        [...value.directChoices, ...value.independentChoices].some(choice => !choices.includes(choice)) ||
        new Set(value.directChoices).size !== value.directChoices.length || new Set(value.independentChoices).size !== value.independentChoices.length ||
        !Array.isArray(value.blockers) || value.blockers.some(code => !Object.prototype.hasOwnProperty.call(RESOURCE_WORKSPACE_BLOCK_TEXT, code)) ||
        !Number.isSafeInteger(value.localMediaCount) || value.localMediaCount < 0 || !Number.isSafeInteger(value.cloudMediaCount) || value.cloudMediaCount < 0) throw new Error("预览无效")
    for (const entry of [value.local, value.cloud]) {
      if (!entry || typeof entry.title !== "string" || entry.title.length > 255 || typeof entry.date !== "string" ||
          typeof entry.text !== "string" || entry.text.length > 12000 || !Array.isArray(entry.tags) || entry.tags.length > 64 ||
          new Set(entry.tags.map(tag => tag.id)).size !== entry.tags.length || entry.tags.some(tag => scheduleEntryId(tag.id) !== tag.id || typeof tag.name !== "string" || !(tag.color === null || typeof tag.color === "string"))) throw new Error("日记预览无效")
    }
    if (value.plan && (scheduleEntryId(value.plan.id) !== value.plan.id || !choices.includes(value.plan.choice) ||
        !["prepared", "started", "confirmed", "handed-off", "stale"].includes(value.plan.stage) || !Array.isArray(value.plan.names) ||
        value.plan.names.length > 64 || value.plan.names.some(row => scheduleEntryId(row.from) !== row.from || typeof row.name !== "string" || !row.name.length || row.name.length > 32))) throw new Error("历史阶段无效")
    // Project known fields only; UI state never retains injected evidence, tokens or image bytes.
    return { sourceId, local: { title: value.local.title, date: value.local.date, text: value.local.text, tags: value.local.tags.map(({ id, name, color }) => ({ id, name, color })) },
      cloud: { title: value.cloud.title, date: value.cloud.date, text: value.cloud.text, tags: value.cloud.tags.map(({ id, name, color }) => ({ id, name, color })) },
      localMediaCount: value.localMediaCount, cloudMediaCount: value.cloudMediaCount, directChoices: value.directChoices, independentChoices: value.independentChoices, blockers: value.blockers,
      plan: value.plan ? { id: value.plan.id, choice: value.plan.choice, stage: value.plan.stage, names: value.plan.names.map(({ from, name }) => ({ from, name })) } : null }
  }
  const inspectFile = async (selected: ConflictEvidenceReadableFile, name: string, version: number) => {
    if (!selected || !Number.isSafeInteger(selected.size) || selected.size < 1 || typeof selected.text !== "function") throw new Error("文件无效")
    state.evidenceTicket = 0; port.cancel()
    const result = validate(await port.inspect(selected)); check(version)
    file = selected; state.fileName = name.slice(0, 160); state.preview = result; state.choice = null; state.names = []; state.confirmedAction = null
    state.notice = result.plan?.stage === "handed-off" ? RESOURCE_WORKSPACE_BLOCK_TEXT.historical_handoff : "已读取当前双方版本；请明确选择。每一步都重新复核，不自动接着发布或交接。"
    return true
  }
  return {
    inspect: (): ResourceWorkspacePanelState => copy(state),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    can: eligible,
    confirmDownload(value: boolean) { if (active() && !state.busy) { state.downloadConfirmed = value === true; publish() } },
    async prepareEvidence() {
      if (state.downloadConfirmed !== true || !cleanInput()) return false
      return run(async version => {
        state.preview = null; state.evidenceTicket = 0
        const result = await port.prepareEvidence(true); check(version)
        if (result.ready !== true || !Number.isSafeInteger(result.reviewId) || result.reviewId < 1) throw new Error("实物准备未确认")
        state.evidenceTicket = result.reviewId; state.downloadConfirmed = false
        state.notice = "双方实物已准备在内存，尚未保存。请明确选择全新空文件保存并回读；没有业务交接。"; return true
      })
    },
    async saveEvidence() {
      if (!state.evidenceTicket || !cleanInput()) return false
      const ticket = state.evidenceTicket
      return run(async version => {
        // Picker invocation occurs in the click before any awaited port/database/network work.
        const picked = await pick(); if (!active() || version !== revision) { picked?.cancel(); return false }
        if (!picked || typeof picked.name !== "string" || !picked.name.trim() || !picked.handle || typeof picked.cancel !== "function") throw new Error("保存目标无效")
        cancelTarget(); target = picked
        const done = await port.saveEvidence(ticket, picked.handle); check(version)
        if (done.saved !== true) throw new Error("文件保存未确认")
        const selected = await picked.handle.getFile(); check(version)
        if (!selected || selected.size < 1 || typeof selected.text !== "function") throw new Error("保存回读无效")
        file = selected; state.fileName = picked.name.slice(0, 160); state.fileSaved = true; state.evidenceTicket = 0; state.preview = null
        state.notice = "双方证据已保存并回读；保护未解除。请再明确读取此文件核对当前状态，未自动发布或交接。"; return true
      })
    },
    async readFile(selected: ConflictEvidenceReadableFile, name: string) {
      if (!cleanInput()) return false
      return run(version => { state.fileSaved = false; return inspectFile(selected, typeof name === "string" ? name : "原证据文件", version) })
    },
    async readCurrent() {
      if (!file) return false
      const selected = file, name = state.fileName, draft = copy(state.names), previousChoice = state.choice
      return run(async version => {
        await inspectFile(selected, name, version); check(version)
        if (draft.some(row => row.name.length > 0)) {
          const view = state.preview!
          const persisted = view.plan && view.plan.choice === previousChoice && view.plan.names.length === draft.length &&
            view.plan.names.every(row => draft.some(old => old.from === row.from && old.name === row.name))
          if (persisted) state.notice = "已找回与本次输入一致的持久命名准备；尚未自动发布或交接，请重新明确选择和确认。"
          else {
            state.names = draft
            const tags = previousChoice === "cloud-source-keep-diary" ? view.local.tags : view.cloud.tags
            const compatible = previousChoice !== null && !view.plan && view.independentChoices.includes(previousChoice) &&
              tags.length === draft.length && tags.every(tag => draft.some(row => row.from === tag.id))
            state.choice = compatible ? previousChoice : null
            state.notice = compatible ? "当前文件已重新核对，原名称输入已保留；请检查并重新勾选确认，不自动保存。" :
              "当前条件已不同，原名称输入仍保留供复制；不能用于新的计划，请明确处理，不自动丢弃。"
          }
        }
        return true
      })
    },
    choose(choice: SharedTagCopyChoice) {
      if (!active() || state.busy || state.closeRequested || !state.preview || !choices.includes(choice)) return false
      if (state.choice === choice) return true
      if (!cleanInput()) return false
      if (state.preview.plan && state.preview.plan.choice !== choice) return false
      state.choice = choice; state.confirmedAction = null
      if (!state.preview.plan) state.names = state.preview.independentChoices.includes(choice) ? (choice === "cloud-source-keep-diary" ? state.preview.local : state.preview.cloud).tags.map(tag => ({ from: tag.id, name: "" })) : []
      state.error = ""; publish(); return true
    },
    setName(from: string, value: string) {
      if (!active() || state.busy || state.closeRequested || !state.preview || state.preview.plan || typeof value !== "string" || value.length > 32) return false
      const row = state.names.find(row => row.from === from); if (!row) return false
      row.name = value; state.confirmedAction = null; state.error = ""; publish(); return true
    },
    discardNames(confirmed: boolean) { if (!state.busy && confirmed === true) { for (const row of state.names) row.name = ""; state.confirmedAction = null; state.error = ""; publish() } },
    confirm(action: WorkspaceAction, value: boolean) { if (active() && !state.busy && !state.closeRequested) { state.confirmedAction = value === true && eligible(action) ? action : null; publish() } },
    async apply(action: WorkspaceAction) {
      if (state.confirmedAction !== action || !eligible(action)) return false
      const selected = file!, choice = state.choice!, planId = state.preview?.plan?.id, names = copy(state.names)
      return run(async version => {
        const done = action === "names" ? await port.prepareCopies(selected, choice, names, true) : action === "publish" ? await port.publishCopies(selected, planId!, true) :
          action === "handoff" ? await port.handoffCopies(selected, planId!, choice, true) : await port.resolveDirect(selected, choice, true)
        check(version)
        const expected: ResourceWorkspaceOutcome = action === "names" ? "names_prepared" : action === "publish" ? "tags_confirmed" : "diary_handed_off"
        if (done.ok !== true || done.outcome !== expected || done.cloudSynced !== false) throw new Error("操作未确认")
        state.preview = null; state.confirmedAction = null
        state.names = []
        state.notice = action === "names" ? "独立名称与原ID已持久准备，尚未发布。请明确重读原文件，再核对下一步。" : action === "publish" ?
          "本次标签存在确认已记录，日记引用尚未交接。请明确重读原文件，再单独确认交接。" : "本机明确交接已完成；原共享资源仍受保护，本次未启动同步，不表示云端日记已同步。"
        return true
      })
    },
    cancel() { if (active()) { stop(); publish() } },
    requestClose() { if (!state.closed) { state.closeRequested = true; publish() } },
    confirmClose(confirmed: boolean) {
      if (!state.closeRequested || state.closed) return false
      state.closeRequested = false
      if (confirmed === true) { stop(); state.closed = true; state.names = []; file = null }
      publish(); return confirmed === true
    },
    expire() { if (!state.closed) { stop(); state.expired = true; publish() } },
    dispose() { stop(); state.closed = true; state.names = []; file = null; listeners.clear() },
  }
}
