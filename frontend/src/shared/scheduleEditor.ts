import type {
  ScheduleDraftCommitResult, ScheduleDraftLease, ScheduleDraftReadResult,
} from "@/db/scheduleDraftRepo"
import type { localScheduleDraftRepo } from "@/db/scheduleDraftRepo"

import { parseScheduleDraftPayload, type ScheduleDraftPayload } from "./scheduleDrafts"
import type { EntryContent, LocalDate } from "./types"

export interface ScheduleEditorBody { remindDate: LocalDate; title: string; content: EntryContent | null }
type DraftPort = Pick<typeof localScheduleDraftRepo, "save" | "clear" | "commit">
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 内部无Vue/定时器控制层：每次编辑调用persist；路由离开先await flush，再close。 */
export function createScheduleEditorSession(
  port: DraftPort, initial: ScheduleDraftReadResult, initialPayload: ScheduleDraftPayload,
) {
  let current = copy(initial)
  let payload = parseScheduleDraftPayload(initialPayload)
  let closed = false
  let tail: Promise<unknown> = Promise.resolve()
  let lastFailure: unknown = null
  function active(): void {
    if (closed) throw new Error("预简编辑会话已关闭，旧任务已停止")
  }
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => { active(); return work() })
    tail = result.then(() => { lastFailure = null }, error => { lastFailure = error })
    return result
  }
  function snapshotBody(body: ScheduleEditorBody): ScheduleEditorBody {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["remindDate", "title", "content"].includes(key))) {
      throw new Error("预简编辑正文载荷无效，不接受来源身份或日记元信息")
    }
    // 同步校验、复制传入正文；排队期间调用者的编辑不得改变已安排的任务。
    const parsed = parseScheduleDraftPayload({ ...body, scheduleId: null, baseClientUpdatedAt: null })
    return { remindDate: parsed.remindDate, title: parsed.title, content: parsed.content }
  }
  async function write(body: ScheduleEditorBody): Promise<ScheduleDraftReadResult> {
    const nextPayload = { ...payload, ...body }
    const result = await port.save(current.lease, { ...nextPayload, draftId: current.draft?.draftId ?? null })
    // close不能中止已经进入存储事务的写入；禁止其结果复活已关闭控制器。
    active()
    current = copy(result)
    payload = parseScheduleDraftPayload(nextPayload)
    return copy(current)
  }
  return {
    inspect() { return copy({ ...current, payload, closed }) },
    persist(body: ScheduleEditorBody): Promise<ScheduleDraftReadResult> {
      let snapshot: ScheduleEditorBody
      try { active(); snapshot = snapshotBody(body) } catch (error) { return Promise.reject(error) }
      return enqueue(() => write(snapshot))
    },
    /** 点击正式保存时传当前编辑快照；排在先前草稿任务后，不依赖防抖是否触发。 */
    submit(body: ScheduleEditorBody): Promise<ScheduleDraftCommitResult> {
      let snapshot: ScheduleEditorBody
      try { active(); snapshot = snapshotBody(body) } catch (error) { return Promise.reject(error) }
      return enqueue(async () => {
        const saved = await write(snapshot)
        const result = await port.commit(saved.lease, saved.draft!.draftId)
        active()
        const row = result.schedule
        payload = parseScheduleDraftPayload({ scheduleId: row.id, baseClientUpdatedAt: row.clientUpdatedAt,
          remindDate: row.remindDate, title: row.title, content: row.content })
        current = { lease: copy(result.lease), draft: null, status: "empty" }
        return copy(result)
      })
    },
    /** 明确弃去，不隐式导航/清库；随后停止该会话，不让排队编辑复活草稿。 */
    discard(): Promise<ScheduleDraftLease> {
      return enqueue(async () => {
        const lease = await port.clear(current.lease)
        active()
        current = { lease: copy(lease), draft: null, status: "empty" }
        closed = true
        return copy(lease)
      })
    },
    async flush(): Promise<void> {
      await tail
      if (lastFailure !== null) throw lastFailure
      active()
    },
    /** 同步停掉未开始的任务；已经进入的事务仍由owner/CAS守卫控制，可能完成。 */
    close(): void { closed = true },
  }
}
