import { parseScheduleCloudResourceReview } from "./scheduleCloudResources"
import { checkResourceConflictEvidence, matchedResourceChoices } from "./scheduleResourceConflict"
import type { ScheduleResourceConflictEvidence } from "./scheduleResourceConflict"
import { checkScheduleResourceEvidence } from "./scheduleResourceEvidence"
import type { ScheduleResourceEvidence } from "./scheduleResourceEvidence"
import type { ScheduleCloudResourceReview } from "./scheduleCloudResources"
import type { TerminalConflictChoice } from "./scheduleTerminalConflict"
import { conversionCanonical } from "./scheduleConversionSync"
import { scheduleEntryId } from "./schedules"
import { toPlainText } from "./text"
import type { Entry } from "./types"

export interface ResourceConflictSaveTarget { name: string; preserve(evidence: ScheduleResourceConflictEvidence): Promise<void>; cancel(): void }
export interface ResourceConflictPanelPort {
  review(id: string): Promise<{ ready: boolean; reason: string; reviewId: number; choices: TerminalConflictChoice[]; local?: ScheduleResourceEvidence; server?: ScheduleCloudResourceReview; sourcePolicy?: string }>
  resolve(reviewId: number, choice: TerminalConflictChoice, confirmed: boolean, preserve: (evidence: ScheduleResourceConflictEvidence) => Promise<void>): Promise<{ applied: boolean; reason: string; localIntentStatus?: string }>
  cancel(): void
}
interface EntryPreview { title: string; date: string; text: string; deleted: boolean; mood: string | null; weather: string | null }
interface ResourceConflictPreview { reviewId: number; choices: TerminalConflictChoice[]; local: EntryPreview | null; cloud: EntryPreview | null; cloudSourceTitle: string; mediaCount: number; tagNames: string[]; intentionCount: number; candidateCount: number }
export interface ResourceConflictPanelState {
  sourceId: string; preview: ResourceConflictPreview | null; choice: TerminalConflictChoice | null; fileName: string
  confirmed: boolean; fileVerified: boolean; busy: boolean; closed: boolean; expired: boolean; notice: string; error: string
}
const CANCEL = "已停止后续步骤。文件可能已经保存；已经提交的交接不会因关闭撤销，请重新核对。"
const entryPreview = (row: Entry | null): EntryPreview | null => row ? { title: row.title, date: row.entryDate,
  text: toPlainText(row.content), deleted: row.isDeleted === 1, mood: row.mood, weather: row.weather } : null
/** Fixed-context, injection-only UI. No picker, DB, network or permission request at construction. */
export function createScheduleResourceConflictPanel(port: ResourceConflictPanelPort, id: string, pick: () => Promise<ResourceConflictSaveTarget>) {
  if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
  const state: ResourceConflictPanelState = { sourceId: id, preview: null, choice: null, fileName: "", confirmed: false,
    fileVerified: false, busy: false, closed: false, expired: false, notice: "请明确读取当前双方版本；尚未保存文件或进行取舍。", error: "" }
  const listeners = new Set<() => void>()
  let target: ResourceConflictSaveTarget | null = null, revision = 0, localFingerprint = "", cloudFingerprint = ""
  const inspect = (): ResourceConflictPanelState => JSON.parse(JSON.stringify(state))
  const publish = () => { for (const listener of listeners) listener() }
  const active = () => !state.closed && !state.expired
  const current = (run: number) => active() && revision === run
  const check = (run: number) => { if (!current(run)) throw new Error("旧面板已失效") }
  const dropFile = () => { const old = target; target = null; state.fileName = ""; state.confirmed = false; state.fileVerified = false; try { old?.cancel() } catch { state.expired = true } }
  const clearReview = () => { dropFile(); state.preview = null; state.choice = null; localFingerprint = ""; cloudFingerprint = "" }
  const stop = () => { revision++; clearReview(); try { port.cancel() } catch { state.expired = true }; state.error = ""; state.notice = CANCEL }
  return {
    inspect,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async review(): Promise<boolean> {
      if (!active() || state.busy) return false
      stop(); if (!active()) { publish(); return false }
      const run = ++revision; state.busy = true; state.notice = "正在读取当前双方版本和资源证明，不写入业务。"; publish()
      try {
        check(run); const result = await port.review(id); check(run)
        if (result.ready !== true || !Number.isSafeInteger(result.reviewId) || result.reviewId < 1 || result.sourcePolicy !== "accept-cloud-terminal" || !result.local || !result.server) throw new Error("核对不完整")
        const local = checkScheduleResourceEvidence(result.local), cloud = result.server
        if (local.scheduleId !== id || cloud.readOnly !== true || cloud.resolutionEnabled !== false || cloud.proofScope !== "current_entry_resources") throw new Error("来源或证明不同")
        let choices: TerminalConflictChoice[] = []
        try { choices = matchedResourceChoices(local, cloud) } catch { /* Read-only protected remains allowed. */ }
        if (!Array.isArray(result.choices) || conversionCanonical(result.choices) !== conversionCanonical(choices)) throw new Error("取舍资格不一致")
        state.preview = { reviewId: result.reviewId, choices, local: entryPreview(local.state.entry), cloud: entryPreview(cloud.review.entry),
          cloudSourceTitle: cloud.review.schedule?.title ?? "", mediaCount: local.mediaIds.length, tagNames: local.tags.map(tag => tag.name),
          intentionCount: local.state.intentions.length, candidateCount: local.state.candidates.length }
        localFingerprint = conversionCanonical(local); cloudFingerprint = conversionCanonical(cloud)
        state.notice = choices.length ? "请核对双方内容并明确选择；两种选择都接受云端终态来源，均须保全双方证据。" : "资源或保护条件未满足；仅可只读核对，不能保存为取舍确认或解除保护。"
        return true
      } catch {
        if (current(run)) { clearReview(); try { port.cancel() } catch { state.expired = true }; state.error = "当前核对未确认，请重新打开；不自动取舍。" }
        return false
      } finally { state.busy = false; publish() }
    },
    choose(choice: TerminalConflictChoice) {
      if (!active() || state.busy || !state.preview?.choices.includes(choice)) return
      revision++; dropFile(); state.choice = choice; state.error = ""; state.notice = "选择已变更，请重新明确选择全新空文件；未保存、未写入业务。"; publish()
    },
    async pickFile(): Promise<boolean> {
      if (!active() || state.busy || !state.preview || !state.choice) return false
      dropFile(); const run = ++revision; state.busy = true; state.error = ""; state.notice = "请选择全新空JSON文件；取消选择不会进行取舍。"; publish()
      try {
        check(run)
        const selected = await pick() // Must be called before any awaited DB/network operation in this click.
        if (!current(run)) { try { selected?.cancel() } catch { /* Discard a late target. */ }; return false }
        if (!selected || (typeof selected.name !== "string" || !selected.name.trim()) || typeof selected.preserve !== "function" || typeof selected.cancel !== "function") throw new Error("目标无效")
        target = selected; state.fileName = selected.name.slice(0, 160)
        state.notice = "已选择文件，但尚未写入或验证。勾选后将保存双方完整证据，回读一致后才尝试原子交接。"; return true
      } catch { if (current(run)) { dropFile(); state.error = "文件选择未完成或浏览器不支持；拒绝覆盖已有文件，不以下载替代保存确认。" }; return false }
      finally { state.busy = false; publish() }
    },
    confirm(value: boolean) { state.confirmed = active() && !state.busy && Boolean(target && state.choice && state.preview) && value === true; publish() },
    async resolve(): Promise<boolean> {
      if (!active() || state.busy || !state.preview || !state.choice || !target || state.confirmed !== true) return false
      const run = ++revision, ticket = state.preview.reviewId, choice = state.choice, saveTarget = target
      let preserved = false
      state.busy = true; state.confirmed = false; state.notice = "正在复验并保存双方证据；写入、关闭和回读一致后才允许尝试交接。"; publish()
      try {
        check(run)
        const result = await port.resolve(ticket, choice, true, async raw => {
          check(run); const evidence = checkResourceConflictEvidence(raw)
          // Bind the real file to the exact preview and explicit choice, never to an older export.
          if (evidence.scheduleId !== id || evidence.choice !== choice || conversionCanonical(evidence.local) !== localFingerprint) throw new Error("证据与预览不同")
          const cloud = evidence.cloud as unknown
          // The port supplies wire cloud; compare through its strict parser, not by dropping private fields.
          const parsed = parseScheduleCloudResourceReview(cloud, id)
          if (conversionCanonical(parsed) !== cloudFingerprint) throw new Error("云端证明与预览不同")
          await saveTarget.preserve(evidence); check(run); preserved = true; state.fileVerified = true
          state.notice = "双方证据已关闭并回读验证；仍在复核当前状态，尚未宣称交接完成。"; publish(); check(run)
        })
        check(run)
        const reason = choice === "cloud-source-keep-diary" ? "local_diary_ready_for_p2" : "cloud_diary_adopted"
        if (!preserved || result.applied !== true || result.reason !== reason || !["superseded_by_explicit_choice", "no_local_intent"].includes(result.localIntentStatus ?? "")) throw new Error("交接未确认")
        clearReview(); state.fileVerified = true
        state.notice = choice === "cloud-source-keep-diary" ? "双方证据已保存并回读；已接受云端来源、保留本机日记待P2后续同步。本次未启动同步。" : "双方证据已保存并回读；已接受云端来源与当前云端日记，仅解除本来源的目标保护。本次未启动同步。"
        return true
      } catch {
        if (current(run)) { clearReview(); try { port.cancel() } catch { state.expired = true }; state.error = preserved ? "证据已完成回读，但交接未确认。保留文件与本机数据，重新核对；不自动重试。" : "保存或交接未确认，文件可能已经落盘；不宣称回滚已提交内容，请重新核对。" }
        return false
      } finally { try { saveTarget.cancel() } catch { /* A finished file is not deleted. */ }; state.busy = false; publish() }
    },
    cancel() { if (active()) { stop(); publish() } },
    expire() { if (!state.closed) { stop(); state.expired = true; publish() } },
    close() { if (!state.closed) { stop(); state.closed = true; publish() } },
    dispose() { stop(); state.closed = true; listeners.clear() },
  }
}
