import { computed, onScopeDispose, ref } from "vue"

import {
  checkInToday,
  getMonthCheckins,
  type MonthCheckinSummary,
  type TodayCheckin,
} from "@/api/checkins"

const REVALIDATE_GAP_MS = 1_000

export function useCheckins() {
  const summary = ref<MonthCheckinSummary | null>(null)
  const loading = ref(false)
  const checkingIn = ref(false)
  const offline = ref(!navigator.onLine)
  const stale = ref(false)
  const error = ref("")
  const activeYear = ref<number | null>(null)
  const activeMonth = ref<number | null>(null)
  let loadSeq = 0
  let submitSeq = 0
  let lastRevalidateAt = 0

  const checkedInToday = computed(() => summary.value?.checkedInToday ?? false)
  const currentStreak = computed(() => summary.value?.currentStreak ?? 0)
  const checkinDates = computed(() => summary.value?.checkinDates ?? [])

  function errorMessage(value: unknown): string {
    return value instanceof Error && value.message ? value.message : "签到状态读取失败，请稍后重试。"
  }

  function markOffline(): void {
    offline.value = true
    stale.value = summary.value !== null
    error.value = "当前处于离线状态，联网后可继续签到。"
  }

  async function load(year: number, month: number): Promise<void> {
    const mine = ++loadSeq
    activeYear.value = year
    activeMonth.value = month

    if (!navigator.onLine) {
      markOffline()
      return
    }

    loading.value = true
    error.value = ""
    try {
      const next = await getMonthCheckins(year, month)
      if (mine !== loadSeq) return
      summary.value = next
      stale.value = false
      offline.value = false
    } catch (value) {
      if (mine !== loadSeq) return
      stale.value = summary.value !== null
      error.value = errorMessage(value)
    } finally {
      if (mine === loadSeq) loading.value = false
    }
  }

  function revalidateActive(force = false): void {
    const year = activeYear.value
    const month = activeMonth.value
    if (year === null || month === null || checkingIn.value || !navigator.onLine) return

    const now = Date.now()
    if (!force && now - lastRevalidateAt < REVALIDATE_GAP_MS) return
    lastRevalidateAt = now
    void load(year, month)
  }

  function markOnline(): void {
    offline.value = false
    revalidateActive(true)
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === "visible") revalidateActive()
  }

  function handleWindowFocus(): void {
    revalidateActive()
  }

  window.addEventListener("offline", markOffline)
  window.addEventListener("online", markOnline)
  window.addEventListener("focus", handleWindowFocus)
  document.addEventListener("visibilitychange", handleVisibilityChange)

  function applyTodayResult(result: TodayCheckin): void {
    const current = summary.value
    if (!current) return

    const prefix = `${current.year}-${String(current.month).padStart(2, "0")}`
    const dates = current.checkinDates.includes(result.checkinDate)
      ? current.checkinDates
      : result.checkinDate.startsWith(prefix)
        ? [...current.checkinDates, result.checkinDate].sort()
        : current.checkinDates

    summary.value = {
      ...current,
      checkinDates: dates,
      today: result.checkinDate,
      checkedInToday: result.checkedIn,
      currentStreak: result.currentStreak,
    }
  }

  async function submitToday(): Promise<void> {
    if (checkingIn.value || checkedInToday.value) return
    if (!navigator.onLine) {
      markOffline()
      return
    }

    const mine = ++submitSeq
    checkingIn.value = true
    error.value = ""
    try {
      const result = await checkInToday()
      if (mine !== submitSeq) return
      applyTodayResult(result)

      const year = activeYear.value ?? Number(result.checkinDate.slice(0, 4))
      const month = activeMonth.value ?? Number(result.checkinDate.slice(5, 7))
      await load(year, month)
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
    document.removeEventListener("visibilitychange", handleVisibilityChange)
  })

  return {
    summary,
    loading,
    checkingIn,
    offline,
    stale,
    error,
    checkedInToday,
    currentStreak,
    checkinDates,
    load,
    revalidateActive,
    submitToday,
    reset,
  }
}
