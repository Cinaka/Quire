import type { ScheduleResourceRepairStep } from "./scheduleResourceRepair"
import { scheduleEntryId } from "./schedules"

export interface ResourceDownloadPanelPort {
  prepare(id: string, selected: string[]): Promise<{
    ready: boolean; reason: string; reviewId: number; steps?: ScheduleResourceRepairStep[]
    resolutionEnabled?: boolean; materialOrigin?: string; downloaded?: boolean
  }>
  repair(reviewId: number, confirmed: boolean): Promise<{
    repaired: boolean; reason: string; resolutionEnabled: boolean; intentStatus?: string
  }>
  cancel(): void
}
interface DownloadPreview { reviewId: number; steps: ScheduleResourceRepairStep[] }
export interface ResourceDownloadPanelState {
  sourceId: string; selectedIds: string[]
  preview: DownloadPreview | null; confirmed: boolean; busy: boolean; closed: boolean; expired: boolean
  notice: string; error: string
}
const ORIGIN = "authenticated_current_image_bytes"
const CANCEL_NOTICE = "已停止后续步骤；正在进行的读取可能仍需结束。已提交的补齐不会因取消或关闭撤销，请重新核对。"
function validId(value: unknown): value is string {
  try { return typeof value === "string" && scheduleEntryId(value) === value } catch { return false }
}
/** Pure UI state only. The owner injects a dedicated, fixed-context port; no default DB/network. */
export function createScheduleResourceDownloadPanel(port: ResourceDownloadPanelPort, sourceId: string, mediaIds: string[]) {
  if (!validId(sourceId) || !Array.isArray(mediaIds) || !mediaIds.length || mediaIds.length > 64 ||
      new Set(mediaIds).size !== mediaIds.length || mediaIds.some(id => !validId(id))) throw new Error("补齐目标无效")
  const allowed = [...mediaIds], listeners = new Set<() => void>()
  const state: ResourceDownloadPanelState = { sourceId, selectedIds: [], preview: null,
    confirmed: false, busy: false, closed: false, expired: false, notice: "请明确选择缺失图片，再下载并核对；尚未写入本机。", error: "" }
  let revision = 0
  const inspect = (): ResourceDownloadPanelState => JSON.parse(JSON.stringify(state))
  const publish = () => { for (const listener of listeners) listener() }
  const active = () => !state.closed && !state.expired
  const reset = () => { state.preview = null; state.confirmed = false; state.error = "" }
  const stop = () => { revision++; reset(); try { port.cancel() } catch { state.expired = true }; state.notice = CANCEL_NOTICE }
  const current = (run: number) => run === revision && active()
  function preview(value: Awaited<ReturnType<ResourceDownloadPanelPort["prepare"]>>, selected: string[]): DownloadPreview {
    if (value.ready !== true || value.resolutionEnabled !== false || value.materialOrigin !== ORIGIN || value.downloaded !== true || value.reason !== "explicit_cloud_missing_bytes_confirmation" ||
        !Number.isSafeInteger(value.reviewId) || value.reviewId < 1 ||
        !Array.isArray(value.steps) || value.steps.length !== selected.length ||
        new Set(value.steps.map(row => row.mediaId)).size !== selected.length || value.steps.some(row =>
          !selected.includes(row.mediaId) || typeof row.createRow !== "boolean" || typeof row.fillOriginal !== "boolean" ||
          typeof row.fillThumbnail !== "boolean" || (!row.fillOriginal && !row.fillThumbnail) || (row.createRow && !row.fillOriginal))) throw new Error("计划不完整")
    return JSON.parse(JSON.stringify({ reviewId: value.reviewId, steps: value.steps }))
  }
  return {
    inspect,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
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
      if (!state.selectedIds.length) { state.error = "请先明确选择至少一张图片。"; publish(); return false }
      reset(); state.busy = true; state.notice = "正在下载所选缺失槽位并核对完整证明；图片暂留内存，不写入业务数据。"
      const run = ++revision, selected = [...state.selectedIds]
      publish()
      try {
        if (!current(run)) return false
        const result = await port.prepare(sourceId, selected)
        if (!current(run)) return false
        state.preview = preview(result, selected); state.notice = "计划已准备。请核对补齐槽位，再勾选并明确确认。"; return true
      } catch {
        if (current(run)) { reset(); try { port.cancel() } catch { state.expired = true }; state.error = "未能准备安全计划；下载、当前证明或本机保护可能已变化，请重新核对。" }
        return false
      } finally { state.busy = false; publish() }
    },
    async apply(): Promise<boolean> {
      if (!active() || state.busy || !state.preview || state.confirmed !== true) return false
      const reviewId = state.preview.reviewId, run = ++revision
      state.busy = true; state.confirmed = false; state.notice = "正在复验已下载材料、完整证明和本机状态；仅补齐缺失图片。"; publish()
      try {
        if (!current(run)) return false
        const result = await port.repair(reviewId, true)
        if (!current(run)) return false
        reset()
        if (result.repaired !== true || result.reason !== "local_missing_bytes_repaired" || result.resolutionEnabled !== false || result.intentStatus !== "unchanged_protected") throw new Error("未确认")
        state.notice = "下载图片已补齐本机；日记、标签与转简保护未变，云端取舍仍需另行核对。"; return true
      } catch {
        if (current(run)) { reset(); try { port.cancel() } catch { state.expired = true }; state.error = "本次结果未确认，请重新核对本机资源；不自动重试、不宣称回滚已提交内容。" }
        return false
      } finally { state.busy = false; publish() }
    },
    cancel() { if (active()) { stop(); publish() } },
    expire() { if (!state.closed) { stop(); state.expired = true; publish() } },
    close() { if (!state.closed) { stop(); state.closed = true; publish() } },
    dispose() { stop(); state.closed = true; listeners.clear() },
  }
}
