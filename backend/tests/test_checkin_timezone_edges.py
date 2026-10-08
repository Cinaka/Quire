import os
from datetime import date, datetime, timezone

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.services.checkins import account_local_date, current_streak, month_bounds


def test_same_instant_can_be_different_years_by_account_timezone() -> None:
    instant = datetime(2026, 12, 31, 16, 30, tzinfo=timezone.utc)

    assert account_local_date("Asia/Shanghai", now=instant) == date(2027, 1, 1)
    assert account_local_date("America/New_York", now=instant) == date(2026, 12, 31)


def test_new_york_local_midnight_is_correct_near_dst_start() -> None:
    before_midnight = datetime(2026, 3, 8, 4, 59, tzinfo=timezone.utc)
    after_midnight = datetime(2026, 3, 8, 5, 1, tzinfo=timezone.utc)

    assert account_local_date("America/New_York", now=before_midnight) == date(2026, 3, 7)
    assert account_local_date("America/New_York", now=after_midnight) == date(2026, 3, 8)


def test_current_streak_crosses_month_and_year_boundaries() -> None:
    days = [date(2026, 12, 30), date(2026, 12, 31), date(2027, 1, 1)]

    assert current_streak(days, date(2027, 1, 1)) == 3
    assert current_streak(days[:-1], date(2027, 1, 1)) == 2


def test_month_bounds_support_leap_february_and_year_rollover() -> None:
    assert month_bounds(2028, 2) == (date(2028, 2, 1), date(2028, 3, 1))
    assert month_bounds(2026, 12) == (date(2026, 12, 1), date(2027, 1, 1))
