import type { LocalDate } from "@/shared/types"

import { get, post } from "./request"

export interface TodayCheckin {
  checkinDate: LocalDate
  checkedIn: boolean
  created: boolean
  currentStreak: number
}

export interface MonthCheckinSummary {
  year: number
  month: number
  checkinDates: LocalDate[]
  today: LocalDate
  checkedInToday: boolean
  currentStreak: number
}

interface RawTodayCheckin {
  checkin_date: LocalDate
  checked_in: boolean
  created: boolean
  current_streak: number
}

interface RawMonthCheckinSummary {
  year: number
  month: number
  checkin_dates: LocalDate[]
  today: LocalDate
  checked_in_today: boolean
  current_streak: number
}

function toTodayCheckin(raw: RawTodayCheckin): TodayCheckin {
  return {
    checkinDate: raw.checkin_date,
    checkedIn: Boolean(raw.checked_in),
    created: Boolean(raw.created),
    currentStreak: raw.current_streak,
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
  }
}

export async function checkInToday(): Promise<TodayCheckin> {
  const data = await post<RawTodayCheckin>("/checkins/today")
  return toTodayCheckin(data)
}

export async function getMonthCheckins(
  year: number,
  month: number,
): Promise<MonthCheckinSummary> {
  const data = await get<RawMonthCheckinSummary>("/checkins/month", { year, month })
  return toMonthCheckinSummary(data)
}
