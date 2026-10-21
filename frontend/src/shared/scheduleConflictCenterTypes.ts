import type { ConflictEvidenceFileHandle } from "@/io/scheduleConflictEvidenceFile"
import type { Schedule } from "./types"
import type { ScheduleConflictChoice } from "./scheduleConflict"
import type { ResourceWorkspacePort } from "./scheduleResourceWorkspaceTypes"
import type { TerminalBlock } from "./scheduleTerminalBlockers"
import type { TerminalDiscardChoice } from "./scheduleTerminalConflict"
export interface ConflictSource { id: string; title: string; deleted: boolean; kind?: "pending" }
export interface TerminalCenterPreview {
  blocks: TerminalBlock[]; completeLocalResources: boolean; sourceDeletionEnabled: boolean; choices: TerminalDiscardChoice[]
}
export type TerminalCenterAction = "observation" | "source" | TerminalDiscardChoice
export interface PendingCenterPreview { local: Schedule | null; server: Schedule; choices: ScheduleConflictChoice[] }
export interface ScheduleConflictSession {
  reviewPending(): Promise<PendingCenterPreview | null>
  resolvePending(choice: ScheduleConflictChoice, confirmed: boolean, handle: ConflictEvidenceFileHandle): Promise<boolean>
  resources: ResourceWorkspacePort
  review(): Promise<TerminalCenterPreview>
  apply(action: TerminalCenterAction, confirmed: boolean, handle: ConflictEvidenceFileHandle): Promise<boolean>
  cancel(): void
}
