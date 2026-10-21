import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { assertDualResourceAdoptionBase } from "./scheduleDualResourceAdoption"
import { checkDualResourceEvidence } from "./scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "./scheduleDualResourceEvidence"
import { terminalVersionKey } from "./scheduleTerminalConflict"
import { scheduleEntryId } from "./schedules"
import type { Tag } from "./types"

export const SHARED_TAG_COPY_KIND = "terminal-independent-tag-copy"
export interface SharedTagCopyName { from: string; name: string }
export type SharedTagCopyChoice = "cloud-source-use-diary" | "cloud-source-keep-diary"
export interface SharedTagCopyRecord {
  kind: typeof SHARED_TAG_COPY_KIND; version: 1; id: string; scheduleId: string
  ownerUserId: string; generation: string; state: "prepared" | "discarded"
  choice: SharedTagCopyChoice; createdAt: string; names: SharedTagCopyName[]
  copies: Array<{ from: string; tag: Tag }>; originalTagIds: string[]
  evidence: ScheduleDualResourceEvidence; catalog: Tag[]
}
// A conservative ambiguity key, not a complete MySQL collation implementation.
export const sharedTagNameKey = (name: string) => name.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase()
function object(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== keys.length ||
      keys.some(key => !(key in raw))) throw new Error("独立标签准备结构未知，保留保护")
  return raw as Record<string, unknown>
}
function resourceId(raw: unknown): string {
  if (typeof raw !== "string" || scheduleEntryId(raw) !== raw) throw new Error("标签准备身份无效")
  return raw
}
export function sharedTagCatalog(raw: unknown): Tag[] {
  if (!Array.isArray(raw) || raw.length > 10000) throw new Error("本机标签目录无法完整核对")
  const seen = new Set<string>()
  const tags = raw.map(value => {
    const row = object(value, ["id", "name", "color", "createdAt", "dirty"])
    const id = resourceId(row.id)
    if (seen.has(id) || typeof row.name !== "string" || !row.name.length ||
        !(row.color === null || typeof row.color === "string") || ![0, 1].includes(row.dirty as number)) {
      throw new Error("本机标签目录损坏")
    }
    if (typeof row.createdAt !== "string") throw new Error("标签时间无效")
    seen.add(id); terminalVersionKey(row.createdAt)
    return conversionCopy(row) as unknown as Tag
  })
  return tags.sort((a, b) => a.id.localeCompare(b.id))
}
export function sharedTagCopySelection(evidence: ScheduleDualResourceEvidence, choice: SharedTagCopyChoice,
  input: unknown, catalog: Tag[]) {
  const cloud = assertDualResourceAdoptionBase(evidence)
  if (!["cloud-source-use-diary", "cloud-source-keep-diary"].includes(choice)) throw new Error("请明确选择日记版本")
  const selected = choice === "cloud-source-keep-diary" ? evidence.local.state.entry! : cloud.review.entry!
  if (!selected.tagIds.length || selected.tagIds.length > 64 || !Array.isArray(input) || input.length !== selected.tagIds.length) {
    throw new Error("请为选定日记的每个标签明确填写独立名称")
  }
  const supplied = input.map(value => {
    const row = object(value, ["from", "name"]), from = resourceId(row.from)
    if (typeof row.name !== "string" || row.name !== row.name.trim() || !sharedTagNameKey(row.name) || row.name.length > 32) {
      throw new Error("独立标签名称须为1至32字符，且不含首尾空格")
    }
    return { from, name: row.name }
  })
  if (new Set(supplied.map(row => row.from)).size !== supplied.length || supplied.some(row => !selected.tagIds.includes(row.from))) {
    throw new Error("独立标签命名与所选日记引用不一致")
  }
  const occupied = new Set([...catalog.map(tag => sharedTagNameKey(tag.name)), ...cloud.tags.map(tag => sharedTagNameKey(tag.name))])
  const picked = new Set<string>()
  const names = selected.tagIds.map(from => {
    const row = supplied.find(item => item.from === from)!, key = sharedTagNameKey(row.name)
    if (occupied.has(key) || picked.has(key)) throw new Error("新名称与已有或另一新标签同名/近似同名，未自动改名")
    picked.add(key); return row
  })
  const definitions = selected.tagIds.map(id => {
    const row = (choice === "cloud-source-keep-diary" ? evidence.local.tags : cloud.tags).find(tag => tag.id === id)
    if (!row || !(row.color === null || typeof row.color === "string" && row.color.length <= 16)) throw new Error("所选标签定义不完整或不受支持")
    return { id, color: row.color }
  })
  return { names, definitions, originalTagIds: [...new Set([...evidence.local.tagIds, ...cloud.tagIds])].sort() }
}
export function checkSharedTagCopyRecord(raw: unknown): SharedTagCopyRecord {
  const row = object(raw, ["kind", "version", "id", "scheduleId", "ownerUserId", "generation", "state", "choice", "createdAt", "names", "copies", "originalTagIds", "evidence", "catalog"])
  if (row.kind !== SHARED_TAG_COPY_KIND || row.version !== 1 || !["prepared", "discarded"].includes(row.state as string) ||
      typeof row.ownerUserId !== "string" || !row.ownerUserId || typeof row.generation !== "string" || !row.generation) throw new Error("独立标签准备状态未知")
  const id = resourceId(row.id), scheduleId = resourceId(row.scheduleId), at = conversionUtc(row.createdAt)
  const evidence = checkDualResourceEvidence(row.evidence), catalog = sharedTagCatalog(row.catalog)
  if (evidence.scheduleId !== scheduleId || at !== row.createdAt || !Array.isArray(row.copies)) throw new Error("独立标签准备来源不一致")
  const selection = sharedTagCopySelection(evidence, row.choice as SharedTagCopyChoice, row.names, catalog)
  if (conversionCanonical(selection.names) !== conversionCanonical(row.names) ||
      conversionCanonical(selection.originalTagIds) !== conversionCanonical(row.originalTagIds) || row.copies.length !== selection.names.length) throw new Error("独立标签保护集合不完整")
  const occupied = new Set([id, scheduleId, ...evidence.local.mediaIds, ...assertDualResourceAdoptionBase(evidence).mediaIds,
    ...selection.originalTagIds, ...catalog.map(tag => tag.id)])
  for (let index = 0; index < row.copies.length; index++) {
    const copy = object(row.copies[index], ["from", "tag"]), tag = object(copy.tag, ["id", "name", "color", "createdAt", "dirty"])
    const next = resourceId(tag.id), wanted = selection.names[index]!, definition = selection.definitions[index]!
    if (occupied.has(next) || copy.from !== wanted.from || tag.name !== wanted.name || tag.color !== definition.color ||
        tag.createdAt !== at || tag.dirty !== 1) throw new Error("独立标签副本或身份映射无效")
    occupied.add(next)
  }
  if (id === scheduleId || selection.originalTagIds.includes(id) || evidence.local.mediaIds.includes(id) || assertDualResourceAdoptionBase(evidence).mediaIds.includes(id) ||
      catalog.some(tag => tag.id === id)) throw new Error("准备记录身份碰撞")
  return conversionCopy(row) as unknown as SharedTagCopyRecord
}

/** Reserved identities remain unique even after an unpublished plan is discarded. */
export function sharedTagCopyArchivePlans(rows: unknown[]): SharedTagCopyRecord[] {
  const plans = rows.filter(row => row && typeof row === "object" && "kind" in row && row.kind === SHARED_TAG_COPY_KIND)
    .map(checkSharedTagCopyRecord)
  const reserved = new Set<string>()
  for (const plan of plans) for (const id of [plan.id, ...plan.copies.map(copy => copy.tag.id)]) {
    if (reserved.has(id)) throw new Error("独立标签准备身份重复")
    reserved.add(id)
  }
  return plans
}
