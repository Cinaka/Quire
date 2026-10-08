from datetime import date, datetime, timezone
from zoneinfo import ZoneInfoNotFoundError

import pytest

from app.services.checkins import account_local_date


@pytest.mark.parametrize(
    "timezone_name",
    ["", "/etc/localtime", "../UTC", "Asia//Shanghai", "Asia/\x00Shanghai", "Invalid/Timezone"],
)
def test_invalid_timezone_has_consistent_error(timezone_name: str) -> None:
    with pytest.raises(ZoneInfoNotFoundError):
        account_local_date(timezone_name)


def test_valid_timezone_still_uses_account_calendar_day() -> None:
    instant = datetime(2026, 10, 8, 16, 30, tzinfo=timezone.utc)
    assert account_local_date("Asia/Shanghai", now=instant) == date(2026, 10, 9)
    assert account_local_date("UTC", now=instant) == date(2026, 10, 8)
