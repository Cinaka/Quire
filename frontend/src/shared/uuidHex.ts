/** UUID32 boundary codec. No recursive replacement of arbitrary text or JSON. */
const HEX = /^[0-9a-fA-F]{32}$/
const CANONICAL = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function uuidToHex(value: unknown, requireV7 = false): string {
  if (typeof value !== "string" || !(
    (value.length === 32 && HEX.test(value))
    || (value.length === 36 && CANONICAL.test(value))
  )) {
    throw new Error("UUID must be exactly 32 hex characters or a canonical UUID")
  }
  const result = value.replaceAll("-", "").toLowerCase()
  // The version nibble and RFC variant both matter; a bare replace is not validation.
  if (requireV7 && (result.charAt(12) !== "7" || !/[89ab]/.test(result.charAt(16)))) {
    throw new Error("business identifier must be a UUID v7")
  }
  return result
}

export function uuidToLegacyText(value: unknown): string {
  const id = uuidToHex(value)
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
}

export function normalizeUuidList(values: readonly unknown[], requireV7 = false): string[] {
  const result = values.map(value => uuidToHex(value, requireV7))
  if (new Set(result).size !== result.length) {
    throw new Error("multiple identifier representations refer to the same UUID")
  }
  return result
}

/** Local primary keys are not re-keyed while preparing a network request. */
export function localUuidHex(value: unknown): string {
  const id = uuidToHex(value, true)
  if (value !== id) throw new Error("本地身份尚未完成 UUID32 切换；数据已保留，请先核对本地库与备份")
  return id
}

/** Exact legacy spelling remains readable; no whitespace, wrappers, paths or URNs. */
export function isBusinessUuid(value: unknown): value is string {
  try { uuidToHex(value, true); return true } catch { return false }
}
