from datetime import date

from sqlalchemy import Date, UniqueConstraint

from app.models import Checkin


def test_checkin_model_uses_one_row_per_user_local_date() -> None:
    table = Checkin.__table__

    assert table.name == "checkins"
    assert set(table.columns.keys()) == {"id", "user_id", "checkin_date", "created_at"}
    assert isinstance(table.c.checkin_date.type, Date)
    assert table.c.checkin_date.nullable is False
    assert table.c.created_at.nullable is False
    assert str(table.c.created_at.server_default.arg) == "CURRENT_TIMESTAMP(3)"
    assert not table.foreign_keys

    constraints = [
        constraint
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
    ]
    assert len(constraints) == 1
    assert constraints[0].name == "uk_checkins_user_date"
    assert [column.name for column in constraints[0].columns] == ["user_id", "checkin_date"]


def test_checkin_accepts_a_local_calendar_date() -> None:
    checkin_date = date(2026, 9, 23)
    checkin = Checkin(checkin_date=checkin_date)

    assert checkin.checkin_date == checkin_date
