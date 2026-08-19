import type { Iso, LocalDate } from "./types"

/** 所有时间戳统一走这里，保证存的是 UTC。 */
export function utcNow(): Iso {
  return new Date().toISOString()
}

/**
 * 取本地日历日。
 *
 * 绝对不要写 new Date().toISOString().slice(0, 10)——那取的是 UTC 日期。
 * 上海时间 8 月 19 日 00:30 写日记，UTC 是 8 月 18 日 16:30，
 * 那样会把这篇存成 18 号。这个 bug 只在凌晨 0 点到 8 点之间出现，平时测不出来。
 */
export function todayLocal(d: Date = new Date()): LocalDate {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** 把 UTC 时间戳转成本地显示用的字符串。 */
export function formatLocal(iso: Iso): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
