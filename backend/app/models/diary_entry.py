import uuid
from datetime import date, datetime

from sqlalchemy import JSON, Index, Integer, String, UniqueConstraint, text
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.dialects.mysql import MEDIUMTEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS, TimestampMixin


class DiaryEntry(TimestampMixin, Base):
    __tablename__ = "diary_entries"
    __table_args__ = (
        UniqueConstraint("from_schedule_id", name="uk_from_schedule"),
        Index("idx_user_date", "user_id", "entry_date"),
        Index("idx_user_updated", "user_id", "updated_at"),
        Index(
            "ft_content",
            "title",
            "content_text",
            mysql_prefix="FULLTEXT",
            mysql_with_parser="ngram",
        ),
        TABLE_ARGS,
    )

    id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, nullable=False)

    entry_date: Mapped[date] = mapped_column(nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    title: Mapped[str | None] = mapped_column(String(255))
    content: Mapped[dict | None] = mapped_column(JSON)
    content_text: Mapped[str | None] = mapped_column(MEDIUMTEXT)

    mood: Mapped[str | None] = mapped_column(String(16))
    weather: Mapped[str | None] = mapped_column(String(16))

    from_schedule_id: Mapped[uuid.UUID | None] = mapped_column(UUIDBinary)

    client_updated_at: Mapped[datetime | None] = mapped_column(MySQLDateTime(fsp=3))
    deleted_at: Mapped[datetime | None] = mapped_column(MySQLDateTime(fsp=3))
