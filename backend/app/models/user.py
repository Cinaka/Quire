import uuid

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UUIDBinary
from app.db.mixins import TABLE_ARGS, TimestampMixin


class User(TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = TABLE_ARGS

    id: Mapped[uuid.UUID] = mapped_column(UUIDBinary, primary_key=True)
    phone: Mapped[str | None] = mapped_column(String(20), unique=True)
    email: Mapped[str | None] = mapped_column(String(128), unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    nickname: Mapped[str | None] = mapped_column(String(64))
    avatar: Mapped[str | None] = mapped_column(String(512))
    # 服务端定时任务（日程提醒推送、连续签到判定）依赖此字段，P1 用不到但必须现在建好
    timezone: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default="Asia/Shanghai"
    )
