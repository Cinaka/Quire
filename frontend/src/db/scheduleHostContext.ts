import { accessTokenSubject, tokenGeneration } from "@/api/tokenStore"
import type { ScheduleHostContext } from "@/shared/scheduleHostTypes"
import { OWNER_GENERATION_KEY } from "./scheduleStateRepo"
import { db } from "./schema"

export function hostExpired(reason: string): Error {
  return Object.assign(new Error(reason), { code: "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED" })
}
export async function readHostOwner() {
  const owner = await db.meta.get("ownerUserId")
  const epoch = await db.meta.get(OWNER_GENERATION_KEY)
  if ((owner && typeof owner.value !== "string") || (epoch && typeof epoch.value !== "string")) throw hostExpired("本地归属标记不受支持，未当作游客；请保留并检查备份")
  return { ownerUserId: typeof owner?.value === "string" ? owner.value : "", generation: typeof epoch?.value === "string" ? epoch.value : "" }
}
export function assertHostAuth(context: ScheduleHostContext): void {
  if (accessTokenSubject() !== context.authSubject || tokenGeneration() !== context.authGeneration) throw hostExpired("登录/退出上下文已变化，旧宿主操作已停止")
  if (context.authSubject && context.ownerUserId && context.authSubject !== context.ownerUserId) throw hostExpired("登录账号与本地归属不同，请先按既有备份/认领流程处理")
}
/** 在含meta的事务内调用；退出不把owner变成游客，不隐式认领或清库。 */
export async function assertHostContext(context: ScheduleHostContext): Promise<void> {
  assertHostAuth(context)
  const current = await readHostOwner()
  assertHostAuth(context)
  if (current.ownerUserId !== context.ownerUserId || current.generation !== context.generation) throw hostExpired("本地归属或恢复批次已变化，旧宿主操作已停止")
}
export async function captureHostContext(): Promise<ScheduleHostContext> {
  const authSubject = accessTokenSubject(); const authGeneration = tokenGeneration()
  const local = await readHostOwner()
  const context = { ...local, authSubject, authGeneration }
  assertHostAuth(context)
  return context
}
