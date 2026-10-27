"""P4 coherent current resource read; rollback only, no URL/owner/first-intent proof."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.v1.schedule_conversion import response_snapshot
from app.api.v1.schedule_review import ScheduleTerminalReviewResponse
from app.core.config import settings
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.media import Media
from app.models.tag import Tag
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.schemas.uuid_hex import UUIDHex
from app.services.schedule_conversion import ConversionResult, linked_diary
from app.services.schedule_resource_review import (
    MAX_PROOF_BYTES,
    ImageProof,
    current_resource_ids,
    probe_image,
    stored_relative_path,
)
from app.services.schedule_review import terminal_review_state
from app.services.schedules import ScheduleWriteOwner, lock_schedule_owner, locked_schedule

router = APIRouter(prefix="/schedules", tags=["schedules"])


class ResourceImageProof(BaseModel):
    state: Literal["verified", "missing", "unavailable", "not_present"]
    size: int | None
    sha256: str | None
    mime: str | None


class ResourceMediaProof(BaseModel):
    id: UUIDHex
    entry_id: UUIDHex
    sort_order: int
    width: int | None
    height: int | None
    size: int | None
    created_at: datetime
    original: ResourceImageProof
    thumbnail: ResourceImageProof


class ResourceTagProof(BaseModel):
    id: UUIDHex
    name: str
    color: str | None
    created_at: datetime


class ScheduleResourceReviewResponse(BaseModel):
    read_only: Literal[True] = True
    resolution_enabled: Literal[False] = False
    proof_scope: Literal["current_entry_resources"] = "current_entry_resources"
    resource_state: Literal["verified", "incomplete", "unsupported", "no_entry"]
    resources_complete: bool = False
    review: ScheduleTerminalReviewResponse
    media_ids: list[UUIDHex]
    tag_ids: list[UUIDHex]
    media: list[ResourceMediaProof]
    tags: list[ResourceTagProof]
    missing_media_ids: list[UUIDHex]
    missing_tag_ids: list[UUIDHex]


async def image_proof(row, *, thumbnail, remaining):
    url = row.thumb_url if thumbnail else row.url
    if thumbnail and not url:
        return ImageProof("not_present")
    target = stored_relative_path(url, settings.MEDIA_PUBLIC_PREFIX, row.id, thumbnail=thumbnail)
    if target is None:
        return ImageProof("unavailable")
    relative, mime = target
    return await run_in_threadpool(probe_image, settings.MEDIA_ROOT, relative, mime, remaining)


async def locked_resource_review(db, owner, schedule_id):
    """Build the current proof under the caller's owner barrier; never commit/rollback."""
    row = await locked_schedule(db, owner, schedule_id)
    if row is None:
        raise HTTPException(status_code=404, detail="预简不存在")
    entry, collision = await linked_diary(db, owner, schedule_id) if row.status == 1 else (
        None, False,
    )
    state = terminal_review_state(row, entry, collision)
    safe_entry = entry if state.entry_state != "unknown" else None
    snapshot = await response_snapshot(db, ConversionResult(
        row if row.status in {0, 1} else None, safe_entry, state.reason,
        entry_state=state.entry_state,
    ))
    review = ScheduleTerminalReviewResponse(
        reviewable=state.reviewable, reason=state.reason,
        schedule=snapshot.schedule, entry=snapshot.entry, entry_state=state.entry_state,
        receipt_known=state.receipt_known, first_entry_date=state.first_entry_date,
        first_entry_deleted=state.first_entry_deleted,
    )
    response = ScheduleResourceReviewResponse(
        resource_state="no_entry", review=review, media_ids=[], tag_ids=[],
        media=[], tags=[], missing_media_ids=[], missing_tag_ids=[],
    )
    if snapshot.entry is not None:
        try:
            media_ids, tag_ids = current_resource_ids(
                snapshot.entry.content, snapshot.entry.tag_ids,
            )
        except (ValueError, TypeError, AttributeError):
            response.resource_state = "unsupported"
        else:
            response.media_ids, response.tag_ids = media_ids, tag_ids
            media_rows = list((await db.execute(select(Media).where(
                Media.id.in_(media_ids), Media.user_id == owner.id,
                Media.entry_id == schedule_id,
            ).order_by(Media.id).with_for_update())).scalars()) if media_ids else []
            tag_rows = list((await db.execute(select(Tag).where(
                Tag.id.in_(tag_ids), Tag.user_id == owner.id,
            ).order_by(Tag.id).with_for_update())).scalars()) if tag_ids else []
            response.missing_media_ids = sorted(set(media_ids) - {m.id for m in media_rows})
            response.missing_tag_ids = sorted(set(tag_ids) - {t.id for t in tag_rows})
            remaining = MAX_PROOF_BYTES
            for media in media_rows:
                original = await image_proof(media, thumbnail=False, remaining=remaining)
                remaining -= original.read_bytes
                if original.state == "verified" and original.size != media.size:
                    original = ImageProof("unavailable")
                thumb = await image_proof(media, thumbnail=True, remaining=remaining)
                remaining -= thumb.read_bytes
                response.media.append(ResourceMediaProof(
                    id=media.id, entry_id=schedule_id, sort_order=media.sort_order,
                    width=media.width, height=media.height, size=media.size,
                    created_at=media.created_at,
                    original=ResourceImageProof(
                        state=original.state, size=original.size,
                        sha256=original.sha256, mime=original.mime,
                    ),
                    thumbnail=ResourceImageProof(
                        state=thumb.state, size=thumb.size,
                        sha256=thumb.sha256, mime=thumb.mime,
                    ),
                ))
            response.tags = [ResourceTagProof(
                id=t.id, name=t.name, color=t.color, created_at=t.created_at,
            ) for t in tag_rows]
            response.resources_complete = (
                not response.missing_media_ids and not response.missing_tag_ids
                and all(m.original.state == "verified" and m.thumbnail.state in {
                    "verified", "not_present",
                } for m in response.media)
            )
            response.resource_state = (
                "verified" if response.resources_complete else "incomplete"
            )
    return response


@router.get(
    "/{schedule_id}/review/resources",
    response_model=Envelope[ScheduleResourceReviewResponse],
)
async def get_resource_review(
    schedule_id: UUIDHex,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if schedule_id.version != 7:
        raise HTTPException(status_code=422, detail="来源必须为UUID v7")
    owner = ScheduleWriteOwner(user.id)
    try:
        await lock_schedule_owner(db, owner)
        response = await locked_resource_review(db, owner, schedule_id)
        await db.rollback()
        return ok(response)
    except OperationalError as error:
        await db.rollback()
        code = error.orig.args[0] if error.orig.args else None
        if code in {1205, 1213}:
            raise HTTPException(status_code=409, detail="资源核对事务竞争，请保留候选") from error
        raise
    except Exception:
        await db.rollback()
        raise
