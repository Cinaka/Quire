import type { ScheduleCloudResourceImageTransport, ResourceImageVariant } from "@/api/scheduleCloudResourceImageTransport"
import type { CloudImageProof, ScheduleCloudResourceReview } from "@/shared/scheduleCloudResources"
import { conversionCopy } from "@/shared/scheduleConversionSync"
import type { ConversionLease } from "@/shared/scheduleConversionSync"
import type { ResourceEvidenceMedia } from "@/shared/scheduleResourceEvidence"
import type { ScheduleResourceRepairStep } from "@/shared/scheduleResourceRepair"
import { assertResourceRepairImage } from "./scheduleResourceRepairFile"

function signature(base64: string, mime: string): void {
  const bytes = Uint8Array.from(atob(base64.slice(0, 32)), char => char.charCodeAt(0))
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  const matches = mime === "image/png" ? [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) :
    mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    mime === "image/webp" ? ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" :
    mime === "image/gif" && ["GIF87a", "GIF89a"].includes(ascii(0, 6))
  if (!matches) throw new Error("下载图片文件头与证明不一致")
}
export async function validateScheduleResourceImage(raw: unknown, id: string, mediaId: string,
  variant: ResourceImageVariant, proof: CloudImageProof): Promise<string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("图片响应结构无效")
  const r = raw as Record<string, unknown>, keys = ["read_only", "resolution_enabled", "proof_scope", "schedule_id", "media_id", "variant", "size", "mime", "sha256", "data_base64"]
  if (keys.some(key => !(key in r)) || Object.keys(r).some(key => !keys.includes(key)) ||
      r.read_only !== true || r.resolution_enabled !== false || r.proof_scope !== "current_entry_image_bytes" ||
      r.schedule_id !== id || r.media_id !== mediaId || r.variant !== variant || proof.state !== "verified" ||
      !Number.isSafeInteger(proof.size) || !proof.size || proof.size < 1 || proof.size > 10 * 1024 * 1024 ||
      r.size !== proof.size || r.mime !== proof.mime || r.sha256 !== proof.sha256 || typeof r.data_base64 !== "string" ||
      r.data_base64.length !== Math.ceil(proof.size / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data_base64)) throw new Error("图片身份、大小或证明不一致")
  // Re-encoding also rejects noncanonical padding bits, not just permissive atob decodes.
  if (btoa(atob(r.data_base64)) !== r.data_base64) throw new Error("图片编码损坏")
  signature(r.data_base64, String(r.mime))
  await assertResourceRepairImage(r.data_base64, String(r.mime), proof)
  return r.data_base64
}
export interface DownloadRetainedImage { id: string; original: string | null; thumbnail: string | null }
/** Bounded in-memory byte assembly, no DB writes. Repair callers allow missing slots only;
 * dual-version evidence capture may request an independent full cloud snapshot without replacing local bytes. */
export async function downloadScheduleResourceImages(id: string, cloud: ScheduleCloudResourceReview,
  steps: ScheduleResourceRepairStep[], retained: DownloadRetainedImage[], transport: ScheduleCloudResourceImageTransport,
  lease: ConversionLease, signal: AbortSignal, check: () => Promise<void>): Promise<ResourceEvidenceMedia[]> {
  let budget = 0
  if (!steps.length || steps.length > 64 || new Set(steps.map(step => step.mediaId)).size !== steps.length) throw new Error("下载选择无效")
  for (const step of steps) {
    const row = cloud.media.find(item => item.id === step.mediaId)
    if (!row || row.original.state !== "verified" || !["verified", "not_present"].includes(row.thumbnail.state) ||
        !step.fillOriginal && !step.fillThumbnail) throw new Error("当前云端证明不能下载")
    // Include retained slots too: the prepared in-memory material has a whole-batch budget.
    budget += (row.original.size ?? 0) + (row.thumbnail.size ?? 0)
  }
  if (budget > 16 * 1024 * 1024) throw new Error("下载补齐材料超过16MiB")
  const result: ResourceEvidenceMedia[] = []
  for (const step of steps) {
    const row = cloud.media.find(item => item.id === step.mediaId)!, local = retained.find(item => item.id === step.mediaId)
    const read = async (variant: ResourceImageVariant) => {
      await check(); if (signal.aborted) throw new Error("图片下载已取消")
      const proof = row[variant], wire = await transport.image(id, row.id, variant, conversionCopy(proof), conversionCopy(lease), signal)
      await check(); if (signal.aborted) throw new Error("图片下载已取消")
      const base64 = await validateScheduleResourceImage(wire, id, row.id, variant, proof)
      await check(); if (signal.aborted) throw new Error("图片下载已取消")
      return base64
    }
    const original = step.fillOriginal ? await read("original") : local?.original
    const thumbnail = step.fillThumbnail ? await read("thumbnail") : row.thumbnail.state === "not_present" ? null : local?.thumbnail
    if (!original || thumbnail === undefined) throw new Error("保留图片槽位已缺失")
    result.push({ id: row.id, entryId: id, mime: row.original.mime!, width: row.width, height: row.height,
      size: row.size!, sortOrder: row.sortOrder, createdAt: row.createdAt, dirty: 1, orphanedAt: null,
      hadRemoteLink: false, hadThumbRemoteLink: false, blobBase64: original, thumbBase64: thumbnail,
      thumbMime: thumbnail === null ? null : row.thumbnail.mime })
  }
  return result
}
