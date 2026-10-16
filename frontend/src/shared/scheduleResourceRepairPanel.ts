import type { ScheduleResourceRepairStep } from "./scheduleResourceRepair"
import { scheduleEntryId } from "./schedules"

export interface ResourceRepairPanelFile { name?: string; size: number; text(): Promise<string> }
export interface ResourceRepairPanelPort {
  prepare(id: string, selected: string[], file: ResourceRepairPanelFile): Promise<{
    ready: boolean; reason: string; reviewId: number; steps?: ScheduleResourceRepairStep[]
    resolutionEnabled?: boolean; unusedFileMediaIds?: string[]; fileFormat?: string; fileStatePolicy?: string
  }>
  repair(reviewId: number, confirmed: boolean): Promise<{
    repaired: boolean; reason: string; resolutionEnabled: boolean; intentStatus?: string
  }>
  cancel(): void
}
interface RepairPreview { reviewId: number; steps: ScheduleResourceRepairStep[]; fileFormat: string; unusedFileMediaIds: string[] }
export interface ResourceRepairPanelState {
  sourceId: string; selectedIds: string[]; fileInfo: { name: string; size: number } | null
  preview: RepairPreview | null; confirmed: boolean; busy: boolean; closed: boolean; expired: boolean
  notice: string; error: string
}
const POLICY = "bytes_only_never_replay_archived_choice_or_business_state"
const CANCEL_NOTICE = "已停止后续步骤；正在进行的读取可能仍需结束。已提交的补齐不会因取消或关闭撤销，请重新核对。"
function validId(value: unknown): value is string {
  try { return typeof value === "string" && scheduleEntryId(value) === value } catch { return false }
}
/** Pure UI state only. The owner injects a dedicated, fixed-context port; no default DB/network. */
export function createScheduleResourceRepairPanel(port: ResourceRepairPanelPort, sourceId: string, mediaIds: string[]) {
  if (!validId(sourceId) || !Array.isArray(mediaIds) || !mediaIds.length || mediaIds.length > 64 ||
      new Set(mediaIds).size !== mediaIds.length || mediaIds.some(id => !validId(id))) throw new Error("补齐目标无效")
  const allowed = [...mediaIds], listeners = new Set<() => void>()
  const state: ResourceRepairPanelState = { sourceId, selectedIds: [], fileInfo: null, preview: null,
    confirmed: false, busy: false, closed: false, expired: false, notice: "请选择本机证据文件和需补齐的图片，再准备计划。", error: "" }
  let file: ResourceRepairPanelFile | null = null, revision = 0
  const inspect = (): ResourceRepairPanelState => JSON.parse(JSON.stringify(state))
  const publish = () => { for (const listener of listeners) listener() }
  const active = () => !state.closed && !state.expired
  const reset = () => { state.preview = null; state.confirmed = false; state.error = "" }
  const stop = () => { revision++; reset(); try { port.cancel() } catch { state.expired = true }; state.notice = CANCEL_NOTICE }
  const current = (run: number) => run === revision && active()
  function preview(value: Awaited<ReturnType<ResourceRepairPanelPort["prepare"]>>, selected: string[]): RepairPreview {
    if (value.ready !== true || value.resolutionEnabled !== false || value.fileStatePolicy !== POLICY ||
        !Number.isSafeInteger(value.reviewId) || value.reviewId < 1 ||
        !["terminal-local-resource-evidence", "terminal-matched-resource-conflict-evidence"].includes(value.fileFormat ?? "") ||
        !Array.isArray(value.steps) || value.steps.length !== selected.length ||
        new Set(value.steps.map(row => row.mediaId)).size !== selected.length || value.steps.some(row =>
          !selected.includes(row.mediaId) || typeof row.createRow !== "boolean" || typeof row.fillOriginal !== "boolean" ||
          typeof row.fillThumbnail !== "boolean" || (!row.fillOriginal && !row.fillThumbnail) || (row.createRow && !row.fillOriginal)) ||
        !Array.isArray(value.unusedFileMediaIds) || value.unusedFileMediaIds.length > 64 ||
        new Set(value.unusedFileMediaIds).size !== value.unusedFileMediaIds.length ||
        value.unusedFileMediaIds.some(id => !validId(id) || selected.includes(id))) throw new Error("计划不完整")
    return JSON.parse(JSON.stringify({ reviewId: value.reviewId, steps: value.steps,
      fileFormat: value.fileFormat, unusedFileMediaIds: value.unusedFileMediaIds }))
  }
  return {
    inspect,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    setFile(next: ResourceRepairPanelFile | null) {
      if (!active()) return
      stop(); file = null; state.fileInfo = null
      if (next !== null) {
        if (!Number.isSafeInteger(next.size) || next.size <= 0 || next.size > 64 * 1024 * 1024 || typeof next.text !== "function") {
          state.error = "请选择不超过64MiB的非空JSON证据文件。"
        } else { file = next; state.fileInfo = { name: typeof next.name === "string" ? next.name.slice(0, 160) : "所选证据文件", size: next.size } }
      }
      if (!state.busy) state.notice = "文件选择已更新，须重新准备并明确确认；不会自动读取或补齐。"
      publish()
    },
    select(ids: string[]) {
      if (!active()) return
      stop(); state.selectedIds = []
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !allowed.includes(id))) state.error = "图片选择无效，请重新选择。"
      else state.selectedIds = [...ids].sort()
      if (!state.busy) state.notice = "图片选择已更新，旧计划已失效。"
      publish()
    },
    confirm(value: boolean) { state.confirmed = active() && !state.busy && Boolean(state.preview) && value === true; publish() },
    async prepare(): Promise<boolean> {
      if (!active() || state.busy) return false
      if (!file || !state.selectedIds.length) { state.error = "请先选择证据文件和至少一张图片。"; publish(); return false }
      reset(); state.busy = true; state.notice = "正在读取文件并核对当前云端证明，不写入业务数据。"
      const run = ++revision, selected = [...state.selectedIds], selectedFile = file
      publish()
      try {
        if (!current(run)) return false
        const result = await port.prepare(sourceId, selected, selectedFile)
        if (!current(run)) return false
        state.preview = preview(result, selected); state.notice = "计划已准备。请核对补齐槽位，再勾选并明确确认。"; return true
      } catch {
        if (current(run)) { reset(); try { port.cancel() } catch { state.expired = true }; state.error = "未能准备安全计划；文件、当前证明或本机保护可能已变化，请重新核对。" }
        return false
      } finally { state.busy = false; publish() }
    },
    async apply(): Promise<boolean> {
      if (!active() || state.busy || !state.preview || state.confirmed !== true) return false
      const reviewId = state.preview.reviewId, run = ++revision
      state.busy = true; state.confirmed = false; state.notice = "正在复验文件、当前证明和本机状态；仅允许补齐缺失图片。"; publish()
      try {
        if (!current(run)) return false
        const result = await port.repair(reviewId, true)
        if (!current(run)) return false
        reset()
        if (result.repaired !== true || result.resolutionEnabled !== false || result.intentStatus !== "unchanged_protected") throw new Error("未确认")
        state.notice = "缺失图片已补齐本机；日记、标签与转简保护未变，云端取舍仍需另行核对。"; return true
      } catch {
        if (current(run)) { reset(); try { port.cancel() } catch { state.expired = true }; state.error = "本次结果未确认，请重新核对本机资源；不自动重试、不宣称回滚已提交内容。" }
        return false
      } finally { state.busy = false; publish() }
    },
    cancel() { if (active()) { stop(); publish() } },
    expire() { if (!state.closed) { stop(); state.expired = true; file = null; state.fileInfo = null; publish() } },
    close() { if (!state.closed) { stop(); state.closed = true; file = null; state.fileInfo = null; publish() } },
    dispose() { stop(); state.closed = true; file = null; state.fileInfo = null; listeners.clear() },
  }
}
