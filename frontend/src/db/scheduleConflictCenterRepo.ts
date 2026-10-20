import { createScheduleResourceWorkspaceTransport } from "@/api/scheduleResourceWorkspaceTransport"
import { createScheduleTerminalReviewTransport } from "@/api/scheduleTerminalReviewTransport"
import { conversionCanonical, conversionCopy } from "@/shared/scheduleConversionSync"
import type { Schedule } from "@/shared/types"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import type { ScheduleHostContext } from "@/shared/scheduleHostTypes"
import type { ConflictSource, ScheduleConflictSession, TerminalCenterPreview } from "@/shared/scheduleConflictCenterTypes"
import { isBackupSchedule } from "@/shared/scheduleBackup"
import { scheduleEntryId } from "@/shared/schedules"
import { assertHostContext } from "./scheduleHostContext"
import { createInternalResourceWorkspace } from "./scheduleResourceWorkspaceRepo"
import { createInternalTerminalBlockedObserver } from "./scheduleTerminalBlockedRepo"
import { createInternalScheduleSourceTombstoneResolver, createInternalScheduleTerminalDiscardResolver } from "./scheduleTerminalConflictRepo"
import { db } from "./schema"

export async function listScheduleConflictSources(context: ScheduleHostContext): Promise<ConflictSource[]> {
  const pin = conversionCopy(context)
  return db.transaction("r", db.schedules, db.meta, async () => {
    await assertHostContext(pin)
    const rows: Schedule[] = await db.schedules.toArray()
    if (rows.some(row => !isBackupSchedule(row))) throw new Error("来源数据无法安全核对，未跳过异常记录")
    await assertHostContext(pin)
    return rows.filter(row => row.status === "converted").sort((a, b) => a.id.localeCompare(b.id))
      .map(row => ({ id: row.id, title: row.title, deleted: Boolean(row.isDeleted) }))
  })
}
/** Constructing is inert. Every request and final operation is fenced by the original formal host. */
export function createScheduleConflictSession(context: ScheduleHostContext, id: string): ScheduleConflictSession {
  if (scheduleEntryId(id) !== id) throw new Error("核对来源无效")
  const pin = conversionCopy(context)
  if (!pin.ownerUserId || pin.authSubject !== pin.ownerUserId) throw new Error("请先按原备份/认领流程确认账号与本地归属；游客可继续本机预简")
  const lease: ConversionLease = { ownerUserId: pin.ownerUserId, generation: pin.generation, tokenGeneration: pin.authGeneration }
  let active = true, busy = false
  const guard = async () => { if (!active) throw new Error("核对会话已关闭"); await assertHostContext(pin); if (!active) throw new Error("核对会话已关闭") }
  const request = async (target: string, candidate: ConversionLease) => {
    await guard()
    if (target !== id || conversionCanonical(candidate) !== conversionCanonical(lease)) throw new Error("不能重绑来源或账号")
  }
  const raw = createScheduleResourceWorkspaceTransport(), reviewRaw = createScheduleTerminalReviewTransport()
  const resources = createInternalResourceWorkspace(id, {
    async review(target, candidate) { await request(target, candidate); const r = await raw.review(target, candidate); await request(target, candidate); return r },
    async image(target, media, variant, proof, candidate, signal) { await request(target, candidate); const r = await raw.image(target, media, variant, proof, candidate, signal); await request(target, candidate); return r },
    async publish(target, body, candidate, signal) { await request(target, candidate); const r = await raw.publish(target, body, candidate, signal); await request(target, candidate); return r },
    async checkTags(target, body, candidate, signal) { await request(target, candidate); const r = await raw.checkTags(target, body, candidate, signal); await request(target, candidate); return r },
  })
  const transport = { async review(target: string, candidate: ConversionLease) { await request(target, candidate); const r = await reviewRaw.review(target, candidate); await request(target, candidate); return r } }
  const observer = createInternalTerminalBlockedObserver(transport), source = createInternalScheduleSourceTombstoneResolver(transport), discard = createInternalScheduleTerminalDiscardResolver(transport)
  let tickets: { observation: number; source: number; discard: number; preview: TerminalCenterPreview } | null = null
  const reset = () => { tickets = null; observer.cancel(); source.cancel(); discard.cancel() }
  async function run<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new Error("核对操作进行中")
    busy = true
    try { await guard(); const result = await work(); await guard(); return result }
    finally { busy = false }
  }
  return {
    resources: {
      prepareEvidence: confirmed => run(() => resources.prepareEvidence(confirmed)),
      saveEvidence: (reviewId, handle) => run(() => resources.saveEvidence(reviewId, handle)),
      inspect: file => run(() => resources.inspect(file)),
      prepareCopies: (file, choice, names, confirmed) => run(() => resources.prepareCopies(file, choice, names, confirmed)),
      publishCopies: (file, planId, confirmed) => run(() => resources.publishCopies(file, planId, confirmed)),
      handoffCopies: (file, planId, choice, confirmed) => run(() => resources.handoffCopies(file, planId, choice, confirmed)),
      resolveDirect: (file, choice, confirmed) => run(() => resources.resolveDirect(file, choice, confirmed)),
      cancel() { resources.cancel() },
    },
    review: () => run(async () => {
      reset()
      const observation = await observer.review(id), from = await source.review(id), purge = await discard.review(id)
      if (!observation.ready || !from.ready || !purge.ready || !('blocks' in observation) || !observation.blocks) throw new Error("本次观察未确认，请保留原库和文件；未开放任何处置")
      const preview: TerminalCenterPreview = { blocks: observation.blocks, completeLocalResources: observation.completeLocalResources === true, sourceDeletionEnabled: from.sourceDeletionEnabled === true, choices: purge.choices }
      tickets = { observation: observation.reviewId, source: from.reviewId, discard: purge.reviewId, preview: conversionCopy(preview) }
      return conversionCopy(preview)
    }),
    apply: (action, confirmed, handle) => run(async () => {
      const current = tickets; tickets = null
      if (!current || confirmed !== true) return false
      try {
        if (action === "observation") return (await observer.save(current.observation, true, handle)).saved === true
        if (action === "source" && current.preview.sourceDeletionEnabled) return (await source.resolve(current.source, true, handle)).applied === true
        if ((action === "finish-cloud-purged" || action === "handoff-cleared-tombstone") && current.preview.choices.includes(action)) return (await discard.resolve(current.discard, action, true, handle)).applied === true
        return false
      } finally { reset() }
    }),
    cancel() { active = false; resources.cancel(); reset() },
  }
}
