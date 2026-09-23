import uuid
from datetime import datetime

from sqlalchemy import Index, Integer, text
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS


class RefreshSession(Base):
    __tablename__ = "refresh_sessions"
    __table_args__ = (Index("idx_refresh_user", "user_id"), TABLE_ARGS)

    id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, nullable=False)
    token_version: Mapped[int] = mapped_column(Integer, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(MySQLDateTime(fsp=3), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(MySQLDateTime(fsp=3))
    created_at: Mapped[datetime] = mapped_column(
        MySQLDateTime(fsp=3),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP(3)"),
    )
