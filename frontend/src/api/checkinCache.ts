import type { MonthCheckinSummary } from "./checkins"
import { accessTokenSubject } from "./tokenStore"

const CACHE_PREFIX = "quire_checkin_months_v1"
const MAX_CACHED_MONTHS = 6

interface CacheIndexItem {
  key: string
  savedAt: number
}

function accountPrefix(userId: string): string { return `${CACHE_PREFIX}:${userId}` }
function monthKey(userId: string, year: number, month: number): string { return `${accountPrefix(userId)}:${year}-${String(month).padStart(2, "0")}` }

function isSummary(value: unknown): value is MonthCheckinSummary {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<MonthCheckinSummary>
  return Number.isInteger(item.year) && Number.isInteger(item.month) && Array.isArray(item.checkinDates) && typeof item.today === "string" && typeof item.timezone === "string" && typeof item.checkedInToday === "boolean" && Number.isInteger(item.currentStreak) && Number.isInteger(item.longestStreak) && Number.isInteger(item.totalCheckins) && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
}

function removeSafely(key: string): void {
  try { sessionStorage.removeItem(key) } catch {
    // Storage may be disabled even for reads/removals. Cache is optional.
  }
}

function readSummary(key: string): MonthCheckinSummary | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null")
    if (isSummary(parsed)) return parsed
    removeSafely(key)
  } catch {
    removeSafely(key)
  }
  return null
}

export function currentCheckinCacheOwner(): string { return accessTokenSubject() }

export function clearCheckinCache(userId = accessTokenSubject()): void {
  if (!userId) return
  const prefix = `${accountPrefix(userId)}:`
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key)
    }
  } catch {
    // 清理缓存失败不能阻止退出登录与清除访问令牌。
  }
}

export function readCachedCheckinMonth(year?: number, month?: number): MonthCheckinSummary | null {
  try {
    const userId = accessTokenSubject()
    if (!userId || (year === undefined) !== (month === undefined)) return null
    if (year !== undefined && month !== undefined) {
      const result = readSummary(monthKey(userId, year, month))
      return result?.year === year && result.month === month ? result : null
    }
    const prefix = accountPrefix(userId)
    const pointerKey = `${prefix}:current`
    const currentKey = sessionStorage.getItem(pointerKey)
    if (!currentKey) return null
    // Never follow a damaged pointer into another account's namespace.
    const result = currentKey.startsWith(`${prefix}:`) ? readSummary(currentKey) : null
    if (!result || currentKey !== monthKey(userId, result.year, result.month)) {
      removeSafely(pointerKey)
      return null
    }
    return result
  } catch {
    // 禁用存储、隐私模式或异常缓存只会导致缓存未命中。
    return null
  }
}

export function cacheCheckinMonth(summary: MonthCheckinSummary): void {
  const userId = accessTokenSubject()
  if (!userId) return
  const prefix = accountPrefix(userId)
  const key = monthKey(userId, summary.year, summary.month)
  const indexKey = `${prefix}:index`
  const currentPrefix = `${summary.year}-${String(summary.month).padStart(2, "0")}`
  try {
    sessionStorage.setItem(key, JSON.stringify(summary))
    if (summary.today.startsWith(currentPrefix)) sessionStorage.setItem(`${prefix}:current`, key)
    let parsed: unknown = []
    try { parsed = JSON.parse(sessionStorage.getItem(indexKey) ?? "[]") } catch {
      // A broken index must not prevent rebuilding cache retention metadata.
    }
    const index = Array.isArray(parsed) ? parsed.filter((item): item is CacheIndexItem => Boolean(item) && typeof item === "object" && typeof (item as CacheIndexItem).key === "string" && (item as CacheIndexItem).key.startsWith(`${prefix}:`) && typeof (item as CacheIndexItem).savedAt === "number") : []
    const next = [{ key, savedAt: Date.now() }, ...index.filter((item) => item.key !== key)]
    for (const expired of next.slice(MAX_CACHED_MONTHS)) sessionStorage.removeItem(expired.key)
    sessionStorage.setItem(indexKey, JSON.stringify(next.slice(0, MAX_CACHED_MONTHS)))
  } catch {
    // 缓存容量或隐私模式异常不能影响服务端权威签到流程。
  }
}
