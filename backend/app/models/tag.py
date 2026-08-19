import uuid
from datetime import datetime

from sqlalchemy import String, UniqueConstraint, text
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS


class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uk_user_name"),
        TABLE_ARGS,
    )

    id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, nullable=False)
    name: Mapped[str] = mapped_column(String(32), nullable=False)
    color: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(
        MySQLDateTime(fsp=3), nullable=False, server_default=text("CURRENT_TIMESTAMP(3)")
    )
