"""P4 source-scoped authenticated image bytes; rollback only, never a conversion ACK."""

import base64
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.media import Media
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.schemas.uuid_hex import UUIDHex
from app.services.schedule_conversion import linked_diary
from app.services.schedule_resource_review import (
    MAX_IMAGE_BYTES,
    current_resource_ids,
    read_expected_image,
    stored_relative_path,
)
from app.services.schedule_review import terminal_review_state
from app.services.schedules import ScheduleWriteOwner, lock_schedule_owner, locked_schedule

router = APIRouter(prefix="/schedules", tags=["schedules"])
ImageVariant = Literal["original", "thumbnail"]
ImageMime = Literal["image/png", "image/jpeg", "image/webp", "image/gif"]
PRIVATE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


class ScheduleResourceImageResponse(BaseModel):
    read_only: Literal[True] = True
    resolution_enabled: Literal[False] = False
    proof_scope: Literal["current_entry_image_bytes"] = "current_entry_image_bytes"
    schedule_id: UUIDHex
    media_id: UUIDHex
    variant: ImageVariant
    size: int
    mime: ImageMime
    sha256: str
    data_base64: str


def unavailable(status, detail):
    return HTTPException(status_code=status, detail=detail, headers=PRIVATE_HEADERS)


@router.get(
    "/{schedule_id}/review/resources/{media_id}/{variant}",
    response_model=Envelope[ScheduleResourceImageResponse],
)
async def download_current_resource_image(
    schedule_id: UUIDHex,
    media_id: UUIDHex,
    variant: ImageVariant,
    response: Response,
    expected_size: int = Query(ge=1, le=MAX_IMAGE_BYTES),
    expected_mime: ImageMime = Query(),
    expected_sha256: str = Query(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if schedule_id.version != 7 or media_id.version != 7:
        raise unavailable(422, "来源和媒体必须为UUID v7")
    owner = ScheduleWriteOwner(user.id)
    try:
        await lock_schedule_owner(db, owner)
        source = await locked_schedule(db, owner, schedule_id)
        if source is None:
            raise unavailable(404, "预简不存在")
        entry, collision = await linked_diary(db, owner, schedule_id) if source.status == 1 else (
            None, False,
        )
        state = terminal_review_state(source, entry, collision)
        if not state.reviewable or not state.receipt_known or entry is None:
            raise unavailable(409, "当前终态身份尚不能读取图片，请保留保护并重新核对")
        try:
            media_ids, _ = current_resource_ids(entry.content, [])
        except (ValueError, TypeError, AttributeError) as error:
            raise unavailable(409, "当前正文无法核对图片引用") from error
        if media_id not in media_ids:
            raise unavailable(404, "当前日记没有该图片")
        media = await db.scalar(select(Media).where(
            Media.id == media_id, Media.user_id == owner.id, Media.entry_id == schedule_id,
        ).with_for_update())
        if media is None:
            raise unavailable(404, "当前日记图片不存在")
        thumbnail = variant == "thumbnail"
        stored_url = media.thumb_url if thumbnail else media.url
        if thumbnail and not stored_url:
            raise unavailable(404, "当前图片没有缩略图")
        target = stored_relative_path(
            stored_url, settings.MEDIA_PUBLIC_PREFIX, media_id, thumbnail=thumbnail,
        )
        if target is None:
            raise unavailable(409, "当前图片存储不可验证")
        relative, mime = target
        if mime != expected_mime or (not thumbnail and media.size != expected_size):
            raise unavailable(409, "图片证明已变化，请重新核对")
        result = await run_in_threadpool(
            read_expected_image, settings.MEDIA_ROOT, relative, mime,
            expected_size, expected_sha256,
        )
        if result.proof.state == "missing":
            raise unavailable(404, "图片文件不存在")
        if result.proof.state != "verified" or result.data is None:
            raise unavailable(409, "图片证明已变化或无法验证，请重新核对")
        payload = ScheduleResourceImageResponse(
            schedule_id=schedule_id, media_id=media_id, variant=variant,
            size=len(result.data), mime=mime, sha256=result.proof.sha256,
            data_base64=base64.b64encode(result.data).decode("ascii"),
        )
        await db.rollback()
        response.headers.update(PRIVATE_HEADERS)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return ok(payload)
    except OperationalError as error:
        await db.rollback()
        code = error.orig.args[0] if error.orig.args else None
        if code in {1205, 1213}:
            raise unavailable(409, "图片读取事务竞争，请保留保护重新核对") from error
        raise
    except Exception:
        await db.rollback()
        raise
