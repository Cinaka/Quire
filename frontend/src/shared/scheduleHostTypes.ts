import type { EditorDraft } from "@/db/draftRepo"
import type { LocalOwnerSnapshot } from "@/db/scheduleStateRepo"
import type { Entry, EntryUpdateDto, LocalDate, Schedule } from "./types"
import type { ScheduleWorkspacePort } from "./scheduleWorkspace"

export interface ScheduleHostContext extends LocalOwnerSnapshot { authSubject: string; authGeneration: number }
export interface FirstSaveFrame { fingerprint: string; draft: EditorDraft }
export interface FirstSavePlan { fingerprint: string; date: LocalDate; resource: "entry" | "schedule" }
export type FirstSaveResult = { resource: "entry"; entry: Entry } | { resource: "schedule"; schedule: Schedule }
export interface DiaryTargetLease { id: string; fromScheduleId: string | null; clientUpdatedAt: string }
export interface DiaryTarget { lease: DiaryTargetLease; entry: Entry }
export interface ScheduleHostPort {
  capture(): Promise<ScheduleHostContext>
  validate(context: ScheduleHostContext): Promise<void>
  workspace(context: ScheduleHostContext): ScheduleWorkspacePort
  watch(context: ScheduleHostContext, expired: (reason: string) => void): () => void
  firstSaveFrame(context: ScheduleHostContext): Promise<FirstSaveFrame | null>
  firstSave(context: ScheduleHostContext, plan: FirstSavePlan): Promise<FirstSaveResult>
  openDiary(context: ScheduleHostContext, id: string): Promise<DiaryTarget>
  saveDiary(context: ScheduleHostContext, lease: DiaryTargetLease, update: EntryUpdateDto): Promise<DiaryTarget>
}
