import { localBackupRepo } from "@/db/backupRepo"
import { localFirstMediaRepo } from "@/db/cloudMediaRepo"
import { localDraftRepo } from "@/db/draftRepo"
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
