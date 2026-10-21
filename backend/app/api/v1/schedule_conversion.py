"""Private P4 conversion namespace; front-end queue consumption remains disabled."""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.entries import EntryResponse
from app.api.v1.entries import to_response as entry_response
from app.api.v1.schedules import ScheduleResponse, to_response
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.entry_tag import EntryTag
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.services.schedule_conversion import (
    ConversionResult,
    ScheduleConvertRequest,
    convert_schedule,
    reread_conversion,
)
from app.services.schedule_receipts import valid_receipt
from app.services.schedules import ScheduleWriteOwner, is_duplicate

router = APIRouter(prefix="/schedules", tags=["schedules"])
MESSAGES = {
    "identity_conflict": "转换日记身份或来源关系冲突，未覆盖既有日记",
    "invalid_state": "预简转换状态异常，请保留本地内容核对",
    "source_deleted": "来源预简已删除，未执行转换",
    "source_revision": "来源修订已变化，未执行旧快照转换",
    "conversion_revision": "转换修订不得早于来源修订",
    "source_content": "来源正文不兼容或为空，未降级转换",
    "source_snapshot": "首次日记快照与选定来源内容不一致",
    "receipt_unknown": "来源已转简，但缺少可核验首次回执，请保留本地意图",
    "intent_conflict": "来源已由另一首次意图转换，请保留候选并明确取舍",
}


class ScheduleConvertResponse(BaseModel):
    schedule: ScheduleResponse | None
    entry: EntryResponse | None
    entry_state: str
    created: bool
    confirmed: bool
    reason: str
    first_entry_date: date | None = None
    first_entry_deleted: bool | None = None


async def response_snapshot(db: AsyncSession, result: ConversionResult) -> ScheduleConvertResponse:
    entry = None
    if result.entry is not None:
        # Match the already locked current diary, not the older auth read view.
        tags = list((await db.execute(
            select(EntryTag.tag_id).where(EntryTag.entry_id == result.entry.id)
            .order_by(EntryTag.tag_id).with_for_update()
        )).scalars())
        entry = entry_response(result.entry, tags)
    receipt = result.schedule.converted_receipt if result.schedule is not None else None
    known = valid_receipt(receipt)
    return ScheduleConvertResponse(
        schedule=to_response(result.schedule) if result.schedule is not None else None,
        entry=entry,
        entry_state=result.entry_state, created=result.created, confirmed=result.confirmed,
        reason=result.reason,
        first_entry_date=receipt["entry_date"] if known else None,
        first_entry_deleted=receipt["deleted"] if known else None,
    )


@router.post("/{schedule_id}/convert", response_model=Envelope[ScheduleConvertResponse])
async def post_convert(
    schedule_id: uuid.UUID,
    body: ScheduleConvertRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if (schedule_id.version != 7 or body.entry.id != schedule_id
            or body.entry.from_schedule_id != schedule_id):
        raise HTTPException(status_code=422, detail="转换日记ID及来源必须等于路径UUID v7")
    owner = ScheduleWriteOwner(user.id)
    try:
        try:
            result = await convert_schedule(db, owner, schedule_id, body)
        except IntegrityError as error:
            await db.rollback()
            if not is_duplicate(error):
                raise
            # Read a possible winning terminal transaction once; don't create another candidate.
            result = await reread_conversion(db, owner, schedule_id, body)
        if result.reason == "not_found":
            raise HTTPException(status_code=404, detail="预简不存在")
        snapshot = await response_snapshot(db, result)
        if not result.confirmed:
            await db.rollback()
            return JSONResponse(status_code=409, content=jsonable_encoder({
                "code": 409, "message": MESSAGES.get(result.reason, "转换未确认"), "data": snapshot,
            }))
        if result.created:
            await db.commit()
        else:
            await db.rollback()
        return ok(snapshot)
    except OperationalError as error:
        await db.rollback()
        code = error.orig.args[0] if error.orig.args else None
        if code in {1205, 1213}:
            raise HTTPException(status_code=409, detail="转换事务竞争，请保留意图后重试") from error
        raise
    except Exception:
        await db.rollback()
        raise
