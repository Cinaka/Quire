from datetime import datetime

from sqlalchemy import text
from sqlalchemy.dialects.mysql import DATETIME as MySQLDateTime
from sqlalchemy.orm import Mapped, mapped_column


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        MySQLDateTime(fsp=3),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP(3)"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        MySQLDateTime(fsp=3),
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)"),
    )


TABLE_ARGS = {
    "mysql_engine": "InnoDB",
    "mysql_charset": "utf8mb4",
    "mysql_collate": "utf8mb4_0900_ai_ci",
}
