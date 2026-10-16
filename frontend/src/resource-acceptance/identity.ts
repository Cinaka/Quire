import { assertResourceAcceptanceLocation } from "./guard"
import type { ResourceAcceptanceSpec } from "./guard"
export const RESOURCE_DEMO_OWNER = "019a0300-1234-7000-8000-000000009903"
declare const __QUIRE_P4_RESOURCE_ACCEPTANCE__: boolean
let active: ResourceAcceptanceSpec | null = null, generation = 0
export function assertResourceIdentity(spec: ResourceAcceptanceSpec): void {
  if (typeof __QUIRE_P4_RESOURCE_ACCEPTANCE__ === "undefined" || __QUIRE_P4_RESOURCE_ACCEPTANCE__ !== true || !active ||
      active.dailyOrigin !== spec.dailyOrigin || active.testOrigin !== spec.testOrigin) throw new Error("资源验收身份未明确启用")
  assertResourceAcceptanceLocation(spec, window.location)
  if (localStorage.getItem("quire_access_token")) throw new Error("验收origin已有凭据，拒绝操作，不删除凭据")
}
/** Build-local identity stub, never a JWT/account, never stored in localStorage. */
export function activateResourceIdentity(spec: ResourceAcceptanceSpec): void {
  const pin = assertResourceAcceptanceLocation(spec, window.location)
  active = pin; generation++
  try { assertResourceIdentity(pin) } catch (error) { active = null; throw error }
}
export function deactivateResourceIdentity(): void { active = null; generation++ }
export function resourceAccessTokenSubject(): string { if (!active) return ""; assertResourceIdentity(active); return RESOURCE_DEMO_OWNER }
export function resourceTokenGeneration(): number { if (active) assertResourceIdentity(active); return generation }
export function resourceGetAccessToken(): string { if (active) assertResourceIdentity(active); return "" }
