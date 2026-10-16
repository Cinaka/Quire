import { checkScheduleResourceEvidence, serializeScheduleResourceEvidence } from "@/shared/scheduleResourceEvidence"
import { parseScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { digestScheduleResourceBytes } from "@/io/scheduleResourceConflictFile"
import { toPlainText } from "@/shared/text"
import type { Entry, EntryContent, Schedule, ScheduleConversion } from "@/shared/types"
import { RESOURCE_DEMO_OWNER } from "./identity"

export const RESOURCE_SOURCE_ID = "019a0300-1234-7000-8000-000000009901"
export const RESOURCE_MEDIA_ID = "019a0300-1234-7000-8000-000000009902"
export const RESOURCE_EPOCH = "p4-resource-acceptance-fixture/v1"
export const RESOURCE_FIXTURE_KEY = "p4ResourceFixture"
const AT = "2026-10-08T10:00:00.000Z", SERVER = "2026-10-08T10:00:02.000Z", DAY = "2026-10-09"
// A tiny non-private PNG. Original and thumbnail intentionally use the same fixture bytes.
export const RESOURCE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
export function resourceFixtureRows() {
  const text: EntryContent = { schemaVersion: 1, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "仅供隔离图片补齐验收" }] }] } }
  const pending: Schedule = { id: RESOURCE_SOURCE_ID, remindDate: DAY, title: "验收：图片补齐来源", content: text, contentText: toPlainText(text),
    status: "pending", convertedEntryId: null, convertedAt: null, createdAt: AT, updatedAt: AT, clientUpdatedAt: AT,
    serverUpdatedAt: "", deletedAt: null, isDeleted: 0, dirty: 1 }
  const first: Entry = { id: RESOURCE_SOURCE_ID, fromScheduleId: RESOURCE_SOURCE_ID, entryDate: DAY, sortOrder: 0,
    title: pending.title, content: text, contentText: pending.contentText, mood: null, weather: null, tagIds: [],
    createdAt: AT, updatedAt: AT, clientUpdatedAt: AT, serverUpdatedAt: "", deletedAt: null, isDeleted: 0, dirty: 1 }
  const rich: EntryContent = { schemaVersion: 1, doc: { type: "doc", content: [...text.doc.content!, { type: "image", attrs: { src: `local://media/${RESOURCE_MEDIA_ID}` } }] } }
  const entry: Entry = { ...first, title: "验收：受保护图片日记", content: rich, contentText: toPlainText(rich) }
  const source: Schedule = { ...pending, status: "converted", convertedEntryId: RESOURCE_SOURCE_ID, convertedAt: AT }
  const intention: ScheduleConversion = { scheduleId: RESOURCE_SOURCE_ID, source: pending, entry: first, queuedAt: AT, ownerUserId: RESOURCE_DEMO_OWNER, protectedMediaIds: [RESOURCE_MEDIA_ID] }
  const candidate = { scheduleId: RESOURCE_SOURCE_ID, kind: "conversion-entry", localEntry: entry, serverEntry: entry }
  return { source, entry, intention, candidate }
}
export function resourceFixtureMaterial(): string {
  const { source, entry, intention, candidate } = resourceFixtureRows()
  const { ownerUserId: _owner, ...portable } = intention
  return serializeScheduleResourceEvidence(checkScheduleResourceEvidence({ app: "quire", format: "terminal-local-resource-evidence", formatVersion: 1,
    exportedAt: AT, scheduleId: RESOURCE_SOURCE_ID, state: { source, entry, linkedEntries: [entry], intentions: [portable], candidates: [candidate], p2Conflicts: [] },
    mediaIds: [RESOURCE_MEDIA_ID], tagIds: [], media: [{ id: RESOURCE_MEDIA_ID, entryId: RESOURCE_SOURCE_ID, mime: "image/png", width: 1, height: 1,
      size: 68, sortOrder: 0, createdAt: AT, dirty: 1, orphanedAt: null, hadRemoteLink: false, hadThumbRemoteLink: false,
      blobBase64: RESOURCE_PNG, thumbBase64: RESOURCE_PNG, thumbMime: "image/png" }], tags: [], missingMediaIds: [], missingTagIds: [],
    completeLocalResources: true, entryPendingPurge: false, resolutionEnabled: false, meaning: "local_snapshot_not_cloud_confirmation_or_restore" }))
}
export async function resourceFixtureProof(): Promise<unknown> {
  const { source: s, entry: e } = resourceFixtureRows(), digest = await digestScheduleResourceBytes(RESOURCE_PNG)
  const proof = { read_only: true, resolution_enabled: false, proof_scope: "current_entry_resources", resource_state: "verified", resources_complete: true,
    review: { read_only: true, reviewable: true, reason: "terminal_review", receipt_known: true, first_entry_date: DAY, first_entry_deleted: false,
      schedule: { id: s.id, remind_date: s.remindDate, title: s.title, content: s.content, content_text: s.contentText, status: s.status,
        converted_entry_id: s.convertedEntryId, converted_at: s.convertedAt, client_updated_at: s.clientUpdatedAt, deleted_at: null, created_at: AT, updated_at: SERVER },
      entry: { id: e.id, from_schedule_id: e.fromScheduleId, entry_date: e.entryDate, sort_order: e.sortOrder, title: e.title, content: e.content,
        content_text: e.contentText, mood: null, weather: null, tag_ids: [], client_updated_at: e.clientUpdatedAt, deleted_at: null, created_at: AT, updated_at: SERVER }, entry_state: "active" },
    media_ids: [RESOURCE_MEDIA_ID], tag_ids: [], media: [{ id: RESOURCE_MEDIA_ID, entry_id: RESOURCE_SOURCE_ID, sort_order: 0, width: 1, height: 1, size: digest.size,
      created_at: AT, original: { state: "verified", ...digest, mime: "image/png" }, thumbnail: { state: "verified", ...digest, mime: "image/png" } }], tags: [], missing_media_ids: [], missing_tag_ids: [] }
  parseScheduleCloudResourceReview(proof, RESOURCE_SOURCE_ID)
  return proof
}
