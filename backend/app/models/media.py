import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Index, Integer, String, text
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS


class Media(Base):
    __tablename__ = "media"
    __table_args__ = (Index("idx_entry", "entry_id"), TABLE_ARGS)

    id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, nullable=False)
    entry_id: Mapped[uuid.UUID | None] = mapped_column(UUIDBinary)
    url: Mapped[str] = mapped_column(String(512), nullable=False)
    thumb_url: Mapped[str | None] = mapped_column(String(512))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    size: Mapped[int | None] = mapped_column(BigInteger)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(
        MySQLDateTime(fsp=3), nullable=False, server_default=text("CURRENT_TIMESTAMP(3)")
    )
