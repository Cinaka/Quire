import { isBackupSchedule } from "./scheduleBackup"
import { assertScheduleDate, scheduleEntryId, schedulePhase } from "./schedules"
import { todayLocal } from "./time"
import type { LocalDate, Schedule } from "./types"

export interface ScheduleReminderSummary {
  asOf: LocalDate; dueToday: number; overdue: number; dueTotal: number
}
export interface ScheduleReminderPort {
  read(today: LocalDate): Promise<ScheduleReminderSummary>
  watch?(changed: () => void, expired: () => void): () => void
}
/** Read-only derived counts over all local sources, never a paginated list or UTC date slice. */
export function summarizeScheduleReminders(rows: Schedule[], today: LocalDate): ScheduleReminderSummary {
  assertScheduleDate(today)
  if (!Array.isArray(rows)) throw new Error("预简列表不可读取")
  const ids = new Set<string>()
  let dueToday = 0, overdue = 0
  for (const row of rows) {
    if (!isBackupSchedule(row) || scheduleEntryId(row.id) !== row.id || ids.has(row.id)) throw new Error("预简记录无效")
    ids.add(row.id)
    const phase = schedulePhase(row, today)
    if (phase === "due") dueToday++
    if (phase === "overdue") overdue++
  }
  return { asOf: today, dueToday, overdue, dueTotal: dueToday + overdue }
}
function checked(raw: ScheduleReminderSummary, today: LocalDate): ScheduleReminderSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 4 ||
      Object.keys(raw).some(key => !["asOf", "dueToday", "overdue", "dueTotal"].includes(key)) ||
      raw.asOf !== today || [raw.dueToday, raw.overdue, raw.dueTotal].some(n => !Number.isSafeInteger(n) || n < 0) ||
      raw.dueToday + raw.overdue !== raw.dueTotal) throw new Error("预简提醒统计无效")
  return { ...raw }
}
export function createScheduleReminder(port: ScheduleReminderPort, clock: () => Date = () => new Date()) {
  let alive = true, serial = 0, repeat = false, flight: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const state: { status: "idle" | "loading" | "ready" | "error" | "expired" | "disposed"; summary: ScheduleReminderSummary | null } = { status: "idle", summary: null }
  function emit(): void { for (const listener of listeners) { try { listener() } catch { /* Observer cannot authorize or change a read. */ } } }
  function invalidate(): void {
    if (!alive) return
    alive = false; serial++; repeat = false; state.status = "expired"; state.summary = null; emit()
  }
  async function read(run: number): Promise<void> {
    do {
      repeat = false
      if (!alive || run !== serial) return
      state.status = "loading"; state.summary = null; emit()
      try {
        const date = clock()
        if (!Number.isFinite(date.getTime())) throw new Error("本机日期无效")
        const today = todayLocal(date)
        assertScheduleDate(today)
        const raw = await port.read(today)
        if (!alive || run !== serial) return
        // A read spanning local midnight cannot publish yesterday's counts.
        if (todayLocal(clock()) !== today) { repeat = true; continue }
        state.summary = checked(raw, today); state.status = "ready"; emit()
      } catch (error) {
        if (!alive || run !== serial) return
        if ((error as { code?: unknown } | null)?.code === "SCHEDULE_WORKSPACE_CONTEXT_EXPIRED") { invalidate(); return }
        state.summary = null; state.status = "error"; emit()
      }
    } while (repeat && alive && run === serial)
  }
  return {
    inspect: () => ({ ...state, summary: state.summary ? { ...state.summary } : null }),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh(): Promise<void> {
      if (!alive) return Promise.resolve()
      if (flight) { repeat = true; return flight }
      const run = ++serial
      // Assign the shared promise before invoking the port or notifying observers.
      flight = Promise.resolve().then(() => read(run)).finally(() => { flight = null })
      return flight
    },
    invalidate,
    dispose() { if (state.status === "disposed") return; alive = false; serial++; repeat = false; state.status = "disposed"; state.summary = null; emit(); listeners.clear() },
  }
}
