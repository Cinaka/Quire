import uuid
from datetime import date, datetime

from sqlalchemy import UniqueConstraint, text
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS


class Checkin(Base):
    __tablename__ = "checkins"
    __table_args__ = (
        UniqueConstraint("user_id", "checkin_date", name="uk_checkins_user_date"),
        TABLE_ARGS,
    )

    id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, nullable=False)
    checkin_date: Mapped[date] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        MySQLDateTime(fsp=3),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP(3)"),
    )
