import uuid

from sqlalchemy import Index
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS


class EntryTag(Base):
    __tablename__ = "entry_tags"
    __table_args__ = (Index("idx_tag", "tag_id"), TABLE_ARGS)

    entry_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    tag_id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
