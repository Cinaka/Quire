import { localBackupRepo } from "@/db/backupRepo"
import { localFirstMediaRepo } from "@/db/cloudMediaRepo"
import { localDraftRepo } from "@/db/draftRepo"
import { localEntryRepo, type IEntryRepo } from "@/db/entryRepo"
import { localStatsRepo } from "@/db/statsRepo"
import { localSyncRepo } from "@/db/syncRepo"
import { localTagRepo, type ITagRepo } from "@/db/tagRepo"

export type { EditorDraft } from "@/db/draftRepo"
export type { SyncConflict, SyncErrorItem, SyncStatus } from "@/db/syncRepo"

/**
 * 本地优先：页面读写始终走本地 Repository；同步引擎在后台搬运 dirty 数据。
 * 图片 Repository 额外实现云端回退与 IndexedDB 后台回填，新设备也能按需离线。
 */
export const entryRepo: IEntryRepo = localEntryRepo
export const mediaRepo = localFirstMediaRepo
export const tagRepo: ITagRepo = localTagRepo
export const backupRepo = localBackupRepo
export const statsRepo = localStatsRepo
export const syncRepo = localSyncRepo
export const draftRepo = localDraftRepo
