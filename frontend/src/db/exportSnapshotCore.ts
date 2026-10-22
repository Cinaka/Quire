import { compileExportSelection, createExportSelectionAccumulator, type ExportSelectionPlan, type ExportSelectionRequest } from "@/shared/exportScope"
import { projectNotebookContent } from "@/shared/notebookContent"
import { createExportJsonMeter, freezeExportValue, ExportSnapshotError, EXPORT_SNAPSHOT_LIMITS as limits, type ExportSnapshot, type ExportSnapshotEntry, type ExportSnapshotMedia, type ExportDiagnostic } from "@/shared/exportSnapshot"
import type { Entry, Tag, MediaItem } from "@/shared/types"
import type { NotebookReadLease } from "./notebookReadCore"

export interface ExportSnapshotHandle {
  read(): Promise<ExportSnapshot>
  /** Releases application references, not OS output or a consumer's retained copy. */
  release(): void
}
export interface ExportSnapshotPort {
  capture(request: ExportSelectionRequest, signal?: AbortSignal): Promise<ExportSnapshotHandle>
  assertCurrent(): Promise<void>
  subscribeInvalidated(listener: () => void): () => void
  close(): void
}
export interface ExportSnapshotIO {
  /** Exactly one read-only transaction for all snapshot data below. */
  read<T>(work: () => Promise<T>): Promise<T>
  owner(): Promise<{ ownerUserId: string; generation: string }>
  auth(): { subject: string; generation: number; valid: boolean }
  /** ID lookup or indexed active/date candidates; callback is synchronous. */
  scan(plan: ExportSelectionPlan, visit: (entry: Entry) => void): Promise<void>
  tag(id: string): Promise<Tag | undefined>
  media(id: string): Promise<MediaItem | undefined>
  observeIdentity(changed: () => void, failed: () => void): () => void
  now(): number
  monotonic(): number
}
const fail = (code: string): never => { throw new ExportSnapshotError(code) }
const textOrNull = (v: unknown): boolean => v === null || typeof v === "string"
/** Same has-image meaning as the ordinary list: any nonempty local reference.
 * Bounded JSON accounting has run BEFORE traversing this candidate. Invalid UUIDs
 * still match the filter but receive controlled-content diagnostics, not a fetch. */
function hasReferencedImage(content: unknown, check: () => void): boolean {
  const root = content && typeof content === "object" ? (content as { doc?: unknown }).doc : null
  const pending: unknown[] = [root]
  while (pending.length) {
    check(); const node = pending.pop()
    if (!node || typeof node !== "object") continue
    const n = node as { type?: unknown; attrs?: { src?: unknown }; content?: unknown[] }
    if (n.type === "image" && typeof n.attrs?.src === "string" && n.attrs.src.startsWith("local://media/") && n.attrs.src.length > 14) return true
    if (Array.isArray(n.content)) for (const child of n.content) pending.push(child)
  }
  return false
}
/** Internal constructor. Only the verified session factory may supply its lease;
 * never export this constructor or a caller-supplied lease via @/repo. */
export function createExportSnapshotCore(io: ExportSnapshotIO, source: NotebookReadLease): ExportSnapshotPort {
  const lease = { ...source }
  let closed = false, version = 0, stopIdentity: (() => void) | undefined
  const handles = new Set<() => void>(), invalidated = new Set<() => void>()
  function releaseHandles(): void { for (const release of [...handles]) release() }
  function close(): void {
    if (closed) return
    closed = true; version++; releaseHandles()
    const stop = stopIdentity; stopIdentity = undefined
    try { stop?.() } catch { /* still clear every consumer */ }
    for (const listener of [...invalidated]) { try { listener() } catch { /* clear every consumer */ } }
    invalidated.clear()
  }
  function auth(): void {
    const current = io.auth()
    if (closed || !lease.ownerUserId || !current.valid || current.subject !== lease.ownerUserId || current.generation !== lease.authGeneration) { close(); fail("EXPORT_CONTEXT_EXPIRED") }
  }
  async function assertCurrent(): Promise<void> {
    try {
      auth(); const owner = await io.owner(); auth()
      if (owner.ownerUserId !== lease.ownerUserId || owner.generation !== lease.generation) { close(); fail("EXPORT_CONTEXT_EXPIRED") }
    } catch (error) { close(); throw error }
  }
  stopIdentity = io.observeIdentity(() => { void assertCurrent().catch(() => {}) }, close)
  if (closed) { const stop = stopIdentity; stopIdentity = undefined; try { stop?.() } catch { /* already closed */ } }
  return {
    assertCurrent, close,
    subscribeInvalidated(listener) {
      if (closed) { listener(); return () => {} }
      invalidated.add(listener); return () => { invalidated.delete(listener) }
    },
    async capture(request, signal) {
      // Clone criteria synchronously, so later mutation cannot retarget this task.
      const selection = compileExportSelection(request)
      auth(); const task = ++version; releaseHandles()
      let handleRelease: (() => void) | undefined
      const abort = () => { if (task === version) { version++; handleRelease?.() } }
      signal?.addEventListener("abort", abort, { once: true })
      const deadline = io.monotonic() + limits.stageMs
      const check = () => {
        auth()
        if (signal?.aborted) fail("EXPORT_CANCELLED")
        if (task !== version) fail("EXPORT_TASK_REPLACED")
        if (io.monotonic() > deadline) fail("EXPORT_SNAPSHOT_TIMEOUT")
      }
      try {
        check(); await assertCurrent(); check()
        const model = await io.read(async () => {
          check(); await assertCurrent(); check()
          const capturedAt = io.now(), members = createExportSelectionAccumulator(selection)
          const selected = new Map<string, Entry>(), projections = new Map<string, ReturnType<typeof projectNotebookContent>>()
          const scanMeter = createExportJsonMeter(limits.scanBytes, limits.scanNodes, check)
          const bodyMeter = createExportJsonMeter(limits.bodyBytes, limits.bodyNodes, check)
          const metadataMeter = createExportJsonMeter(limits.metadataBytes, limits.scanNodes, check)
          let scannedRows = 0, tagReferences = 0
          await io.scan(selection, row => {
            check(); if (++scannedRows > limits.scanRows) fail("EXPORT_SCAN_ROW_LIMIT")
            if (!textOrNull(row.mood) || !textOrNull(row.weather) || typeof row.updatedAt !== "string") fail("EXPORT_INVALID_ENTRY_METADATA")
            const metadata = { id: row.id, entryDate: row.entryDate, sortOrder: row.sortOrder, title: row.title, contentText: row.contentText, tagIds: row.tagIds, mood: row.mood, weather: row.weather, updatedAt: row.updatedAt, isDeleted: row.isDeleted, deletedAt: row.deletedAt }
            // Discarded candidates consume scan guards too. No toArray/full-library copy.
            scanMeter.measure(metadata); scanMeter.measure(row.content ?? null)
            const candidate = { ...metadata, hasImage: hasReferencedImage(row.content, check) }
            if (!members.add(candidate)) return
            bodyMeter.measure(row.content ?? null); metadataMeter.measure(metadata)
            tagReferences += row.tagIds.length
            if (tagReferences > limits.tagReferences) fail("EXPORT_TAG_REFERENCE_LIMIT")
            const projection = projectNotebookContent(row.content)
            check(); selected.set(row.id, row); projections.set(row.id, projection)
          })
          check(); const ordered = members.finish()
          const diagnostics: ExportDiagnostic[] = [], entries: ExportSnapshotEntry[] = []
          const tags = new Map<string, Tag | undefined>(), referenced = new Map<string, string[]>()
          for (const member of ordered) {
            check(); const row = selected.get(member.id)!, projection = projections.get(member.id)!
            if (projection.warnings.length) diagnostics.push({ code: "CONTENT_UNSUPPORTED", entryId: row.id })
            const definitions: { id: string; name: string; color: string | null }[] = []
            for (const tagId of new Set(row.tagIds)) {
              check()
              if (!tags.has(tagId)) { tags.set(tagId, await io.tag(tagId)); check() }
              const tag = tags.get(tagId)
              if (!tag) { diagnostics.push({ code: "TAG_MISSING", entryId: row.id, resourceId: tagId }); continue }
              if (tag.id !== tagId || typeof tag.name !== "string" || !textOrNull(tag.color)) fail("EXPORT_INVALID_TAG")
              const definition = { id: tagId, name: tag.name, color: tag.color }
              metadataMeter.measure(definition); definitions.push(definition)
            }
            for (const mediaId of projection.mediaIds) {
              const refs = referenced.get(mediaId) ?? []; refs.push(row.id); referenced.set(mediaId, refs)
              if (referenced.size > limits.images) fail("EXPORT_IMAGE_COUNT_LIMIT")
            }
            entries.push({ ...member, title: row.title, mood: row.mood, weather: row.weather, updatedAt: row.updatedAt, content: projection, tags: definitions })
          }
          const media: ExportSnapshotMedia[] = []; let mediaBytes = 0
          for (const [mediaId, refs] of referenced) {
            check(); const value = await io.media(mediaId); check()
            if (value && (value.id !== mediaId || (value.blob != null && !(value.blob instanceof Blob)) || (value.thumbBlob != null && !(value.thumbBlob instanceof Blob)))) fail("EXPORT_INVALID_MEDIA")
            const original = value?.blob instanceof Blob && value.blob.size > 0 ? value.blob : null
            const thumbnail = value?.thumbBlob instanceof Blob && value.thumbBlob.size > 0 ? value.thumbBlob : null
            let blob = original ?? thumbnail
            const thumbnailOnly = !original && Boolean(thumbnail)
            if (blob) {
              if (blob.size > limits.imageBytes) fail("EXPORT_IMAGE_BYTE_LIMIT")
              mediaBytes += blob.size; if (mediaBytes > limits.mediaBytes) fail("EXPORT_MEDIA_BYTE_LIMIT")
            }
            let diagnostic: ExportDiagnostic["code"] | undefined
            if (!blob) diagnostic = "IMAGE_MISSING"
            else if (!["image/png", "image/jpeg", "image/webp"].includes(blob.type.toLowerCase())) { diagnostic = "IMAGE_TYPE_UNSUPPORTED"; blob = null }
            else if (thumbnailOnly) diagnostic = "IMAGE_THUMBNAIL_ONLY"
            if (diagnostic) for (const entryId of refs) diagnostics.push({ code: diagnostic, entryId, resourceId: mediaId })
            media.push({ id: mediaId, blob, thumbnailOnly })
          }
          check(); await assertCurrent(); check()
          // Raw rows, provenance and remote addresses never escape the transaction.
          return freezeExportValue<ExportSnapshot>({ selection, capturedAt, entries, media, diagnostics, completeOutputReady: false, counts: { scannedRows, scanBytes: scanMeter.counts().bytes, bodyBytes: bodyMeter.counts().bytes, bodyNodes: bodyMeter.counts().nodes, metadataBytes: metadataMeter.counts().bytes, mediaBytes } })
        })
        // Transaction completion and its subsequent identity check are distinct awaits.
        check(); await assertCurrent(); check()
        let current: ExportSnapshot | undefined = model, released = false
        const release = () => {
          if (released) return
          released = true; current = undefined; handles.delete(release); signal?.removeEventListener("abort", abort)
        }
        handleRelease = release; handles.add(release)
        // A task signal remains attached for the handle lifetime, not just capture().
        check()
        return {
          async read() {
            if (released) fail("EXPORT_SNAPSHOT_RELEASED")
            auth(); if (task !== version) { release(); fail("EXPORT_TASK_REPLACED") }
            await assertCurrent()
            auth(); if (signal?.aborted || task !== version || released || !current) { release(); fail("EXPORT_SNAPSHOT_RELEASED") }
            return current
          },
          release,
        }
      } catch (error) {
        handleRelease?.(); signal?.removeEventListener("abort", abort)
        throw error
      }
    },
  }
}
