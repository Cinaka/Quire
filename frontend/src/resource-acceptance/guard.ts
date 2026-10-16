export const RESOURCE_ACCEPTANCE_DB_NAME = "quire-p4-resource-acceptance"
export const RESOURCE_ACCEPTANCE_MARKER = "p4AcceptanceOrigin"
export interface ResourceAcceptanceSpec { enabled: boolean; dailyOrigin: string; testOrigin: string }
function origin(value: string): URL {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("验收配置必须是不带路径/凭据/参数的origin")
  return url
}
export function assertResourceAcceptanceLocation(spec: ResourceAcceptanceSpec, location: { origin: string; pathname: string }): ResourceAcceptanceSpec {
  if (spec.enabled !== true) throw new Error("只允许专用P4资源验收配置，普通dev/build不能启用")
  const daily = origin(spec.dailyOrigin); const test = origin(spec.testOrigin)
  if (daily.origin === test.origin || !["127.0.0.1", "localhost", "[::1]"].includes(test.hostname)) throw new Error("验收origin必须是与日常不同的本机回环origin")
  if (location.origin !== test.origin || location.pathname !== "/p4-resource-acceptance.html") throw new Error("当前地址不是明确指定的隔离验收页")
  return { enabled: true, dailyOrigin: daily.origin, testOrigin: test.origin }
}
export function resourceAcceptanceMarker(spec: ResourceAcceptanceSpec) {
  return { kind: "quire-p4-resource-acceptance/v1", dailyOrigin: spec.dailyOrigin, testOrigin: spec.testOrigin }
}
export function isResourceAcceptanceMarker(value: unknown, spec: ResourceAcceptanceSpec): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  return Object.keys(marker).length === 3 && marker.kind === "quire-p4-resource-acceptance/v1" && marker.dailyOrigin === spec.dailyOrigin && marker.testOrigin === spec.testOrigin
}
