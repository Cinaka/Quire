import type { ConflictEvidenceFileHandle } from "@/io/scheduleConflictEvidenceFile"
import type { ResourceWorkspacePort } from "./scheduleResourceWorkspaceTypes"
import type { TerminalBlock } from "./scheduleTerminalBlockers"
import type { TerminalDiscardChoice } from "./scheduleTerminalConflict"
export interface ConflictSource { id: string; title: string; deleted: boolean }
export interface TerminalCenterPreview {
  blocks: TerminalBlock[]; completeLocalResources: boolean; sourceDeletionEnabled: boolean; choices: TerminalDiscardChoice[]
}
export type TerminalCenterAction = "observation" | "source" | TerminalDiscardChoice
export interface ScheduleConflictSession {
  resources: ResourceWorkspacePort
  review(): Promise<TerminalCenterPreview>
  apply(action: TerminalCenterAction, confirmed: boolean, handle: ConflictEvidenceFileHandle): Promise<boolean>
  cancel(): void
}
