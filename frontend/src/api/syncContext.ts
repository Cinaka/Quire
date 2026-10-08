import { db } from "@/db/schema"
import { assertLocalOwner, localOwnerSnapshot, type LocalOwnerSnapshot } from "@/db/scheduleStateRepo"

import { accessTokenSubject, tokenGeneration } from "./tokenStore"

export interface SyncContext extends LocalOwnerSnapshot { tokenGeneration: number }
export async function captureSyncContext(): Promise<SyncContext> {
  return db.transaction("r", db.meta, async () => {
    const local = await localOwnerSnapshot()
    if (!local.ownerUserId || accessTokenSubject() !== local.ownerUserId) {
      throw new Error("登录账号与本地归属不一致，已停止同步")
    }
    return { ...local, tokenGeneration: tokenGeneration() }
  })
}
export async function assertSyncContext(context: SyncContext): Promise<void> {
  if (accessTokenSubject() !== context.ownerUserId || tokenGeneration() !== context.tokenGeneration) {
    throw new Error("登录会话已变化，旧同步已停止")
  }
  await assertLocalOwner(context)
}
