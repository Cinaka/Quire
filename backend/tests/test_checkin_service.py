from datetime import date, datetime, timezone
from zoneinfo import ZoneInfoNotFoundError

import pytest

from app.services.checkins import account_local_date, current_streak, month_bounds


def test_account_local_date_uses_account_timezone() -> None:
    instant = datetime(2026, 9, 22, 16, 30, tzinfo=timezone.utc)

    assert account_local_date("Asia/Shanghai", now=instant) == date(2026, 9, 23)
    assert account_local_date("America/New_York", now=instant) == date(2026, 9, 22)


def test_account_local_date_treats_naive_time_as_utc() -> None:
    instant = datetime(2026, 9, 22, 16, 30)

    assert account_local_date("Asia/Shanghai", now=instant) == date(2026, 9, 23)


def test_account_local_date_rejects_invalid_timezone() -> None:
    with pytest.raises(ZoneInfoNotFoundError):
        account_local_date("Invalid/Timezone")


def test_current_streak_includes_today_after_checkin() -> None:
    days = [date(2026, 9, 21), date(2026, 9, 22), date(2026, 9, 23)]

    assert current_streak(days, date(2026, 9, 23)) == 3


def test_current_streak_uses_yesterday_before_today_checkin() -> None:
    days = [date(2026, 9, 20), date(2026, 9, 21), date(2026, 9, 22)]

    assert current_streak(days, date(2026, 9, 23)) == 3


def test_current_streak_stops_at_first_gap() -> None:
    days = [date(2026, 9, 19), date(2026, 9, 21), date(2026, 9, 22)]

    assert current_streak(days, date(2026, 9, 23)) == 2


def test_current_streak_deduplicates_dates_and_ignores_future_dates() -> None:
    days = [date(2026, 9, 22), date(2026, 9, 22), date(2026, 9, 24)]

    assert current_streak(days, date(2026, 9, 23)) == 1


def test_month_bounds_are_left_closed_and_right_open() -> None:
    assert month_bounds(2026, 9) == (date(2026, 9, 1), date(2026, 10, 1))
    assert month_bounds(2026, 12) == (date(2026, 12, 1), date(2027, 1, 1))
