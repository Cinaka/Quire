export const ACCEPTANCE_DB_NAME = "quire-p4-acceptance"
export const ACCEPTANCE_MARKER = "p4AcceptanceOrigin"
export interface AcceptanceSpec { enabled: boolean; dailyOrigin: string; testOrigin: string }
function origin(value: string): URL {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("验收配置必须是不带路径/凭据/参数的origin")
  return url
}
export function assertAcceptanceLocation(spec: AcceptanceSpec, location: { origin: string; pathname: string }): AcceptanceSpec {
  if (spec.enabled !== true) throw new Error("只允许专用P4验收配置，普通dev/build不能启用")
  const daily = origin(spec.dailyOrigin); const test = origin(spec.testOrigin)
  if (daily.origin === test.origin || !["127.0.0.1", "localhost", "[::1]"].includes(test.hostname)) throw new Error("验收origin必须是与日常不同的本机回环origin")
  if (location.origin !== test.origin || location.pathname !== "/p4-acceptance.html") throw new Error("当前地址不是明确指定的隔离验收页")
  return { enabled: true, dailyOrigin: daily.origin, testOrigin: test.origin }
}
export function acceptanceMarker(spec: AcceptanceSpec) {
  return { kind: "quire-p4-acceptance/v1", dailyOrigin: spec.dailyOrigin, testOrigin: spec.testOrigin }
}
export function isAcceptanceMarker(value: unknown, spec: AcceptanceSpec): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  return Object.keys(marker).length === 3 && marker.kind === "quire-p4-acceptance/v1" && marker.dailyOrigin === spec.dailyOrigin && marker.testOrigin === spec.testOrigin
}
