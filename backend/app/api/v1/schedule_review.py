"""P4 terminal review GET: coherent locked read, rollback only, no conversion or repair."""

import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.entries import EntryResponse
from app.api.v1.schedule_conversion import response_snapshot
from app.api.v1.schedules import ScheduleResponse
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.services.schedule_conversion import ConversionResult, linked_diary
from app.services.schedule_review import ReviewReason, terminal_review_state
from app.services.schedules import ScheduleWriteOwner, lock_schedule_owner, locked_schedule

router = APIRouter(prefix="/schedules", tags=["schedules"])


class ScheduleTerminalReviewResponse(BaseModel):
    read_only: Literal[True] = True
    reviewable: bool
    reason: ReviewReason
    schedule: ScheduleResponse | None
    entry: EntryResponse | None
    entry_state: Literal["active", "deleted", "purged", "unknown"]
    receipt_known: bool
    first_entry_date: date | None
    first_entry_deleted: bool | None


@router.get("/{schedule_id}/review", response_model=Envelope[ScheduleTerminalReviewResponse])
async def get_terminal_review(
    schedule_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if schedule_id.version != 7:
        raise HTTPException(status_code=422, detail="来源必须为UUID v7")
    owner = ScheduleWriteOwner(user.id)
    try:
        await lock_schedule_owner(db, owner)
        row = await locked_schedule(db, owner, schedule_id)
        if row is None:
            raise HTTPException(status_code=404, detail="预简不存在")
        entry, collision = await linked_diary(db, owner, schedule_id) if row.status == 1 else (
            None, False,
        )
        state = terminal_review_state(row, entry, collision)
        # Invalid identity must not attach another diary to this source's review.
        safe_entry = entry if state.entry_state != "unknown" else None
        result = ConversionResult(
            row if row.status in {0, 1} else None, safe_entry, state.reason,
            entry_state=state.entry_state,
        )
        snapshot = await response_snapshot(db, result)
        response = ScheduleTerminalReviewResponse(
            reviewable=state.reviewable, reason=state.reason,
            schedule=snapshot.schedule, entry=snapshot.entry, entry_state=state.entry_state,
            receipt_known=state.receipt_known, first_entry_date=state.first_entry_date,
            first_entry_deleted=state.first_entry_deleted,
        )
        await db.rollback()
        return ok(response)
    except OperationalError as error:
        await db.rollback()
        code = error.orig.args[0] if error.orig.args else None
        if code in {1205, 1213}:
            raise HTTPException(status_code=409, detail="核对事务竞争，请保留原候选重试") from error
        raise
    except Exception:
        await db.rollback()
        raise
