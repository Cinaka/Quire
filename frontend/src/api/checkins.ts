import type { LocalDate } from "@/shared/types"

import { get, http, type Envelope } from "./request"

export interface TodayCheckin {
  checkinDate: LocalDate
  checkedIn: boolean
  created: boolean
  currentStreak: number
  longestStreak: number
  totalCheckins: number
}

export interface MonthCheckinSummary {
  year: number
  month: number
  checkinDates: LocalDate[]
  today: LocalDate
  checkedInToday: boolean
  currentStreak: number
  longestStreak: number
  totalCheckins: number
}

interface RawTodayCheckin {
  checkin_date: LocalDate
  checked_in: boolean
  created: boolean
  current_streak: number
  longest_streak: number
  total_checkins: number
}

interface RawMonthCheckinSummary {
  year: number
  month: number
  checkin_dates: LocalDate[]
  today: LocalDate
  checked_in_today: boolean
  current_streak: number
  longest_streak: number
  total_checkins: number
}

function toTodayCheckin(raw: RawTodayCheckin): TodayCheckin {
  return {
    checkinDate: raw.checkin_date,
    checkedIn: Boolean(raw.checked_in),
    created: Boolean(raw.created),
    currentStreak: raw.current_streak,
    longestStreak: raw.longest_streak,
    totalCheckins: raw.total_checkins,
  }
}

function toMonthCheckinSummary(raw: RawMonthCheckinSummary): MonthCheckinSummary {
  return {
    year: raw.year,
    month: raw.month,
    checkinDates: raw.checkin_dates ?? [],
    today: raw.today,
    checkedInToday: Boolean(raw.checked_in_today),
    currentStreak: raw.current_streak,
    longestStreak: raw.longest_streak,
    totalCheckins: raw.total_checkins,
  }
}

export async function checkInToday(): Promise<TodayCheckin> {
  const idempotencyKey = crypto.randomUUID()
  const response = await http.post<Envelope<RawTodayCheckin>>(
    "/checkins/today",
    undefined,
    { headers: { "X-Idempotency-Key": idempotencyKey } },
  )
  return toTodayCheckin(response.data.data)
}

export async function getMonthCheckins(
  year?: number,
  month?: number,
): Promise<MonthCheckinSummary> {
  const params = year === undefined || month === undefined ? undefined : { year, month }
  const data = await get<RawMonthCheckinSummary>("/checkins/month", params)
  return toMonthCheckinSummary(data)
}
