import { assertScheduleEditorContent } from "@/shared/scheduleEditorContent"
import { assertDraftId, isDraftIso } from "@/shared/scheduleDrafts"
import { isBackupSchedule, scheduleContentTooNew } from "@/shared/scheduleBackup"
import { parseWorkspaceQuery, type ScheduleWorkspacePort } from "@/shared/scheduleWorkspace"

import { localScheduleDraftRepo } from "./scheduleDraftRepo"
import { localScheduleEditorRepo } from "./scheduleEditorRepo"
import { localScheduleRepo } from "./scheduleRepo"
import { localOwnerSnapshot, type LocalOwnerSnapshot } from "./scheduleStateRepo"
import { db } from "./schema"

async function guard(owner: LocalOwnerSnapshot): Promise<void> {
  const current = await localOwnerSnapshot()
  if (owner.ownerUserId !== current.ownerUserId || owner.generation !== current.generation) {
    throw Object.assign(new Error("本地账号或恢复批次已变化，请重新进入；旧页面动作已停止"),
      { code: "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED" })
  }
}
function validRevision(revision: string): void { if (!isDraftIso(revision)) throw new Error("预简来源修订无效") }
function sameOwner(owner: LocalOwnerSnapshot, lease: LocalOwnerSnapshot): void {
  if (owner.ownerUserId !== lease.ownerUserId || owner.generation !== lease.generation) throw new Error("草稿操作不属于本页面账号/恢复批次")
}
async function checked(id: string) {
  const row = await db.schedules.get(id)
  if (!row || !isBackupSchedule(row) || scheduleContentTooNew(row)) throw new Error("预简不存在或格式不受支持")
  return row
}

/** 页面注入端口；所有操作使用打开页面时的owner，入口/DEV和公共repo仍不导出。 */
export const localScheduleWorkspaceRepo: ScheduleWorkspacePort = {
  capture: () => db.transaction("r", db.meta, () => localOwnerSnapshot()),
  async validate(owner) { owner = { ...owner }; await db.transaction("r", db.meta, () => guard(owner)) },
  async load(owner, query) {
    owner = { ...owner }; query = parseWorkspaceQuery(query)
    return db.transaction("r", db.schedules, db.meta, async () => {
      await guard(owner)
      const params = { page: query.page, pageSize: query.pageSize, dateFrom: query.dateFrom, dateTo: query.dateTo,
        onlyDeleted: query.view === "deleted", status: query.view === "deleted" ? undefined : query.view }
      let records = await localScheduleRepo.list(params)
      const maxPage = Math.max(1, Math.ceil(records.total / query.pageSize))
      if (records.page > maxPage) records = await localScheduleRepo.list({ ...params, page: maxPage })
      return { records, recovery: await localScheduleDraftRepo.read() }
    })
  },
  async open(owner, target) {
    owner = { ...owner }; target = structuredClone(target)
    return db.transaction("r", db.schedules, db.meta, async () => {
      await guard(owner)
      if (target.kind === "new") return localScheduleEditorRepo.openNew(target.date)
      if (target.kind === "edit") {
        assertDraftId(target.id); validRevision(target.expectedClientUpdatedAt)
        const row = await checked(target.id)
        assertScheduleEditorContent(row.content)
        if (row.clientUpdatedAt !== target.expectedClientUpdatedAt) throw new Error("列表来源已变化，请重新读取后编辑")
        return localScheduleEditorRepo.openExisting(target.id)
      }
      if (target.kind !== "resume") throw new Error("预简编辑目标无效")
      sameOwner(owner, target.lease)
      const current = await localScheduleDraftRepo.read()
      if (current.lease.revision !== target.lease.revision) throw new Error("草稿已变化，请重新读取后恢复")
      return localScheduleEditorRepo.resume()
    })
  },
  async discard(owner, lease) {
    owner = { ...owner }; lease = { ...lease }; sameOwner(owner, lease)
    await db.transaction("rw", db.meta, async () => { await guard(owner); await localScheduleDraftRepo.clear(lease) })
  },
  async setDeleted(owner, id, expectedRevision, deleted) {
    owner = { ...owner }; assertDraftId(id); validRevision(expectedRevision)
    if (typeof deleted !== "boolean") throw new Error("预简删除/恢复操作无效")
    await db.transaction("rw", db.schedules, db.meta, async () => {
      await guard(owner)
      if ((await checked(id)).clientUpdatedAt !== expectedRevision) throw new Error("预简已变化，请重新读取后删除/恢复")
      if (deleted) await localScheduleRepo.remove(id); else await localScheduleRepo.restore(id)
    })
  },
  async convert(owner, id, expectedRevision, entryDate) {
    owner = { ...owner }; assertDraftId(id); validRevision(expectedRevision)
    return db.transaction("rw", db.schedules, db.entries, db.meta, async () => {
      await guard(owner)
      const source = await checked(id)
      if (source.status === "pending") assertScheduleEditorContent(source.content)
      const current = await localScheduleDraftRepo.read()
      if (source.status === "pending" && current.draft?.scheduleId === id) {
        throw new Error("此预简有安全草稿，请先正式保存或明确弃去后再转简")
      }
      return localScheduleRepo.convert(id, { expectedClientUpdatedAt: expectedRevision, entryDate })
    })
  },
  async inspectConversion(owner, id) {
    owner = { ...owner }; assertDraftId(id)
    // 复用转换核心的终态只读分支：外层复核status，绝不把pending来源当作查看来创建日记。
    return db.transaction("rw", db.schedules, db.entries, db.meta, async () => {
      await guard(owner)
      const source = await checked(id)
      if (source.status !== "converted") throw new Error("此预简尚未转简，查看结果不会代为转换")
      return localScheduleRepo.convert(id, { expectedClientUpdatedAt: source.clientUpdatedAt })
    })
  },
}
