import type { ConflictEvidenceFileHandle, ConflictEvidenceReadableFile } from "@/io/scheduleConflictEvidenceFile"
import type { SharedTagCopyChoice, SharedTagCopyName } from "./scheduleSharedTagCopy"

export type ResourceWorkspaceBlock = "shared_images" | "current_state_changed" | "protected_conditions" | "stale_plan" | "publication_uncertain" | "historical_handoff"
export interface ResourceWorkspaceEntry { title: string; date: string; text: string; tags: Array<{ id: string; name: string; color: string | null }> }
export interface ResourceWorkspacePreview {
  sourceId: string; local: ResourceWorkspaceEntry; cloud: ResourceWorkspaceEntry
  localMediaCount: number; cloudMediaCount: number
  directChoices: SharedTagCopyChoice[]; independentChoices: SharedTagCopyChoice[]; blockers: ResourceWorkspaceBlock[]
  plan: null | { id: string; choice: SharedTagCopyChoice; stage: "prepared" | "started" | "confirmed" | "handed-off" | "stale"
    names: SharedTagCopyName[] }
}
export type ResourceWorkspaceOutcome = "not_confirmed" | "names_prepared" | "tags_confirmed" | "diary_handed_off"
export interface ResourceWorkspaceResult { ok: boolean; outcome: ResourceWorkspaceOutcome; cloudSynced: false }
export interface ResourceWorkspacePort {
  prepareEvidence(confirmed: boolean): Promise<{ ready: boolean; reviewId: number }>
  saveEvidence(reviewId: number, handle: ConflictEvidenceFileHandle): Promise<{ saved: boolean }>
  inspect(file: ConflictEvidenceReadableFile): Promise<ResourceWorkspacePreview>
  prepareCopies(file: ConflictEvidenceReadableFile, choice: SharedTagCopyChoice, names: SharedTagCopyName[], confirmed: boolean): Promise<ResourceWorkspaceResult>
  publishCopies(file: ConflictEvidenceReadableFile, planId: string, confirmed: boolean): Promise<ResourceWorkspaceResult>
  handoffCopies(file: ConflictEvidenceReadableFile, planId: string, choice: SharedTagCopyChoice, confirmed: boolean): Promise<ResourceWorkspaceResult>
  resolveDirect(file: ConflictEvidenceReadableFile, choice: SharedTagCopyChoice, confirmed: boolean): Promise<ResourceWorkspaceResult>
  cancel(): void
}
export interface ResourceWorkspaceSaveTarget { name: string; handle: ConflictEvidenceFileHandle; cancel(): void }
export const RESOURCE_WORKSPACE_BLOCK_TEXT: Record<ResourceWorkspaceBlock, string> = {
  shared_images: "图片被共享，或无法完整证明独占；可保全双方文件，本页不能据此替换或删除图片。",
  current_state_changed: "本机或云端已与原证据不同，请保留文件并重新核对，不自动采用旧版本。",
  protected_conditions: "直接取舍条件未满足，可能涉及共享定义、水位或其他保护；不要据此猜测具体原因。",
  stale_plan: "命名准备属于旧恢复批次，不能自动重绑或继续发布。原保护仍保留。",
  publication_uncertain: "发布已发起但结果未确认。只能用原ID重新核对，不能另建一套或按未发布弃去。",
  historical_handoff: "已有本机引用交接留档；这是历史记录，不表示当前云端日记已同步。请勿重放。",
}
