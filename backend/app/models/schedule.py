import uuid
from datetime import date, datetime

from sqlalchemy import JSON, CheckConstraint, Index, String, UniqueConstraint, text
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.dialects.mysql import MEDIUMTEXT, TINYINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS, TimestampMixin


class Schedule(TimestampMixin, Base):
    __tablename__ = "schedules"
    __table_args__ = (
        UniqueConstraint("converted_entry_id", name="uk_schedule_converted_entry"),
        CheckConstraint("status IN (0, 1)", name="ck_schedule_status"),
        CheckConstraint(
            "(status = 0 AND converted_entry_id IS NULL AND converted_at IS NULL) OR "
            "(status = 1 AND converted_entry_id IS NOT NULL "
            "AND converted_entry_id = id AND converted_at IS NOT NULL)",
            name="ck_schedule_conversion",
        ),
        Index("idx_schedule_user_date", "user_id", "remind_date"),
        Index("idx_schedule_user_updated", "user_id", "updated_at", "id"),
        Index("idx_schedule_user_status_date", "user_id", "status", "remind_date"),
        TABLE_ARGS,
    )

    id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, nullable=False)
    remind_date: Mapped[date] = mapped_column(nullable=False)
    title: Mapped[str | None] = mapped_column(String(255))
    content: Mapped[dict | None] = mapped_column(JSON)
    content_text: Mapped[str | None] = mapped_column(MEDIUMTEXT)
    status: Mapped[int] = mapped_column(TINYINT, nullable=False, server_default=text("0"))
    converted_entry_id: Mapped[uuid.UUID | None] = mapped_column(UUIDBinary)
    converted_at: Mapped[datetime | None] = mapped_column(MySQLDateTime(fsp=3))
    client_updated_at: Mapped[datetime] = mapped_column(MySQLDateTime(fsp=3), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(MySQLDateTime(fsp=3))
