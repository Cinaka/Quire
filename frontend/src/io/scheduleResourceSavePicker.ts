import { createScheduleResourceConflictFilePreserver } from "./scheduleResourceConflictFile"
import type { ConflictEvidenceFileHandle, ConflictEvidenceWritableFile } from "./scheduleConflictEvidenceFile"
import type { ResourceConflictSaveTarget } from "@/shared/scheduleResourceConflictPanel"

export interface ResourceSavePickerEnvironment {
  isSecureContext: boolean
  showSaveFilePicker?: (options: { suggestedName: string; excludeAcceptAllOption: boolean; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<ConflictEvidenceFileHandle & { name?: string }>
}
export function resourceEvidenceSaveAvailable(environment: ResourceSavePickerEnvironment = window as unknown as ResourceSavePickerEnvironment): boolean {
  return environment.isSecureContext === true && typeof environment.showSaveFilePicker === "function"
}
/** A picked target is single-use. Closing/cancelling never deletes an already saved file. */
export function createResourceConflictSaveTarget(handle: ConflictEvidenceFileHandle, name = "资源证据.json"): ResourceConflictSaveTarget {
  let cancelled = false, used = false, writer: ConflictEvidenceWritableFile | null = null
  const check = () => { if (cancelled) throw new Error("文件保存已取消") }
  const guarded: ConflictEvidenceFileHandle = {
    async getFile() {
      check(); const file = await handle.getFile(); check()
      return { size: file.size, async text() { check(); const text = await file.text(); check(); return text } }
    },
    async createWritable(options) {
      check(); const stream = await handle.createWritable(options)
      if (cancelled) { try { await stream.abort() } catch { /* Never hide cancellation. */ }; check() }
      writer = stream
      return {
        async write(data) { check(); await stream.write(data); check() },
        async close() { check(); await stream.close(); writer = null; check() },
        async abort() { try { await stream.abort() } finally { if (writer === stream) writer = null } },
      }
    },
  }
  const preserve = createScheduleResourceConflictFilePreserver(guarded)
  return {
    name: (name.trim() ? name : "资源证据.json").slice(0, 160),
    async preserve(evidence) {
      check(); if (used) throw new Error("请重新选择空文件")
      used = true // A failed attempt may already have left a file; never reuse it implicitly.
      await preserve(evidence); check()
    },
    cancel() { cancelled = true; const stream = writer; writer = null; if (stream) { try { void stream.abort().catch(() => {}) } catch { /* Abort may already be complete. */ } } },
  }
}
/** Call from the explicit click handler before any awaited network/DB work, preserving user activation. */
export async function pickResourceConflictSaveTarget(environment: ResourceSavePickerEnvironment = window as unknown as ResourceSavePickerEnvironment): Promise<ResourceConflictSaveTarget> {
  if (!resourceEvidenceSaveAvailable(environment)) throw new Error("当前浏览器不支持明确选择、独占写入与回读文件")
  const handle = await environment.showSaveFilePicker!({ suggestedName: "quire-matched-resource-evidence.json", excludeAcceptAllOption: true,
    types: [{ description: "青简双方资源取舍证据（含私人正文和图片）", accept: { "application/json": [".json"] } }] })
  if (!handle || typeof handle.getFile !== "function" || typeof handle.createWritable !== "function") throw new Error("文件句柄不完整")
  const file = await handle.getFile()
  if (file.size !== 0) throw new Error("拒绝覆盖非空文件，请选全新的空文件")
  return createResourceConflictSaveTarget(handle, typeof handle.name === "string" ? handle.name : "资源证据.json")
}
