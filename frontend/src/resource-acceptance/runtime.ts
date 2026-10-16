import { db } from "@/db/schema"
import { createInternalScheduleResourceRepairer, SCHEDULE_RESOURCE_REPAIRS } from "@/db/scheduleResourceRepairRepo"
import { assertScheduleLease } from "@/db/scheduleSyncStateRepo"
import { conversionCanonical } from "@/shared/scheduleConversionSync"
import { inspectResourceRepairBlob } from "@/io/scheduleResourceRepairFile"
import type { ResourceRepairPanelFile, ResourceRepairPanelPort } from "@/shared/scheduleResourceRepairPanel"
import { RESOURCE_ACCEPTANCE_DB_NAME, RESOURCE_ACCEPTANCE_MARKER, resourceAcceptanceMarker, isResourceAcceptanceMarker } from "./guard"
import type { ResourceAcceptanceSpec } from "./guard"
import { assertResourceIdentity, RESOURCE_DEMO_OWNER } from "./identity"
import { createResourceAcceptanceBarrier } from "./barrier"
import type { ResourceAcceptancePause } from "./barrier"
import { RESOURCE_SOURCE_ID, RESOURCE_MEDIA_ID, RESOURCE_EPOCH, RESOURCE_FIXTURE_KEY, resourceFixtureRows, resourceFixtureMaterial, resourceFixtureProof } from "./model"
const same = (a: unknown, b: unknown) => conversionCanonical(a) === conversionCanonical(b)
const fixtureMark = { kind: "quire-p4-resource-fixture/v1", sourceId: RESOURCE_SOURCE_ID, mediaId: RESOURCE_MEDIA_ID }
function guard(spec: ResourceAcceptanceSpec) {
  assertResourceIdentity(spec)
  if (db.name !== RESOURCE_ACCEPTANCE_DB_NAME) throw new Error("非专用资源验收库，拒绝访问")
}
async function empty() {
  for (const table of [db.entries, db.schedules, db.media, db.tags]) if (await table.toCollection().count()) throw new Error("验收库已有数据，不追加/覆盖/清除")
  if ((await db.meta.toArray()).some(row => row.key !== RESOURCE_ACCEPTANCE_MARKER)) throw new Error("验收库已有其他元信息，未覆盖")
}
async function marker(spec: ResourceAcceptanceSpec) {
  if (!isResourceAcceptanceMarker((await db.meta.get(RESOURCE_ACCEPTANCE_MARKER))?.value, spec)) throw new Error("验收标记不匹配，未接管")
}
export async function initializeResourceAcceptance(spec: ResourceAcceptanceSpec) {
  spec = { ...spec }; guard(spec)
  await db.transaction("rw", db.entries, db.schedules, db.media, db.tags, db.meta, async () => {
    guard(spec)
    if (await db.meta.get(RESOURCE_ACCEPTANCE_MARKER)) await marker(spec)
    else { await empty(); await db.meta.add({ key: RESOURCE_ACCEPTANCE_MARKER, value: resourceAcceptanceMarker(spec) }) }
    guard(spec)
  })
}
/** Explicit one-time empty-store seed. No delete/reset/claim of existing data. */
export async function seedResourceAcceptance(spec: ResourceAcceptanceSpec) {
  spec = { ...spec }; guard(spec); resourceFixtureMaterial(); await resourceFixtureProof(); guard(spec)
  const rows = resourceFixtureRows()
  await db.transaction("rw", db.entries, db.schedules, db.media, db.tags, db.meta, async () => {
    guard(spec); await marker(spec); await empty()
    await db.schedules.add(rows.source); await db.entries.add(rows.entry)
    for (const [key, value] of [["ownerUserId", RESOURCE_DEMO_OWNER], ["ownerGeneration", RESOURCE_EPOCH],
      ["scheduleConversions", [rows.intention]], ["scheduleConflicts", [rows.candidate]], [RESOURCE_FIXTURE_KEY, fixtureMark]] as const) await db.meta.add({ key, value })
    guard(spec)
  })
}
async function fixtureSnapshot(spec: ResourceAcceptanceSpec) {
  guard(spec)
  return db.transaction("r", db.entries, db.schedules, db.media, db.tags, db.meta, async () => {
    guard(spec); await marker(spec)
    const model = resourceFixtureRows(), expected = new Map<string, unknown>([["ownerUserId", RESOURCE_DEMO_OWNER], ["ownerGeneration", RESOURCE_EPOCH],
      ["scheduleConversions", [model.intention]], ["scheduleConflicts", [model.candidate]], [RESOURCE_FIXTURE_KEY, fixtureMark]])
    const metadata = await db.meta.toArray()
    if (metadata.some(row => ![RESOURCE_ACCEPTANCE_MARKER, SCHEDULE_RESOURCE_REPAIRS, ...expected.keys()].includes(row.key))) throw new Error("存在非验收元信息，未接管")
    for (const [key, value] of expected) if (!same((await db.meta.get(key))?.value ?? null, value)) throw new Error("验收归属或保护已变化，未接管")
    if (!same(await db.schedules.toArray(), [model.source]) || !same(await db.entries.toArray(), [model.entry]) || (await db.tags.toArray()).length) throw new Error("存在不同正文或标签，未接管")
    const media = await db.media.toArray(), archive = (await db.meta.get(SCHEDULE_RESOURCE_REPAIRS))?.value ?? []
    if (media.length > 1 || media.some(row => row.id !== RESOURCE_MEDIA_ID || row.entryId !== RESOURCE_SOURCE_ID || row.remoteUrl || row.thumbRemoteUrl || row.orphanedAt != null ||
      row.width !== 1 || row.height !== 1 || row.mime !== "image/png" || row.size !== 68 || row.sortOrder !== 0 || row.createdAt !== model.entry.createdAt || row.dirty !== 1 ||
      Object.keys(row).some(key => !["id", "entryId", "blob", "thumbBlob", "mime", "width", "height", "size", "sortOrder", "createdAt", "dirty", "remoteUrl", "thumbRemoteUrl", "orphanedAt"].includes(key)))) throw new Error("存在不同媒体，未接管")
    if (!Array.isArray(archive) || archive.some(row => !row || row.ownerUserId !== RESOURCE_DEMO_OWNER || row.generation !== RESOURCE_EPOCH || row.scheduleId !== RESOURCE_SOURCE_ID ||
      row.kind !== "missing-resource-from-evidence" || row.meaning !== "bytes_repaired_protection_unchanged")) throw new Error("存在未知补齐留档，未接管")
    guard(spec)
    return { media: media[0] ?? null, archiveCount: archive.length }
  })
}
export async function inspectResourceAcceptance(spec: ResourceAcceptanceSpec) {
  const pin = { ...spec }, state = await fixtureSnapshot(pin)
  const original = state.media ? await inspectResourceRepairBlob(state.media.blob) : null
  const thumbnail = state.media?.thumbBlob ? await inspectResourceRepairBlob(state.media.thumbBlob) : null
  const proof = await resourceFixtureProof() as { media: { original: { sha256: string }; thumbnail: { sha256: string } }[] }
  guard(pin)
  return { sourceCount: 1, entryCount: 1, intentionCount: 1, candidateCount: 1, mediaRows: state.media ? 1 : 0, archiveCount: state.archiveCount,
    originalMatches: original?.sha256 === proof.media[0]!.original.sha256, thumbnailMatches: thumbnail?.sha256 === proof.media[0]!.thumbnail.sha256 }
}
/** Dedicated demo composition, not an account/network adapter or production repo export. */
export function createResourceAcceptanceSession(spec: ResourceAcceptanceSpec, changed: (point: ResourceAcceptancePause | null) => void) {
  const pin = { ...spec }; guard(pin)
  let closed = false, revision = 0, busy = false
  const barrier = createResourceAcceptanceBarrier(changed)
  const check = (run: number) => { guard(pin); if (closed || run !== revision) throw new Error("验收会话已失效") }
  const repairer = createInternalScheduleResourceRepairer({ async review(id, lease) {
    guard(pin)
    if (closed || id !== RESOURCE_SOURCE_ID || lease.ownerUserId !== RESOURCE_DEMO_OWNER || lease.generation !== RESOURCE_EPOCH) throw new Error("模拟证明目标或归属不同")
    await assertScheduleLease(lease); await barrier.wait("proof"); guard(pin); await assertScheduleLease(lease)
    // No fetch or authenticated request: this is an explicitly labelled in-process proof fixture.
    return resourceFixtureProof()
  } })
  const cancelled = () => { revision++; repairer.cancel(); barrier.cancel() }
  const port: ResourceRepairPanelPort = {
    async prepare(id, ids, file: ResourceRepairPanelFile) {
      if (busy) return { ready: false, reason: "busy", reviewId: 0 }
      busy = true; const run = revision
      try {
        check(run); await fixtureSnapshot(pin); check(run)
        if (id !== RESOURCE_SOURCE_ID || ids.length !== 1 || ids[0] !== RESOURCE_MEDIA_ID || file.size > 64 * 1024) throw new Error("仅允许专用验收夹具")
        const expected = JSON.parse(resourceFixtureMaterial())
        const scopedFile = { size: file.size, async text() {
          const text = await file.text(); check(run)
          if (!same(JSON.parse(text), expected)) throw new Error("仅允许本页下载的验收材料，不读取真实证据作为夹具")
          return text
        } }
        const result = await repairer.prepare(id, ids, scopedFile); check(run); return result
      } catch { return { ready: false, reason: "resource_acceptance_unconfirmed", reviewId: 0 } }
      finally { busy = false; barrier.release() }
    },
    async repair(reviewId, confirmed) {
      if (busy) return { repaired: false, reason: "busy", resolutionEnabled: false }
      busy = true; const run = revision
      try { check(run); await fixtureSnapshot(pin); check(run); const result = await repairer.repair(reviewId, confirmed); check(run); return result }
      catch { return { repaired: false, reason: "resource_acceptance_recheck", resolutionEnabled: false } }
      finally { busy = false; barrier.release() }
    },
    cancel: cancelled,
  }
  return { port, pauseNext(point: ResourceAcceptancePause) { return !closed && !busy && barrier.arm(point) }, release: barrier.release,
    close() { closed = true; cancelled(); barrier.dispose() } }
}
