import { assertDualResourceTarget, checkDualResourceEvidence } from "./scheduleDualResourceEvidence"
import type { ScheduleDualResourceEvidence } from "./scheduleDualResourceEvidence"
import { conversionCanonical, conversionCopy, conversionUtc } from "./scheduleConversionSync"
import { terminalVersionKey } from "./scheduleTerminalConflict"
import { scheduleEntryId } from "./schedules"

/** Structural eligibility, never authorization by the file alone. IO/live checks remain mandatory. */
export function assertDualCloudAdoption(evidence: ScheduleDualResourceEvidence) {
  const value = checkDualResourceEvidence(evidence), local = value.local, state = local.state
  const cloud = assertDualResourceTarget(local, value.cloud)
  if (!cloud.media.length || state.linkedEntries.length !== 1 || !state.entry ||
      conversionCanonical(state.entry) !== conversionCanonical(state.linkedEntries[0]) ||
      state.intentions.length > 1 || !state.candidates.length || state.p2Conflicts.length ||
      conversionCanonical([...local.mediaIds].sort()) !== conversionCanonical(cloud.mediaIds) ||
      conversionCanonical([...local.tagIds].sort()) !== conversionCanonical(cloud.tagIds)) {
    throw new Error("图片集合、稳定关联或其他保护尚不能采用云端版本")
  }
  for (const media of local.media) {
    if (media.entryId !== value.scheduleId || media.orphanedAt !== null) throw new Error("孤儿或其他归属媒体不能替换")
  }
  for (const proof of cloud.tags) {
    const tag = local.tags.find(item => item.id === proof.id)
    if (!tag || tag.name !== proof.name || tag.color !== proof.color) throw new Error("共享标签不同，不能覆盖")
  }
  return cloud
}

/** Preserve first-occurrence document order, and never rewrite literal text or unrelated attributes. */
export function localKeepImageIds(evidence: ScheduleDualResourceEvidence): string[] {
  assertDualCloudAdoption(evidence)
  const ids: string[] = [], stack: Array<{ value: unknown; depth: number }> = [{ value: evidence.local.state.entry!.content, depth: 0 }]
  let work = 0
  while (stack.length) {
    const { value, depth } = stack.pop()!
    if (++work > 100000 || depth > 64) throw new Error("本机正文过深或过大")
    if (!value || typeof value !== "object") continue
    const node = value as Record<string, unknown>
    if (node.type === "image") {
      const attrs = node.attrs as { src?: unknown } | null
      const src = attrs?.src
      if (typeof src !== "string" || !src.startsWith("local://media/")) throw new Error("图片引用不是本机媒体")
      const id = src.slice("local://media/".length)
      if (!evidence.local.media.some(row => row.id === id)) throw new Error("本机图片实物缺失")
      if (!ids.includes(id)) ids.push(id)
    }
    const children = Object.values(node)
    for (let index = children.length - 1; index >= 0; index--) stack.push({ value: children[index], depth: depth + 1 })
  }
  return ids
}

/** Fresh-ID plan only. It neither generates IDs nor mutates the file, first intent or database. */
export function planDualLocalKeep(evidence: ScheduleDualResourceEvidence, mapping: ReadonlyMap<string, string>, now: string) {
  const ids = localKeepImageIds(evidence), cloud = assertDualCloudAdoption(evidence)
  if (mapping.size !== ids.length || ids.some(id => !mapping.has(id)) ||
      new Set(mapping.values()).size !== mapping.size || [...mapping.values()].some(id =>
        typeof id !== "string" || scheduleEntryId(id) !== id || evidence.local.mediaIds.includes(id))) {
    throw new Error("本机图片必须完整映射到互不重复的新身份")
  }
  const entry = conversionCopy(evidence.local.state.entry!), remote = cloud.review.entry!
  const clock = conversionUtc(now)
  const previous = Math.max(Date.parse(terminalVersionKey(entry.clientUpdatedAt)), Date.parse(terminalVersionKey(remote.clientUpdatedAt)))
  const revision = conversionUtc(new Date(Math.max(previous + 1, Date.parse(clock))).toISOString())
  const stack: unknown[] = [entry.content]
  while (stack.length) {
    const value = stack.pop()
    if (!value || typeof value !== "object") continue
    const node = value as Record<string, unknown>
    if (node.type === "image") {
      const attrs = node.attrs as { src: string }, oldId = attrs.src.slice("local://media/".length)
      const next = mapping.get(oldId)
      if (!next) throw new Error("图片身份映射缺失")
      attrs.src = `local://media/${next}`
    }
    for (const child of Object.values(node)) stack.push(child)
  }
  const media = ids.map((id, sortOrder) => ({ ...conversionCopy(evidence.local.media.find(row => row.id === id)!),
    id: mapping.get(id)!, entryId: evidence.scheduleId, sortOrder, createdAt: clock, dirty: 1 as const,
    orphanedAt: null, hadRemoteLink: false, hadThumbRemoteLink: false }))
  return { entry: { ...entry, updatedAt: revision, clientUpdatedAt: revision, serverUpdatedAt: remote.serverUpdatedAt, dirty: 1 as const },
    media, resourceIdMap: ids.map(from => ({ from, to: mapping.get(from)! })) }
}
