import { assertDownloadAcceptanceLocation } from "./guard"
import type { DownloadAcceptanceSpec } from "./guard"
export const DOWNLOAD_DEMO_OWNER = "019a0300-1234-7000-8000-000000009903"
declare const __QUIRE_P4_RESOURCE_DOWNLOAD_ACCEPTANCE__: boolean
let active: DownloadAcceptanceSpec | null = null, generation = 0
export function assertDownloadIdentity(spec: DownloadAcceptanceSpec): void {
  if (typeof __QUIRE_P4_RESOURCE_DOWNLOAD_ACCEPTANCE__ === "undefined" || __QUIRE_P4_RESOURCE_DOWNLOAD_ACCEPTANCE__ !== true || !active ||
      active.dailyOrigin !== spec.dailyOrigin || active.testOrigin !== spec.testOrigin) throw new Error("图片下载验收身份未明确启用")
  assertDownloadAcceptanceLocation(spec, window.location)
  if (localStorage.getItem("quire_access_token")) throw new Error("验收origin已有凭据，拒绝操作，不删除凭据")
}
/** Build-local identity stub, never a JWT/account, never stored in localStorage. */
export function activateDownloadIdentity(spec: DownloadAcceptanceSpec): void {
  const pin = assertDownloadAcceptanceLocation(spec, window.location)
  active = pin; generation++
  try { assertDownloadIdentity(pin) } catch (error) { active = null; throw error }
}
export function deactivateDownloadIdentity(): void { active = null; generation++ }
export function downloadAccessTokenSubject(): string { if (!active) return ""; assertDownloadIdentity(active); return DOWNLOAD_DEMO_OWNER }
export function downloadTokenGeneration(): number { if (active) assertDownloadIdentity(active); return generation }
export function downloadGetAccessToken(): string { if (active) assertDownloadIdentity(active); return "" }
