/** Explicit wire identity fields only. Never walk/replace ordinary text, content or URLs. */
import { localUuidHex, normalizeUuidList, uuidToHex } from "@/shared/uuidHex"
import type { PushItemResult, WireEntry, WireMediaMeta, WireMediaMetaPush, WireTag } from "./wire"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("接口身份记录无效")
  return value as Record<string, unknown>
}
function nullableId(value: unknown): string | null {
  return value === null ? null : uuidToHex(value, true)
}
export function entryWire(value: unknown): WireEntry {
  const row = object(value)
  if (!Array.isArray(row.tag_ids)) throw new Error("日记标签身份清单无效")
  return { ...row, id: uuidToHex(row.id, true), tag_ids: normalizeUuidList(row.tag_ids, true),
    from_schedule_id: nullableId(row.from_schedule_id) } as unknown as WireEntry
}
export function tagWire(value: unknown): WireTag {
  const row = object(value)
  return { ...row, id: uuidToHex(row.id, true) } as unknown as WireTag
}
export function mediaWire(value: unknown): WireMediaMeta {
  const row = object(value)
  return { ...row, id: uuidToHex(row.id, true), entry_id: nullableId(row.entry_id) } as unknown as WireMediaMeta
}
export function uniqueWireRows<T extends { id: string }>(rows: unknown, decode: (row: unknown) => T): T[] {
  if (!Array.isArray(rows)) throw new Error("接口身份清单缺失")
  const parsed = rows.map(decode)
  normalizeUuidList(parsed.map(row => row.id), true)
  return parsed
}
export function assertEntryPush(row: WireEntry): void {
  localUuidHex(row.id)
  if (row.from_schedule_id !== null) localUuidHex(row.from_schedule_id)
  if (!Array.isArray(row.tag_ids)) throw new Error("本地标签身份清单无效")
  row.tag_ids.forEach(localUuidHex)
  normalizeUuidList(row.tag_ids, true)
}
export function assertTagPush(row: WireTag): void { localUuidHex(row.id) }
export function assertMediaPush(row: WireMediaMetaPush): void {
  localUuidHex(row.id)
  if (row.entry_id !== null) localUuidHex(row.entry_id)
}
export function pushAcks(raw: unknown, sent: readonly { id: string }[]): PushItemResult[] {
  if (!Array.isArray(raw) || raw.length !== sent.length) throw new Error("同步回执缺项或多项，未清除本地待同步状态")
  const expected = new Set(normalizeUuidList(sent.map(row => row.id), true))
  const seen = new Set<string>()
  return raw.map(value => {
    const row = object(value), id = uuidToHex(row.id, true)
    if (!expected.has(id) || seen.has(id) || !["applied", "stale", "error"].includes(String(row.status))) {
      throw new Error("同步回执身份重复或不属于本批次")
    }
    seen.add(id)
    let message = row.message
    if (message !== undefined && typeof message !== "string") throw new Error("同步回执说明无效")
    if (typeof message === "string" && message.startsWith("duplicate_tag:")) {
      message = `duplicate_tag:${uuidToHex(message.slice("duplicate_tag:".length), true)}`
    }
    return { ...row, id, ...(message === undefined ? {} : { message }) } as unknown as PushItemResult
  })
}
