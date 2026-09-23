from datetime import datetime, timedelta, timezone

from app.core.time import as_utc_naive


def test_as_utc_naive_converts_offset_to_utc() -> None:
    source = datetime(2026, 9, 22, 8, 30, tzinfo=timezone(timedelta(hours=8)))
    assert as_utc_naive(source) == datetime(2026, 9, 22, 0, 30)


def test_as_utc_naive_keeps_database_naive_value() -> None:
    source = datetime(2026, 9, 22, 0, 30)
    assert as_utc_naive(source) is source
