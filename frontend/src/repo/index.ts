// src/repo/index.ts —— 上层唯一入口。本地优先之下，本文件在 P2 里一行都不用改。
import { localBackupRepo } from "@/db/backupRepo"
import { localEntryRepo, type IEntryRepo } from "@/db/entryRepo"
import { localMediaRepo } from "@/db/mediaRepo"
import { localStatsRepo } from "@/db/statsRepo"
import { localTagRepo, type ITagRepo } from "@/db/tagRepo"

/**
 * 本地优先（第七节）意味着这里不是「登录就切到 apiEntryRepo」的二选一：
 * 读写永远走本地，上行由 src/api/sync.ts 在后台完成。
 *
 * 因此本文件 **不得 import @/api/***：
 *   一是根本用不上（没有 apiEntryRepo 这个东西，P2 也不造）；
 *   二是 src/api/* 反过来要用 @/repo（claim.ts 要导备份），两边互 import 就成环，
 *   Vite 里的表现是运行时某个导出突然是 undefined，极难定位。
 * 登录态的判断由页面直接 import @/api/session，不经过这一层。
 */
export const entryRepo: IEntryRepo = localEntryRepo
export const mediaRepo = localMediaRepo
export const tagRepo: ITagRepo = localTagRepo
export const backupRepo = localBackupRepo
export const statsRepo = localStatsRepo
