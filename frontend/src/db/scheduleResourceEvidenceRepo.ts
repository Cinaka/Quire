import { captureSyncContext } from "@/api/syncContext"
import { conversionCanonical, conversionCopy, conversionUtc } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import { parseScheduleDraftState } from "@/shared/scheduleDrafts"
import { checkScheduleResourceEvidence, resourceEvidenceReferences, RESOURCE_EVIDENCE_MAX_BINARY } from "@/shared/scheduleResourceEvidence"
import type { ResourceEvidenceMedia, ResourceEvidenceState } from "@/shared/scheduleResourceEvidence"
import { SCHEDULE_META_KEYS, scheduleEntryId } from "@/shared/schedules"
import type { MediaItem, ScheduleConversion } from "@/shared/types"

import { assertScheduleLease, readCheckedConversionQueue } from "./scheduleSyncStateRepo"
import { db } from "./schema"

function portable(raw: unknown, owner: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("首次意图结构无效")
  const row = raw as ScheduleConversion
  if (row.ownerUserId !== owner || Object.keys(row).some(key => !["scheduleId", "source", "entry", "queuedAt", "ownerUserId", "protectedMediaIds"].includes(key))) throw new Error("首次意图归属或字段未知")
  const { ownerUserId: _owner, ...rest } = row
  return conversionCopy(rest)
}
async function records(key: string): Promise<unknown[]> {
  const row = await db.meta.get(key)
  if (row && !Array.isArray(row.value)) throw new Error("冲突元数据损坏")
  return row?.value as unknown[] ?? []
}
export async function captureScheduleResourceSnapshot(id: string, lease: ConversionLease) {
  return db.transaction("r", db.schedules, db.entries, db.tags, db.media, db.meta, async () => {
    await assertScheduleLease(lease)
    const draft = (await db.meta.get(SCHEDULE_META_KEYS.draft))?.value ?? null
    const diaryDraft = (await db.meta.get("draft"))?.value ?? null
    if ((draft !== null && parseScheduleDraftState(draft).draft !== null) || diaryDraft !== null) throw new Error("请先明确处理未保存草稿，证据不包含未保存输入")
    const queue = (await readCheckedConversionQueue(lease.ownerUserId)).filter(row => row.scheduleId === id)
    const candidates = (await records(SCHEDULE_META_KEYS.conflicts)).filter(raw => raw && typeof raw === "object" && "scheduleId" in raw && raw.scheduleId === id)
      .map(raw => { const row = conversionCopy(raw) as Record<string, unknown>; if ("firstIntent" in row) row.firstIntent = portable(row.firstIntent, lease.ownerUserId); return row })
    const p2Conflicts = (await records("conflicts")).filter(raw => {
      if (!raw || typeof raw !== "object") return false
      const row = raw as { entryId?: unknown; local?: { id?: unknown }; server?: { id?: unknown } }
      return (row.entryId ?? row.local?.id ?? row.server?.id) === id
    })
    const state: ResourceEvidenceState = { source: await db.schedules.get(id) ?? null, entry: await db.entries.get(id) ?? null,
      linkedEntries: await db.entries.where("fromScheduleId").equals(id).toArray(), intentions: queue.map(row => portable(row, lease.ownerUserId)), candidates, p2Conflicts }
    if (!state.source || (!candidates.length && !queue.length && !p2Conflicts.length)) throw new Error("没有该来源的待保全冲突或意图")
    const refs = resourceEvidenceReferences(state, id)
    const media = await db.media.where("entryId").equals(id).toArray()
    for (const resourceId of refs.mediaIds) if (!media.some(row => row.id === resourceId)) { const row = await db.media.get(resourceId); if (row) media.push(row) }
    media.sort((a, b) => a.id.localeCompare(b.id))
    const tags = []
    for (const tagId of refs.tagIds) { const tag = await db.tags.get(tagId); if (tag) tags.push(tag) }
    const purges = (await db.meta.get("pendingPurges"))?.value ?? []
    if (!Array.isArray(purges) || purges.some(value => typeof value !== "string" || !value)) throw new Error("弃去队列损坏")
    await assertScheduleLease(lease)
    return { state: conversionCopy(state), media, tags, mediaIds: [...new Set([...refs.mediaIds, ...media.map(row => row.id)])].sort(), tagIds: refs.tagIds, draft, purges }
  })
}
async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
  return btoa(chunks.join(""))
}
export async function encodeScheduleResourceSnapshot(snapshot: Awaited<ReturnType<typeof captureScheduleResourceSnapshot>>, id: string, lease: ConversionLease) {
  const media: ResourceEvidenceMedia[] = []; let binary = 0
  for (const row of snapshot.media as MediaItem[]) {
    const keys = ["id", "entryId", "blob", "thumbBlob", "mime", "width", "height", "size", "sortOrder", "remoteUrl", "thumbRemoteUrl", "createdAt", "dirty", "orphanedAt"]
    if (Object.keys(row).some(key => !keys.includes(key)) || ![id, ""].includes(row.entryId) || !(row.blob instanceof Blob) ||
        !(row.thumbBlob === null || row.thumbBlob instanceof Blob) || typeof row.remoteUrl !== "string" ||
        (row.thumbRemoteUrl !== undefined && typeof row.thumbRemoteUrl !== "string")) throw new Error("媒体行未知或属于其他日记，未导出")
    binary += row.blob.size + (row.thumbBlob?.size ?? 0)
    if (binary > RESOURCE_EVIDENCE_MAX_BINARY) throw new Error("资源证据超过16MiB限制，请保留原库")
    if (row.blob.size === 0) continue // Remote placeholder is a missing local resource, never a complete image.
    if (row.blob.size !== row.size) throw new Error("媒体字节与声明大小不一致")
    await assertScheduleLease(lease)
    media.push({ id: row.id, entryId: row.entryId, mime: row.mime, width: row.width, height: row.height,
      size: row.size, sortOrder: row.sortOrder, createdAt: row.createdAt, dirty: row.dirty, orphanedAt: row.orphanedAt ?? null,
      hadRemoteLink: Boolean(row.remoteUrl), hadThumbRemoteLink: Boolean(row.thumbRemoteUrl),
      blobBase64: await base64(row.blob), thumbBase64: row.thumbBlob ? await base64(row.thumbBlob) : null,
      thumbMime: row.thumbBlob ? row.thumbBlob.type || null : null })
    await assertScheduleLease(lease)
  }
  return { state: snapshot.state, media, tags: snapshot.tags, mediaIds: snapshot.mediaIds, tagIds: snapshot.tagIds, draft: snapshot.draft, purges: snapshot.purges }
}
/** Internal reuse only; capture and encode retain their existing read-only behavior. */
export function scheduleResourceSnapshotEvidence(value: Awaited<ReturnType<typeof encodeScheduleResourceSnapshot>>, id: string) {
  const { draft: _draft, purges: _purges, ...portableValue } = value
  const gotMedia = new Set(value.media.map(row => row.id)), gotTags = new Set(value.tags.map(row => row.id))
  const missingMediaIds = value.mediaIds.filter(key => !gotMedia.has(key)), missingTagIds = value.tagIds.filter(key => !gotTags.has(key))
  return checkScheduleResourceEvidence({ app: "quire", format: "terminal-local-resource-evidence", formatVersion: 1,
    exportedAt: conversionUtc(new Date().toISOString()), scheduleId: id, ...portableValue, missingMediaIds, missingTagIds,
    completeLocalResources: !missingMediaIds.length && !missingTagIds.length, entryPendingPurge: value.purges.includes(id), resolutionEnabled: false,
    meaning: "local_snapshot_not_cloud_confirmation_or_restore" })
}
/** Read-only local bytes evidence. No GET/download/upload, archive, restore, ACK or protection release. */
export function createInternalScheduleResourceEvidenceExporter() {
  let busy = false
  return { async export(id: string) {
    if (busy) return { ready: false, reason: "busy", resolutionEnabled: false }
    busy = true
    try {
      if (scheduleEntryId(id) !== id) throw new Error("来源ID无效")
      const lease = await captureSyncContext(), first = await captureScheduleResourceSnapshot(id, lease)
      const value = await encodeScheduleResourceSnapshot(first, id, lease), second = await captureScheduleResourceSnapshot(id, lease)
      const verified = await encodeScheduleResourceSnapshot(second, id, lease)
      if (conversionCanonical(value) !== conversionCanonical(verified)) throw new Error("保全期间正文、候选、标签或媒体字节已变化")
      const last = await captureScheduleResourceSnapshot(id, lease)
      // Capture/encode is not a long Dexie transaction. Compare the final metadata boundary too.
      if (conversionCanonical(last) !== conversionCanonical(second)) throw new Error("保全期间数据已变化")
      await assertScheduleLease(lease)
      const evidence = scheduleResourceSnapshotEvidence(value, id)
      return { ready: true, reason: evidence.completeLocalResources ? "local_resources_captured" : "missing_local_resources", resolutionEnabled: false, evidence }
    } catch { return { ready: false, reason: "resource_evidence_unconfirmed", resolutionEnabled: false } }
    finally { busy = false }
  } }
}
