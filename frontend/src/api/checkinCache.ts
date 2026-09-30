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

function readSummary(key: string): MonthCheckinSummary | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null")
    return isSummary(parsed) ? parsed : null
  } catch {
    sessionStorage.removeItem(key)
    return null
  }
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
  const userId = accessTokenSubject()
  if (!userId) return null
  if (year !== undefined && month !== undefined) return readSummary(monthKey(userId, year, month))
  const currentKey = sessionStorage.getItem(`${accountPrefix(userId)}:current`)
  return currentKey ? readSummary(currentKey) : null
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
    const parsed: unknown = JSON.parse(sessionStorage.getItem(indexKey) ?? "[]")
    const index = Array.isArray(parsed) ? parsed.filter((item): item is CacheIndexItem => Boolean(item) && typeof item === "object" && typeof (item as CacheIndexItem).key === "string" && typeof (item as CacheIndexItem).savedAt === "number") : []
    const next = [{ key, savedAt: Date.now() }, ...index.filter((item) => item.key !== key)]
    for (const expired of next.slice(MAX_CACHED_MONTHS)) sessionStorage.removeItem(expired.key)
    sessionStorage.setItem(indexKey, JSON.stringify(next.slice(0, MAX_CACHED_MONTHS)))
  } catch {
    // 缓存容量或隐私模式异常不能影响服务端权威签到流程。
  }
}
