import { localBackupRepo } from "@/db/backupRepo"
import { localFirstMediaRepo } from "@/db/cloudMediaRepo"
import { localDraftRepo } from "@/db/draftRepo"
import { localEntryRepo, type IEntryRepo } from "@/db/entryRepo"
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
