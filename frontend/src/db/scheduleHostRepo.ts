import { liveQuery } from "dexie"
import { createScheduleEditorSession } from "@/shared/scheduleEditor"
import { localScheduleDraftRepo } from "./scheduleDraftRepo"
import type { ScheduleHostPort } from "@/shared/scheduleHostTypes"
import { assertHostAuth, assertHostContext, captureHostContext, hostExpired, readHostOwner } from "./scheduleHostContext"
import { createLocalScheduleWorkspaceRepo } from "./scheduleWorkspaceRepo"
import { readFirstSaveFrame, commitFirstSave } from "./scheduleFirstSaveRepo"
import { openDiaryTarget, saveDiaryTarget } from "./scheduleDiaryTargetRepo"
import { db } from "./schema"

/** 内部宿主桥：不导出到公共repo/路由，不持久化auth上下文，不自动认领本地数据。 */
export const localScheduleHostRepo: ScheduleHostPort = {
  capture: () => db.transaction("r", db.meta, () => captureHostContext()),
  async validate(context) { context = { ...context }; await db.transaction("r", db.meta, () => assertHostContext(context)) },
  workspace(context) {
    context = { ...context }
    const base = createLocalScheduleWorkspaceRepo(() => assertHostAuth(context), readHostOwner)
    function ownerMatches(owner: { ownerUserId: string; generation: string }): void {
      if (owner.ownerUserId !== context.ownerUserId || owner.generation !== context.generation) throw hostExpired("工作区凭据不属于原宿主上下文")
    }
    return {
      async capture() { await localScheduleHostRepo.validate(context); return { ownerUserId: context.ownerUserId, generation: context.generation } },
      async validate(owner) { ownerMatches(owner); await localScheduleHostRepo.validate(context) },
      async load(owner, query) { ownerMatches(owner); return base.load(owner, query) },
      async open(owner, target) {
        ownerMatches(owner)
        const original = await base.open(owner, target)
        const initial = original.inspect()
        original.close() // 仅使用已校验的初始快照，不把无auth守卫的会话交给宿主。
        const guardedDrafts = {
          async save(lease: Parameters<typeof localScheduleDraftRepo.save>[0], input: Parameters<typeof localScheduleDraftRepo.save>[1]) {
            lease = { ...lease }; input = structuredClone(input)
            return db.transaction("rw", db.schedules, db.meta, async () => {
              await assertHostContext(context)
              const result = await localScheduleDraftRepo.save(lease, input)
              await assertHostContext(context); return result
            })
          },
          async clear(lease: Parameters<typeof localScheduleDraftRepo.clear>[0]) {
            lease = { ...lease }
            return db.transaction("rw", db.meta, async () => {
              await assertHostContext(context); const result = await localScheduleDraftRepo.clear(lease)
              await assertHostContext(context); return result
            })
          },
          async commit(lease: Parameters<typeof localScheduleDraftRepo.commit>[0], draftId: string) {
            lease = { ...lease }
            return db.transaction("rw", db.schedules, db.meta, async () => {
              await assertHostContext(context); const result = await localScheduleDraftRepo.commit(lease, draftId)
              await assertHostContext(context); return result
            })
          },
        }
        await localScheduleHostRepo.validate(context)
        return createScheduleEditorSession(guardedDrafts, { lease: initial.lease, draft: initial.draft, status: initial.status }, initial.payload)
      },
      async discard(owner, lease) { ownerMatches(owner); return base.discard(owner, lease) },
      async setDeleted(owner, id, revision, deleted) { ownerMatches(owner); return base.setDeleted(owner, id, revision, deleted) },
      async convert(owner, id, revision, date) { ownerMatches(owner); return base.convert(owner, id, revision, date) },
      async inspectConversion(owner, id) { ownerMatches(owner); return base.inspectConversion(owner, id) },
    }
  },
  watch(context, expired) {
    context = { ...context }
    let stopped = false
    let timer: number | undefined
    let subscription: { unsubscribe(): void } | undefined
    function stop(): void {
      if (stopped) return
      stopped = true
      if (timer !== undefined) window.clearInterval(timer)
      subscription?.unsubscribe()
    }
    function revoke(reason: string): void { if (!stopped) { stop(); expired(reason) } }
    try {
      subscription = liveQuery(() => readHostOwner()).subscribe({
        next(owner) {
          if (owner.ownerUserId !== context.ownerUserId || owner.generation !== context.generation) revoke("本地归属或恢复批次已变化，请重新进入")
        },
        error() { revoke("无法持续确认本地归属，旧宿主已停止；请保留并检查数据") },
      })
      if (stopped) subscription.unsubscribe()
      else timer = window.setInterval(() => {
        try { assertHostAuth(context) } catch (error) { revoke(String(error)) }
      }, 250)
    } catch (error) { stop(); throw error }
    return stop
  },
  firstSaveFrame: readFirstSaveFrame,
  firstSave: commitFirstSave,
  openDiary: openDiaryTarget,
  saveDiary: saveDiaryTarget,
}
