import { computed, onScopeDispose, ref } from "vue"

import { cacheCheckinMonth, readCachedCheckinMonth } from "@/api/checkinCache"
import { checkInToday, getMonthCheckins, type MonthCheckinSummary, type TodayCheckin } from "@/api/checkins"
import { ACCESS_TOKEN_KEY, accessTokenSubject } from "@/api/tokenStore"

const REVALIDATE_GAP_MS = 1_000
const REVALIDATE_INTERVAL_MS = 60_000
const CHECKIN_CHANNEL = "quire-checkins"
const CHECKIN_STORAGE_EVENT = "quire_checkin_refresh_event"

interface CheckinRefreshMessage {
  type: "checked-in"
  userId: string
  checkinDate: string
  emittedAt: number
}

function isCheckinRefreshMessage(value: unknown): value is CheckinRefreshMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Partial<CheckinRefreshMessage>
  return message.type === "checked-in" && typeof message.userId === "string" && typeof message.checkinDate === "string" && typeof message.emittedAt === "number"
}

export function useCheckins() {
  const summary = ref<MonthCheckinSummary | null>(null)
  const loading = ref(false)
  const checkingIn = ref(false)
  const offline = ref(!navigator.onLine)
  const stale = ref(false)
  const error = ref("")
  const activeYear = ref<number | null>(null)
  const activeMonth = ref<number | null>(null)
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHECKIN_CHANNEL)
  let activeUserId = accessTokenSubject()
  let followsCurrentMonth = false
  let loadSeq = 0
  let submitSeq = 0
  let lastRevalidateAt = 0

  // Cached or failed-read data is display-only, never proof that today is signed.
  const checkedInToday = computed(() => !stale.value && (summary.value?.checkedInToday ?? false))
  const currentStreak = computed(() => summary.value?.currentStreak ?? 0)
  const checkinDates = computed(() => summary.value?.checkinDates ?? [])

  function errorMessage(value: unknown): string {
    return value instanceof Error && value.message ? value.message : "签到状态读取失败，请稍后重试。"
  }

  function restoreCached(year?: number, month?: number): boolean {
    const cached = readCachedCheckinMonth(year, month)
    if (!cached) return false
    const current = summary.value
    // A cached snapshot must not undo newer in-memory data, including POST results.
    if (current && current.year === cached.year && current.month === cached.month && current.updatedAt >= cached.updatedAt) return false
    summary.value = cached
    activeYear.value = cached.year
    activeMonth.value = cached.month
    stale.value = true
    return true
  }

  function markOffline(): void {
    offline.value = true
    stale.value = summary.value !== null
    error.value = "当前处于离线状态，展示结果可能不是最新；联网后可继续签到。"
  }

  async function requestMonth(year: number | undefined, month: number | undefined, followCurrent: boolean): Promise<void> {
    const mine = ++loadSeq
    followsCurrentMonth = followCurrent
    if (year !== undefined && month !== undefined) { activeYear.value = year; activeMonth.value = month }
    if (!navigator.onLine) {
      // A newer offline load invalidates the older request's finally block.
      loading.value = false
      restoreCached(year, month)
      markOffline()
      return
    }
    loading.value = true
    error.value = ""
    try {
      const next = await getMonthCheckins(year, month)
      if (mine !== loadSeq) return
      summary.value = next
      activeYear.value = next.year
      activeMonth.value = next.month
      stale.value = false
      offline.value = false
      cacheCheckinMonth(next)
    } catch (value) {
      if (mine !== loadSeq) return
      restoreCached(year, month)
      stale.value = summary.value !== null
      error.value = errorMessage(value)
    } finally {
      if (mine === loadSeq) loading.value = false
    }
  }

  function load(year: number, month: number): Promise<void> { return requestMonth(year, month, false) }
  function loadCurrent(): Promise<void> { return requestMonth(undefined, undefined, true) }

  function revalidateActive(force = false): void {
    const year = activeYear.value
    const month = activeMonth.value
    // Current-month intent exists before the first successful response supplies
    // year/month. Retrying must not depend on already having fetched data.
    if (!followsCurrentMonth && (year === null || month === null)) return
    if (loading.value || checkingIn.value || !navigator.onLine) return
    const now = Date.now()
    if (!force && now - lastRevalidateAt < REVALIDATE_GAP_MS) return
    lastRevalidateAt = now
    if (followsCurrentMonth) void loadCurrent()
    else if (year !== null && month !== null) void load(year, month)
  }

  function handleCheckinMessage(event: MessageEvent<unknown>): void {
    if (!isCheckinRefreshMessage(event.data) || event.data.userId !== activeUserId) return
    revalidateActive(true)
  }

  function handleStorageEvent(event: StorageEvent): void {
    if (event.key !== CHECKIN_STORAGE_EVENT || !event.newValue) return
    try {
      const message: unknown = JSON.parse(event.newValue)
      if (!isCheckinRefreshMessage(message) || message.userId !== activeUserId) return
      revalidateActive(true)
    } catch {
      // 忽略格式异常或其他应用写入的 storage 事件。
    }
  }

  function handleAccountChange(event: StorageEvent): void {
    if (event.key !== ACCESS_TOKEN_KEY) return
    const nextUserId = accessTokenSubject(event.newValue ?? "")
    if (nextUserId === activeUserId) return
    activeUserId = nextUserId
    reset()
    if (nextUserId) void loadCurrent()
  }

  function broadcastCheckin(checkinDate: string): void {
    if (!activeUserId) return
    const message: CheckinRefreshMessage = { type: "checked-in", userId: activeUserId, checkinDate, emittedAt: Date.now() }
    if (channel) { channel.postMessage(message); return }
    try {
      localStorage.setItem(CHECKIN_STORAGE_EVENT, JSON.stringify(message))
      localStorage.removeItem(CHECKIN_STORAGE_EVENT)
    } catch {
      // 跨标签页通知失败不影响服务端签到结果与焦点刷新兜底。
    }
  }

  function markOnline(): void { offline.value = false; revalidateActive(true) }
  function handleVisibilityChange(): void { if (document.visibilityState === "visible") revalidateActive() }
  function handleWindowFocus(): void { revalidateActive() }
  function handlePeriodicRevalidation(): void { if (document.visibilityState === "visible") revalidateActive() }

  window.addEventListener("offline", markOffline)
  window.addEventListener("online", markOnline)
  window.addEventListener("focus", handleWindowFocus)
  window.addEventListener("storage", handleAccountChange)
  document.addEventListener("visibilitychange", handleVisibilityChange)
  if (channel) channel.addEventListener("message", handleCheckinMessage)
  else window.addEventListener("storage", handleStorageEvent)
  const revalidateTimer = window.setInterval(handlePeriodicRevalidation, REVALIDATE_INTERVAL_MS)

  function applyTodayResult(result: TodayCheckin): void {
    const current = summary.value
    if (!current) return
    const prefix = `${current.year}-${String(current.month).padStart(2, "0")}`
    const dates = current.checkinDates.includes(result.checkinDate) ? current.checkinDates : result.checkinDate.startsWith(prefix) ? [...current.checkinDates, result.checkinDate].sort() : current.checkinDates
    summary.value = { ...current, checkinDates: dates, today: result.checkinDate, checkedInToday: result.checkedIn, currentStreak: result.currentStreak, longestStreak: result.longestStreak, totalCheckins: result.totalCheckins }
    cacheCheckinMonth(summary.value)
  }

  async function submitToday(): Promise<void> {
    if (checkingIn.value || checkedInToday.value) return
    if (!navigator.onLine) { markOffline(); return }
    const mine = ++submitSeq
    // Invalidate reads started before this write; their snapshots can be outdated.
    loadSeq += 1
    loading.value = false
    checkingIn.value = true
    error.value = ""
    try {
      const result = await checkInToday()
      if (mine !== submitSeq) return
      applyTodayResult(result)
      broadcastCheckin(result.checkinDate)
      if (followsCurrentMonth) await loadCurrent()
      else await load(activeYear.value ?? Number(result.checkinDate.slice(0, 4)), activeMonth.value ?? Number(result.checkinDate.slice(5, 7)))
    } catch (value) {
      if (mine === submitSeq) error.value = errorMessage(value)
    } finally {
      if (mine === submitSeq) checkingIn.value = false
    }
  }

  function reset(): void {
    loadSeq += 1
    submitSeq += 1
    lastRevalidateAt = 0
    followsCurrentMonth = false
    summary.value = null
    loading.value = false
    checkingIn.value = false
    stale.value = false
    error.value = ""
    activeYear.value = null
    activeMonth.value = null
  }

  onScopeDispose(() => {
    loadSeq += 1
    submitSeq += 1
    window.removeEventListener("offline", markOffline)
    window.removeEventListener("online", markOnline)
    window.removeEventListener("focus", handleWindowFocus)
    window.removeEventListener("storage", handleAccountChange)
    document.removeEventListener("visibilitychange", handleVisibilityChange)
    if (channel) { channel.removeEventListener("message", handleCheckinMessage); channel.close() }
    else window.removeEventListener("storage", handleStorageEvent)
    window.clearInterval(revalidateTimer)
  })

  return { summary, loading, checkingIn, offline, stale, error, checkedInToday, currentStreak, checkinDates, load, loadCurrent, revalidateActive, submitToday, reset }
}
