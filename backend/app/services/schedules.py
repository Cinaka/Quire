"""Pending-only P4 writes; callers own commit, conflicts never replace data."""

import json
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import as_utc_naive, utcnow
from app.models.schedule import Schedule
from app.models.user import User
from app.services.schedule_content import schedule_content_text, trim_text

WriteOutcome = Literal["applied", "replayed", "stale", "conflict", "terminal", "not_found"]


@dataclass(frozen=True)
class ScheduleWriteOwner:
    id: uuid.UUID


class PendingScheduleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    remind_date: date
    title: str = Field(max_length=255)
    content: dict | None
    # Wire compatibility only: always replace with content-derived text.
    content_text: str | None = None
    status: Literal["pending"] = "pending"
    client_updated_at: datetime
    deleted_at: datetime | None = None

    @field_validator("remind_date", mode="before")
    @classmethod
    def natural_day(cls, value: object) -> object:
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        if (
            not isinstance(value, str) or len(value) != 10
            or value[4] != "-" or value[7] != "-"
        ):
            raise ValueError("预简日期必须为YYYY-MM-DD自然日")
        return value

    @field_validator("client_updated_at", "deleted_at", mode="before")
    @classmethod
    def iso_instant(cls, value: object) -> object:
        if value is None or isinstance(value, datetime):
            return value
        if not isinstance(value, str) or len(value) < 19 or value[10] not in {"T", "t"}:
            raise ValueError("预简修订必须为ISO时间，不接受数字时间戳或日期截取")
        return value

    @field_validator("client_updated_at", "deleted_at")
    @classmethod
    def utc_millisecond(cls, value: datetime | None) -> datetime | None:
        if value is None:
            return None
        value = as_utc_naive(value)
        if value.year < 1000 or value.microsecond % 1000:
            raise ValueError("预简时间必须在MySQL日期范围内，且精度不得超过毫秒")
        return value

    @model_validator(mode="after")
    def derive_content(self) -> "PendingScheduleRequest":
        self.content_text = schedule_content_text(self.content)
        if not trim_text(self.title) and not trim_text(self.content_text):
            raise ValueError("请填写预简标题或正文")
        return self


def server_revision(previous: datetime | None = None) -> datetime:
    current = utcnow()
    current = current.replace(microsecond=current.microsecond // 1000 * 1000)
    return max(current, previous + timedelta(milliseconds=1)) if previous else current


def is_duplicate(error: IntegrityError) -> bool:
    original = error.orig
    args = getattr(original, "args", ())
    # MySQL duplicate key, plus SQLite primary/unique codes for isolated tests.
    return bool(args and args[0] == 1062) or getattr(original, "sqlite_errorcode", None) in {
        1555, 2067,
    }


async def lock_schedule_owner(db: AsyncSession, owner: ScheduleWriteOwner) -> None:
    """Existing User row is a per-account barrier; callers release at commit/rollback."""
    result = await db.execute(select(User.id).where(User.id == owner.id).with_for_update())
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=401, detail="账号已失效")


async def latest_schedule_revision(
    db: AsyncSession, owner: ScheduleWriteOwner
) -> datetime | None:
    # Locking CURRENT read, not a potentially older auth/REPEATABLE READ snapshot.
    result = await db.execute(
        select(Schedule.updated_at)
        .where(Schedule.user_id == owner.id)
        .order_by(Schedule.updated_at.desc(), Schedule.id.desc())
        .limit(1)
        .with_for_update()
    )
    return result.scalar_one_or_none()


async def allocate_schedule_revision(
    db: AsyncSession, owner: ScheduleWriteOwner, previous: datetime | None = None
) -> datetime:
    """Caller MUST hold the owner barrier. Every committed P4 write advances its head."""
    head = await latest_schedule_revision(db, owner)
    times = [value for value in (head, previous) if value is not None]
    return server_revision(max(times) if times else None)


async def locked_schedule(
    db: AsyncSession, user: User | ScheduleWriteOwner, schedule_id: uuid.UUID
) -> Schedule | None:
    return await db.scalar(
        select(Schedule)
        .where(Schedule.id == schedule_id, Schedule.user_id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def same_pending_snapshot(row: Schedule, body: PendingScheduleRequest) -> bool:
    return (
        row.remind_date == body.remind_date
        and (row.title or "") == body.title
        and json.dumps(row.content, sort_keys=True, ensure_ascii=False, allow_nan=False)
        == json.dumps(body.content, sort_keys=True, ensure_ascii=False, allow_nan=False)
        and (row.content_text or "") == body.content_text
        and row.deleted_at == body.deleted_at
    )


async def upsert_schedule(
    db: AsyncSession,
    user: User | ScheduleWriteOwner,
    schedule_id: uuid.UUID,
    body: PendingScheduleRequest,
) -> tuple[Schedule | None, WriteOutcome]:
    # Rollback expires even User ORM attributes: pin ownership before the first request.
    owner = ScheduleWriteOwner(user.id)
    await lock_schedule_owner(db, owner)
    row = await locked_schedule(db, owner, schedule_id)
    if row is None:
        now = await allocate_schedule_revision(db, owner)
        row = Schedule(
            id=schedule_id, user_id=owner.id, remind_date=body.remind_date,
            title=body.title, content=deepcopy(body.content), content_text=body.content_text,
            status=0, converted_entry_id=None, converted_at=None,
            client_updated_at=body.client_updated_at, deleted_at=body.deleted_at,
            created_at=now, updated_at=now,
        )
        db.add(row)
        try:
            await db.flush()
            return row, "applied"
        except IntegrityError as error:
            await db.rollback()
            if not is_duplicate(error):
                raise
            # Fresh locked read after insert race; never retain the failed candidate.
            await lock_schedule_owner(db, owner)
            row = await locked_schedule(db, owner, schedule_id)
            if row is None:
                return None, "not_found"
    if row.status != 0 or row.converted_entry_id is not None or row.converted_at is not None:
        return row, "terminal"
    if body.client_updated_at < row.client_updated_at:
        return row, "stale"
    if body.client_updated_at == row.client_updated_at:
        return row, "replayed" if same_pending_snapshot(row, body) else "conflict"
    row.remind_date = body.remind_date
    row.title = body.title
    row.content = deepcopy(body.content)
    row.content_text = body.content_text
    row.client_updated_at = body.client_updated_at
    row.deleted_at = body.deleted_at
    row.updated_at = await allocate_schedule_revision(db, owner, row.updated_at)
    await db.flush()
    return row, "applied"
