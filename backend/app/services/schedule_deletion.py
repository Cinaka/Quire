"""Sparse converted-source deletion writes; never edit or recreate its diary."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.schedule import Schedule
from app.services.schedules import (
    PendingScheduleRequest,
    ScheduleWriteOwner,
    allocate_schedule_revision,
    lock_schedule_owner,
    locked_schedule,
)

DeletionOutcome = Literal[
    "applied", "replayed", "stale", "conflict", "source_revision",
    "not_terminal", "invalid_state", "not_found",
]


class TerminalScheduleDeletionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["converted"]
    expected_schedule_client_updated_at: datetime
    client_updated_at: datetime
    # Required even for restore: missing is not an instruction to clear deletion.
    deleted_at: datetime | None

    @field_validator("expected_schedule_client_updated_at", "client_updated_at", "deleted_at",
                     mode="before")
    @classmethod
    def iso_instant(cls, value: object) -> object:
        return PendingScheduleRequest.iso_instant(value)

    @field_validator("expected_schedule_client_updated_at", "client_updated_at", "deleted_at")
    @classmethod
    def utc_millisecond(cls, value: datetime | None) -> datetime | None:
        return PendingScheduleRequest.utc_millisecond(value)

    @model_validator(mode="after")
    def ordered_revisions(self) -> "TerminalScheduleDeletionRequest":
        if self.client_updated_at <= self.expected_schedule_client_updated_at:
            raise ValueError("删除恢复修订必须严格晚于所读来源修订")
        if self.deleted_at is not None and self.deleted_at > self.client_updated_at:
            raise ValueError("删除时间不能晚于提交修订")
        return self


async def update_terminal_deletion(
    db: AsyncSession, owner: ScheduleWriteOwner, schedule_id: uuid.UUID,
    body: TerminalScheduleDeletionRequest,
) -> tuple[Schedule | None, DeletionOutcome]:
    await lock_schedule_owner(db, owner)
    row = await locked_schedule(db, owner, schedule_id)
    if row is None:
        return None, "not_found"
    if row.status != 1:
        return row, "not_terminal"
    if row.converted_entry_id != row.id or row.converted_at is None:
        return row, "invalid_state"
    # Receipt may be absent on older terminal rows; preserve it verbatim, don't guess it.
    if body.client_updated_at < row.client_updated_at:
        return row, "stale"
    if body.client_updated_at == row.client_updated_at:
        return row, "replayed" if body.deleted_at == row.deleted_at else "conflict"
    if body.expected_schedule_client_updated_at != row.client_updated_at:
        return row, "source_revision"
    revision = await allocate_schedule_revision(db, owner, row.updated_at)
    row.deleted_at = body.deleted_at
    row.client_updated_at = body.client_updated_at
    row.updated_at = revision
    await db.flush()
    return row, "applied"
