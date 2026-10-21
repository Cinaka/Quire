"""P4 atomic conversion. Caller commits; replay never upserts an existing diary."""

import json
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.diary_entry import DiaryEntry
from app.models.schedule import Schedule
from app.services.schedule_content import schedule_content_text, trim_text
from app.services.schedule_receipts import conversion_receipt, receipt_matches
from app.services.schedules import (
    PendingScheduleRequest,
    ScheduleWriteOwner,
    allocate_schedule_revision,
    lock_schedule_owner,
    locked_schedule,
    server_revision,
)


class ConversionEntrySnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: uuid.UUID
    from_schedule_id: uuid.UUID
    entry_date: date
    sort_order: int = Field(default=0, ge=0, le=2147483647, strict=True)
    title: str = Field(max_length=255)
    content: dict | None
    content_text: str | None = None
    mood: None = None
    weather: None = None
    tag_ids: list[uuid.UUID] = Field(default_factory=list, max_length=0)
    client_updated_at: datetime
    deleted_at: datetime | None = None

    @field_validator("id", "from_schedule_id")
    @classmethod
    def stable_uuid(cls, value: uuid.UUID) -> uuid.UUID:
        if value.version != 7:
            raise ValueError("转换身份必须为UUID v7")
        return value

    @field_validator("entry_date", mode="before")
    @classmethod
    def natural_day(cls, value: object) -> object:
        return PendingScheduleRequest.natural_day(value)

    @field_validator("entry_date")
    @classmethod
    def mysql_day(cls, value: date) -> date:
        if value.year < 1000:
            raise ValueError("转换日期超出MySQL范围")
        return value

    @field_validator("client_updated_at", "deleted_at", mode="before")
    @classmethod
    def iso_instant(cls, value: object) -> object:
        return PendingScheduleRequest.iso_instant(value)

    @field_validator("client_updated_at", "deleted_at")
    @classmethod
    def utc_millisecond(cls, value: datetime | None) -> datetime | None:
        return PendingScheduleRequest.utc_millisecond(value)

    @model_validator(mode="after")
    def validate_body(self) -> "ConversionEntrySnapshot":
        self.content_text = schedule_content_text(self.content)
        if (self.deleted_at is None and not trim_text(self.title)
                and not trim_text(self.content_text)):
            raise ValueError("首次转换不能生成空日记")
        if self.deleted_at is not None and self.deleted_at > self.client_updated_at:
            raise ValueError("删除时间不能晚于提交修订")
        return self


class ScheduleConvertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_schedule_client_updated_at: datetime
    entry: ConversionEntrySnapshot

    @field_validator("expected_schedule_client_updated_at", mode="before")
    @classmethod
    def iso_instant(cls, value: object) -> object:
        return PendingScheduleRequest.iso_instant(value)

    @field_validator("expected_schedule_client_updated_at")
    @classmethod
    def utc_millisecond(cls, value: datetime) -> datetime:
        return PendingScheduleRequest.utc_millisecond(value)


@dataclass
class ConversionResult:
    schedule: Schedule | None
    entry: DiaryEntry | None
    reason: str
    created: bool = False
    confirmed: bool = False
    entry_state: Literal["active", "deleted", "purged", "unknown"] = "unknown"


async def linked_diary(
    db: AsyncSession, owner: ScheduleWriteOwner, schedule_id: uuid.UUID
) -> tuple[DiaryEntry | None, bool]:
    rows = list((await db.execute(
        select(DiaryEntry)
        .where(
            DiaryEntry.user_id == owner.id,
            (DiaryEntry.id == schedule_id) | (DiaryEntry.from_schedule_id == schedule_id),
        )
        .order_by(DiaryEntry.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )).scalars())
    collision = len(rows) > 1 or any(
        row.id != schedule_id or row.from_schedule_id != schedule_id for row in rows
    )
    return (rows[0] if rows and not collision else None), collision


def terminal_result(
    row: Schedule, entry: DiaryEntry | None, collision: bool, body: ScheduleConvertRequest
) -> ConversionResult:
    if row.converted_entry_id != row.id or row.converted_at is None or collision:
        return ConversionResult(row, None, "identity_conflict")
    result = ConversionResult(
        row, entry, "replayed", entry_state="purged" if entry is None else
        "deleted" if entry.deleted_at is not None else "active",
    )
    verified = receipt_matches(
        row.converted_receipt, body.expected_schedule_client_updated_at,
        body.entry.model_dump(mode="json"),
    )
    if verified is None:
        result.reason = "receipt_unknown"
    elif not verified:
        result.reason = "intent_conflict"
    else:
        result.confirmed = True
    return result


async def convert_schedule(
    db: AsyncSession, owner: ScheduleWriteOwner, schedule_id: uuid.UUID,
    body: ScheduleConvertRequest,
) -> ConversionResult:
    if (schedule_id.version != 7 or body.entry.id != schedule_id
            or body.entry.from_schedule_id != schedule_id):
        return ConversionResult(None, None, "identity_conflict")
    await lock_schedule_owner(db, owner)
    row = await locked_schedule(db, owner, schedule_id)
    if row is None:
        return ConversionResult(None, None, "not_found")
    entry, collision = await linked_diary(db, owner, schedule_id)
    if row.status == 1:
        # Terminal identity precedes current pending revisions, deleted flags, or diary existence.
        return terminal_result(row, entry, collision, body)
    if (row.status != 0 or row.converted_entry_id is not None or row.converted_at is not None
            or row.converted_receipt is not None):
        return ConversionResult(row, None, "invalid_state")
    if entry is not None or collision:
        return ConversionResult(row, entry, "identity_conflict")
    if row.deleted_at is not None:
        return ConversionResult(row, None, "source_deleted")
    if row.client_updated_at != body.expected_schedule_client_updated_at:
        return ConversionResult(row, None, "source_revision")
    snapshot = body.entry
    if snapshot.client_updated_at < row.client_updated_at or (
        snapshot.deleted_at is None and snapshot.client_updated_at == row.client_updated_at
    ):
        return ConversionResult(row, None, "conversion_revision")
    try:
        plain = schedule_content_text(row.content)
        if not trim_text(row.title or "") and not trim_text(plain):
            raise ValueError("空来源")
    except ValueError:
        return ConversionResult(row, None, "source_content")
    empty_tombstone = (
        snapshot.deleted_at is not None and snapshot.title == "" and snapshot.content is None
    )
    if not empty_tombstone and (
        snapshot.title != (row.title or "") or
        json.dumps(snapshot.content, sort_keys=True, ensure_ascii=False) !=
        json.dumps(row.content, sort_keys=True, ensure_ascii=False)
    ):
        return ConversionResult(row, None, "source_snapshot")
    revision = await allocate_schedule_revision(db, owner, row.updated_at)
    now = server_revision()
    entry = DiaryEntry(
        id=schedule_id, user_id=owner.id, from_schedule_id=schedule_id,
        entry_date=snapshot.entry_date, sort_order=snapshot.sort_order,
        title=snapshot.title, content=deepcopy(snapshot.content),
        content_text=snapshot.content_text,
        mood=None, weather=None, client_updated_at=snapshot.client_updated_at,
        deleted_at=snapshot.deleted_at, created_at=now, updated_at=now,
    )
    db.add(entry)
    row.status = 1
    row.converted_entry_id = schedule_id
    row.converted_at = now
    row.client_updated_at = snapshot.client_updated_at
    row.updated_at = revision
    row.content_text = plain
    row.converted_receipt = conversion_receipt(
        body.expected_schedule_client_updated_at, snapshot.model_dump(mode="json"),
    )
    await db.flush()
    return ConversionResult(
        row, entry, "applied", created=True, confirmed=True,
        entry_state="deleted" if entry.deleted_at is not None else "active",
    )


async def reread_conversion(
    db: AsyncSession, owner: ScheduleWriteOwner, schedule_id: uuid.UUID,
    body: ScheduleConvertRequest,
) -> ConversionResult:
    """After a duplicate-key rollback, ONLY read; never attempt a second insert."""
    await lock_schedule_owner(db, owner)
    row = await locked_schedule(db, owner, schedule_id)
    if row is None:
        return ConversionResult(None, None, "not_found")
    entry, collision = await linked_diary(db, owner, schedule_id)
    if row.status == 1:
        return terminal_result(row, entry, collision, body)
    return ConversionResult(row, entry, "identity_conflict")
