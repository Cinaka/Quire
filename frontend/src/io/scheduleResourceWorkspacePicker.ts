import type { ConflictEvidenceFileHandle, ConflictEvidenceWritableFile } from "./scheduleConflictEvidenceFile"
import { resourceEvidenceSaveAvailable } from "./scheduleResourceSavePicker"
import type { ResourceSavePickerEnvironment } from "./scheduleResourceSavePicker"
import type { ResourceWorkspaceSaveTarget } from "@/shared/scheduleResourceWorkspaceTypes"

/** Call directly in the save click. No download-link fallback, overwrite or permission prompt at construction. */
export async function pickResourceWorkspaceEvidence(environment: ResourceSavePickerEnvironment = window as unknown as ResourceSavePickerEnvironment): Promise<ResourceWorkspaceSaveTarget> {
  if (!resourceEvidenceSaveAvailable(environment)) throw new Error("浏览器不支持独占保存和回读")
  const raw = await environment.showSaveFilePicker!({ suggestedName: "quire-dual-resource-evidence.json", excludeAcceptAllOption: true,
    types: [{ description: "青简双方实物证据（含私人正文和图片）", accept: { "application/json": [".json"] } }] })
  if (!raw || typeof raw.getFile !== "function" || typeof raw.createWritable !== "function" || (await raw.getFile()).size !== 0) throw new Error("仅接受全新空证据文件")
  let cancelled = false, used = false, writer: ConflictEvidenceWritableFile | null = null
  const check = () => { if (cancelled) throw new Error("保存已取消") }
  const handle: ConflictEvidenceFileHandle = {
    async getFile() { check(); const file = await raw.getFile(); check(); return file },
    async createWritable(options) {
      check(); if (used) throw new Error("目标已尝试写入，请另选全新空文件")
      used = true
      const stream = await raw.createWritable(options)
      if (cancelled) { try { await stream.abort() } catch { /* Still fail closed. */ }; check() }
      writer = stream
      return {
        async write(data) { check(); await stream.write(data); check() },
        async close() { check(); await stream.close(); if (writer === stream) writer = null; check() },
        async abort() { try { await stream.abort() } finally { if (writer === stream) writer = null } },
      }
    },
  }
  return { name: typeof raw.name === "string" && raw.name.trim() ? raw.name.slice(0, 160) : "双方实物证据.json", handle,
    cancel() { cancelled = true; const stream = writer; writer = null; if (stream) { try { void stream.abort().catch(() => {}) } catch { /* Already complete. */ } } } }
}
