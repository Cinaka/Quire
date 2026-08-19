import { localEntryRepo, type IEntryRepo } from "@/db/entryRepo"
import { localMediaRepo } from "@/db/mediaRepo"

/**
 * 上层代码只从这里取仓库实例，永远不要直接 import @/db/*。
 *
 * P2 接入后端时，这个文件会变成：
 *   export const entryRepo = isLoggedIn() ? apiEntryRepo : localEntryRepo
 * 页面、组件、store 全都不用改。
 */
export const entryRepo: IEntryRepo = localEntryRepo
export const mediaRepo = localMediaRepo
