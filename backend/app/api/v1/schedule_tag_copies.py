"""Explicit P4 tag presence confirmation; no diary/source/receipt/reference mutation."""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.schedule_resource_review import locked_resource_review
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.services.schedule_tag_copies import IndependentTagCopiesRequest, create_independent_tags
from app.services.schedules import ScheduleWriteOwner, is_duplicate, lock_schedule_owner

router = APIRouter(prefix="/schedules", tags=["schedules"])
PRIVATE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


class IndependentTagPresence(BaseModel):
    from_tag_id: uuid.UUID
    id: uuid.UUID
    name: str
    color: str | None
    created_at: datetime
    created: bool


class IndependentTagCopiesResponse(BaseModel):
    proof_scope: Literal["independent_tag_presence"] = "independent_tag_presence"
    tags_confirmed: Literal[True] = True
    resolution_enabled: Literal[False] = False
    diary_sync_enabled: Literal[False] = False
    schedule_id: uuid.UUID
    plan_id: uuid.UUID
    tags: list[IndependentTagPresence]


@router.post(
    "/{schedule_id}/independent-tags",
    response_model=Envelope[IndependentTagCopiesResponse],
)
async def publish_independent_tags(
    schedule_id: uuid.UUID,
    body: IndependentTagCopiesRequest,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    response.headers.update(PRIVATE_HEADERS)
    if schedule_id.version != 7:
        raise HTTPException(status_code=422, detail="来源必须为UUID v7", headers=PRIVATE_HEADERS)
    owner = ScheduleWriteOwner(user.id)
    try:
        await lock_schedule_owner(db, owner)
        proof = await locked_resource_review(db, owner, schedule_id)
        tags, created = await create_independent_tags(db, owner, schedule_id, body, proof)
        result = IndependentTagCopiesResponse(
            schedule_id=schedule_id, plan_id=body.plan_id, tags=tags,
        )
        # Construct the response before commit. No success is returned after a failed commit.
        if created:
            await db.commit()
        else:
            await db.rollback()
        return ok(result)
    except IntegrityError as error:
        await db.rollback()
        if is_duplicate(error):
            raise HTTPException(
                status_code=409, detail="名称或身份发生竞争，保留原准备重新核对",
                headers=PRIVATE_HEADERS,
            ) from error
        raise
    except OperationalError as error:
        await db.rollback()
        if getattr(error.orig, "args", ()) and error.orig.args[0] in {1205, 1213}:
            raise HTTPException(
                status_code=409, detail="独立标签事务竞争，保留准备重试", headers=PRIVATE_HEADERS,
            ) from error
        raise
    except HTTPException as error:
        await db.rollback()
        error.headers = {**(error.headers or {}), **PRIVATE_HEADERS}
        raise
    except Exception:
        await db.rollback()
        raise


@router.post(
    "/{schedule_id}/independent-tags/review",
    response_model=Envelope[IndependentTagCopiesResponse],
)
async def review_independent_tags(
    schedule_id: uuid.UUID,
    body: IndependentTagCopiesRequest,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Read-only current presence. Never recreate missing tags or acknowledge diary references."""
    response.headers.update(PRIVATE_HEADERS)
    if schedule_id.version != 7:
        raise HTTPException(status_code=422, detail="来源必须为UUID v7", headers=PRIVATE_HEADERS)
    owner = ScheduleWriteOwner(user.id)
    try:
        await lock_schedule_owner(db, owner)
        proof = await locked_resource_review(db, owner, schedule_id)
        tags, created = await create_independent_tags(
            db, owner, schedule_id, body, proof, require_existing=True,
        )
        if created:
            raise HTTPException(status_code=409, detail="只读复核不能创建标签")
        result = IndependentTagCopiesResponse(
            schedule_id=schedule_id, plan_id=body.plan_id, tags=tags,
        )
        return ok(result)
    except HTTPException as error:
        error.headers = {**(error.headers or {}), **PRIVATE_HEADERS}
        raise
    finally:
        await db.rollback()
