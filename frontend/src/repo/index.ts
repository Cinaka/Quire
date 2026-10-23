import { localBackupRepo } from "@/db/backupRepo"
import { localFirstMediaRepo } from "@/db/cloudMediaRepo"
import { localDraftRepo } from "@/db/draftRepo"
import { readEntryNewDestination } from "@/db/entryNewDestinationRepo"
import { localEntryRepo, type IEntryRepo } from "@/db/entryRepo"
import { localScheduleHostRepo } from "@/db/scheduleHostRepo"
import { createLocalScheduleReminderPort } from "@/db/scheduleReminderRepo"
import { localStatsRepo } from "@/db/statsRepo"
import { localSyncRepo } from "@/db/syncRepo"
import { localTagRepo, type ITagRepo } from "@/db/tagRepo"

export type { EditorDraft } from "@/db/draftRepo"
export type {
  PendingSyncItem,
  SyncConflict,
  SyncErrorItem,
  SyncStatus,
} from "@/db/syncRepo"

export const entryRepo: IEntryRepo = localEntryRepo
export const mediaRepo = localFirstMediaRepo
export const tagRepo: ITagRepo = localTagRepo
export const backupRepo = localBackupRepo
export const statsRepo = localStatsRepo
export const syncRepo = localSyncRepo
export const draftRepo = localDraftRepo
// 仅公开受账号/恢复代际约束的本机宿主，不公开裸预简写库或云端协调器。
export const scheduleHostRepo = localScheduleHostRepo

// 惰性只读端口：每次挂载独立固定上下文，不启动同步或认领。
export const createScheduleReminderPort = createLocalScheduleReminderPort

export const entryNewDestination = { read: readEntryNewDestination }

// 显式核对入口：构造惰性会话，不启动自动同步。
export { listScheduleConflictSources, createScheduleConflictSession } from "@/db/scheduleConflictCenterRepo"

// P5-2: only the verified, memory-scoped factory is public.
export type { NotebookReadPort, NotebookMediaResult } from "@/db/notebookReadCore"

export { createVerifiedNotebookReadPort, captureNotebookScope } from "@/db/notebookSessionRepo"

// P6: verified factory only, lazily loaded after explicit entry. No bare leases.
export async function createVerifiedExportPreflightTask(failed: () => void) {
  return (await import("@/db/exportSessionRepo")).createVerifiedExportPreflightTask(failed)
}
