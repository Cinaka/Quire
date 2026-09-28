import type { MonthCheckinSummary } from "./checkins"
import { getAccessToken } from "./tokenStore"

const CACHE_PREFIX = "quire_checkin_months_v1"
const MAX_CACHED_MONTHS = 6

interface CacheIndexItem {
  key: string
  savedAt: number
}

function accountId(): string {
  const token = getAccessToken()
  const encoded = token.split(".")[1]
  if (!encoded) return ""

  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
    const payload = JSON.parse(atob(padded)) as { sub?: unknown }
    return typeof payload.sub === "string" ? payload.sub : ""
  } catch {
    return ""
  }
}

function accountPrefix(userId: string): string {
  return `${CACHE_PREFIX}:${userId}`
}

function monthKey(userId: string, year: number, month: number): string {
  return `${accountPrefix(userId)}:${year}-${String(month).padStart(2, "0")}`
}

function isSummary(value: unknown): value is MonthCheckinSummary {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<MonthCheckinSummary>
  return (
    Number.isInteger(item.year) &&
    Number.isInteger(item.month) &&
    Array.isArray(item.checkinDates) &&
    typeof item.today === "string" &&
    typeof item.timezone === "string" &&
    typeof item.checkedInToday === "boolean" &&
    Number.isInteger(item.currentStreak) &&
    Number.isInteger(item.longestStreak) &&
    Number.isInteger(item.totalCheckins)
  )
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

export function readCachedCheckinMonth(
  year?: number,
  month?: number,
): MonthCheckinSummary | null {
  const userId = accountId()
  if (!userId) return null

  if (year !== undefined && month !== undefined) {
    return readSummary(monthKey(userId, year, month))
  }

  const currentKey = sessionStorage.getItem(`${accountPrefix(userId)}:current`)
  return currentKey ? readSummary(currentKey) : null
}

export function cacheCheckinMonth(summary: MonthCheckinSummary): void {
  const userId = accountId()
  if (!userId) return

  const prefix = accountPrefix(userId)
  const key = monthKey(userId, summary.year, summary.month)
  const indexKey = `${prefix}:index`
  const currentPrefix = `${summary.year}-${String(summary.month).padStart(2, "0")}`

  try {
    sessionStorage.setItem(key, JSON.stringify(summary))
    if (summary.today.startsWith(currentPrefix)) {
      sessionStorage.setItem(`${prefix}:current`, key)
    }

    const parsed: unknown = JSON.parse(sessionStorage.getItem(indexKey) ?? "[]")
    const index = Array.isArray(parsed)
      ? parsed.filter(
          (item): item is CacheIndexItem =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as CacheIndexItem).key === "string" &&
            typeof (item as CacheIndexItem).savedAt === "number",
        )
      : []
    const next = [
      { key, savedAt: Date.now() },
      ...index.filter((item) => item.key !== key),
    ]
    for (const expired of next.slice(MAX_CACHED_MONTHS)) {
      sessionStorage.removeItem(expired.key)
    }
    sessionStorage.setItem(indexKey, JSON.stringify(next.slice(0, MAX_CACHED_MONTHS)))
  } catch {
    // 缓存容量或隐私模式异常不能影响服务端权威签到流程。
  }
}
