"""P4 read-only schedule queries; write/sync/convert routes are added separately."""

import uuid
from datetime import date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.schedule import Schedule
from app.models.user import User
from app.schemas.envelope import Envelope, Page, ok, paged

router = APIRouter(prefix="/schedules", tags=["schedules"])
ScheduleStatus = Literal["pending", "converted"]
STATUS_VALUES: dict[ScheduleStatus, int] = {"pending": 0, "converted": 1}
STATUS_NAMES: dict[int, ScheduleStatus] = {0: "pending", 1: "converted"}


class ScheduleResponse(BaseModel):
    id: uuid.UUID
    remind_date: date
    title: str
    content: dict | None
    content_text: str
    status: ScheduleStatus
    converted_entry_id: uuid.UUID | None
    converted_at: datetime | None
    client_updated_at: datetime
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


def to_response(row: Schedule) -> ScheduleResponse:
    # Do not invent a revision, derive a day, or expose user_id on a read.
    return ScheduleResponse(
        id=row.id,
        remind_date=row.remind_date,
        title=row.title or "",
        content=row.content,
        content_text=row.content_text or "",
        status=STATUS_NAMES[row.status],
        converted_entry_id=row.converted_entry_id,
        converted_at=row.converted_at,
        client_updated_at=row.client_updated_at,
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("")
async def list_schedules(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    status: ScheduleStatus | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    only_deleted: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[Page[ScheduleResponse]]:
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(status_code=422, detail="date_from 不能晚于 date_to")
    query = select(Schedule).where(Schedule.user_id == user.id)
    query = query.where(
        Schedule.deleted_at.is_not(None) if only_deleted else Schedule.deleted_at.is_(None)
    )
    if status is not None:
        query = query.where(Schedule.status == STATUS_VALUES[status])
    if date_from is not None:
        query = query.where(Schedule.remind_date >= date_from)
    if date_to is not None:
        query = query.where(Schedule.remind_date <= date_to)
    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = (
        await db.execute(
            query.order_by(Schedule.remind_date.asc(), Schedule.id.asc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).scalars()
    return paged([to_response(row) for row in rows], total, page, page_size)


# Future static /sync routes must be registered before this UUID detail route.
@router.get("/{schedule_id}")
async def get_schedule(
    schedule_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[ScheduleResponse]:
    row = await db.scalar(
        select(Schedule).where(Schedule.id == schedule_id, Schedule.user_id == user.id)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="预简不存在")
    # Detail includes the owner's tombstone; list defaults to live records only.
    return ok(to_response(row))
