import { checkBackup } from "./backup"
import type { BackupFile, ImportConflict } from "./backup"
import { normalizeUuidList, uuidToHex } from "./uuidHex"

/** Public UUID32 restore policy: legacy identities may only be imported as NEW copies. */
export function checkUuid32Backup(raw: unknown, strategy: ImportConflict): BackupFile {
  if (!["preferNewer", "keepLocal", "asCopy"].includes(strategy)) throw new Error("备份取舍策略无效")
  const checked = checkBackup(raw)
  if (!checked.ok) throw new Error(checked.reason)
  const file = checked.file
  if (!file.counts || file.counts.entries !== file.entries.length ||
      file.counts.tags !== file.tags.length || file.counts.media !== file.media.length) {
    throw new Error("备份数量校验失败，未导入")
  }
  let legacy = false
  const identity = (value: unknown): string => {
    const hex = uuidToHex(value, true)
    if (hex !== value) legacy = true
    return hex
  }
  const domain = (rows: readonly { id: string }[]): Map<string, string> => {
    const result = new Map<string, string>()
    for (const row of rows) {
      const id = identity(row?.id)
      if (result.has(id)) throw new Error("备份含重复身份或32/36位别名冲突，未导入")
      result.set(id, row.id)
    }
    return result
  }
  const entries = domain(file.entries), tags = domain(file.tags), media = domain(file.media)
  const schedules = domain(file.schedules ?? [])
  const reference = (value: unknown, table: Map<string, string>, requirePresent = false) => {
    const hex = identity(value), original = table.get(hex)
    if (original !== undefined && original !== value) throw new Error("备份关联混用同一UUID的不同表示，未猜测合并")
    if (strategy === "asCopy" && requirePresent && original === undefined) throw new Error("副本备份缺少关联资源，未保留旧身份或部分导入")
  }
  const ids = (values: unknown, table: Map<string, string>, requirePresent = false) => {
    if (!Array.isArray(values)) throw new Error("备份身份清单无效")
    normalizeUuidList(values, true)
    values.forEach(value => reference(value, table, requirePresent))
  }
  const content = (rawContent: unknown) => {
    const stack: unknown[] = [rawContent], seen = new Set<object>()
    let count = 0
    while (stack.length) {
      const value = stack.pop()
      if (!value || typeof value !== "object") continue
      if (++count > 200_000 || seen.has(value)) throw new Error("备份正文循环或结构过大，未导入")
      seen.add(value)
      const node = value as Record<string, unknown>
      if (node.type === "image" && node.attrs && typeof node.attrs === "object") {
        const src = (node.attrs as Record<string, unknown>).src
        if (typeof src === "string" && src.startsWith("local://media/")) reference(src.slice("local://media/".length), media, true)
      }
      // Explicit document tree only, never ordinary text, URLs or arbitrary strings.
      if (node.doc !== undefined) stack.push(node.doc)
      if (Array.isArray(node.content)) stack.push(...node.content)
    }
  }
  const entry = (row: BackupFile["entries"][number]) => {
    identity(row.id); ids(row.tagIds ?? [], tags, true)
    if (row.fromScheduleId != null) reference(row.fromScheduleId, schedules)
    content(row.content)
  }
  file.entries.forEach(entry)
  for (const row of file.media) {
    if (row.entryId) {
      const id = identity(row.entryId)
      const table = entries.has(id) ? entries : schedules
      reference(row.entryId, table, true)
    }
  }
  for (const row of file.schedules ?? []) {
    if (row.convertedEntryId !== null) reference(row.convertedEntryId, schedules)
    content(row.content)
  }
  for (const row of file.scheduleConversions ?? []) {
    reference(row.scheduleId, schedules)
    reference(row.source.id, schedules)
    entry(row.entry)
    content(row.source.content)
    ids(row.protectedMediaIds ?? [], media, true)
  }
  if (file.scheduleDraft) {
    identity(file.scheduleDraft.draftId)
    if (file.scheduleDraft.scheduleId !== null) reference(file.scheduleDraft.scheduleId, schedules)
    content(file.scheduleDraft.content)
  }
  if (legacy && strategy !== "asCopy") throw new Error("旧UUID备份只允许选择“作为新副本导入”；不会直接重放旧身份、队列或历史回执")
  return file
}
