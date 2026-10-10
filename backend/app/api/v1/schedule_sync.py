"""P4-only push: independent per-item transactions, no P2 entities or cursors."""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.schedules import ScheduleResponse, to_response
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.services.schedules import (
    PendingScheduleRequest,
    ScheduleWriteOwner,
    server_revision,
    upsert_schedule,
)

router = APIRouter(prefix="/schedules/sync", tags=["schedules"])


class SchedulePushRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Validate items INSIDE the loop so one invalid item doesn't reject the batch.
    schedules: list[object] = Field(max_length=50)


class PendingPushItem(PendingScheduleRequest):
    id: uuid.UUID

    @field_validator("id")
    @classmethod
    def uuid_v7(cls, value: uuid.UUID) -> uuid.UUID:
        if value.version != 7:
            raise ValueError("预简来源必须为UUID v7")
        return value


class SchedulePushResult(BaseModel):
    index: int
    id: uuid.UUID | None
    status: Literal["applied", "stale", "error"]
    reason: str
    message: str
    submitted_client_updated_at: datetime | None = None
    current: ScheduleResponse | None = None


class SchedulePushResponse(BaseModel):
    server_time: datetime
    interrupted: bool = False
    schedules: list[SchedulePushResult]


def item_id(raw: object) -> uuid.UUID | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), (str, uuid.UUID)):
        return None
    try:
        return uuid.UUID(str(raw["id"]))
    except ValueError:
        return None


async def clean_transaction(db: AsyncSession) -> bool:
    try:
        await db.rollback()
        return True
    except Exception:
        # An unclean session must never be reused for a later item.
        return False


@router.post("/push")
async def push_schedules(
    body: SchedulePushRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[SchedulePushResponse]:
    # User can be ORM-backed and expire on commit/rollback. Never reread it per item.
    owner = ScheduleWriteOwner(user.id)
    results: list[SchedulePushResult] = []
    interrupted = False
    for index, raw in enumerate(body.schedules):
        result = SchedulePushResult(
            index=index, id=item_id(raw), status="error", reason="invalid",
            message="预简快照或UUID无效，未确认保存",
        )
        if interrupted:
            result.reason = "aborted"
            result.message = "本批数据库会话未恢复，未执行此项；请保留本地内容"
            results.append(result)
            continue
        try:
            item = PendingPushItem.model_validate(raw)
        except ValidationError:
            results.append(result)
            continue
        result.id = item.id
        result.submitted_client_updated_at = item.client_updated_at
        try:
            row, outcome = await upsert_schedule(db, owner, item.id, item)
            # Pin response before commit/rollback can expire database attributes.
            result.current = to_response(row) if row is not None else None
            if outcome == "applied":
                await db.commit()
                result.status = "applied"
                result.reason = "applied"
                result.message = "预简已提交服务端"
            else:
                if not await clean_transaction(db):
                    interrupted = True
                    result.current = None
                    result.reason = "storage"
                    result.message = "事务未恢复，未确认此项保存"
                elif outcome == "replayed":
                    result.status = "applied"
                    result.reason = "replayed"
                    result.message = "相同修订已在服务端，未重复写入"
                else:
                    result.reason = outcome
                    result.status = "stale" if outcome == "stale" else "error"
                    result.message = {
                        "stale": "服务端已有更新版本，请保留本地内容并明确取舍",
                        "conflict": "相同修订包含不同内容，请明确取舍",
                        "terminal": "来源已转简，pending上行不能覆盖或重置终态",
                        "not_found": "预简不存在或不可写",
                    }.get(outcome, "预简未确认保存")
        except Exception as error:
            interrupted = not await clean_transaction(db)
            args = getattr(getattr(error, "orig", None), "args", ())
            retry = isinstance(error, OperationalError) and args and args[0] in {1205, 1213}
            # Commit failure can be ambiguous: NEVER acknowledge it as applied.
            result.current = None
            result.status = "error"
            result.reason = "retry" if retry else "storage"
            result.message = "预简提交未确认，请保留本地内容后重试"
        results.append(result)
    # Timestamp is informational, not a changes cursor or a batch-wide success claim.
    return ok(SchedulePushResponse(
        server_time=server_revision(), interrupted=interrupted, schedules=results,
    ))
