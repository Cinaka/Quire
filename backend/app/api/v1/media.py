import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.media import Media
from app.models.user import User
from app.schemas.envelope import Envelope, ok

router = APIRouter(prefix="/media", tags=["media"])
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_BYTES = 10 * 1024 * 1024


class MediaResponse(BaseModel):
    id: uuid.UUID
    entry_id: uuid.UUID | None
    sort_order: int
    width: int | None
    height: int | None
    size: int | None
    mime: str
    url: str
    thumb_url: str


def to_response(row: Media) -> MediaResponse:
    return MediaResponse(
        id=row.id,
        entry_id=row.entry_id,
        sort_order=row.sort_order,
        width=row.width,
        height=row.height,
        size=row.size,
        mime=Path(row.url).suffix.lstrip(".") or "application/octet-stream",
        url=row.url,
        thumb_url=row.thumb_url or "",
    )


@router.post("/{media_id}")
async def upload_media(
    media_id: uuid.UUID,
    file: UploadFile = File(...),
    thumb: UploadFile | None = File(default=None),
    entry_id: uuid.UUID | None = Form(default=None),
    sort_order: int = Form(default=0),
    width: int | None = Form(default=None),
    height: int | None = Form(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[MediaResponse]:
    if file.content_type not in ALLOWED_MIME:
        raise HTTPException(status_code=422, detail="不支持的图片格式")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="图片不能超过 10 MB")
    suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}[file.content_type]
    relative_dir = Path(settings.MEDIA_PUBLIC_PREFIX.lstrip("/")) / f"{media_id.hex[:4]}"
    disk_dir = Path(settings.MEDIA_ROOT) / relative_dir
    disk_dir.mkdir(parents=True, exist_ok=True)
    disk_path = disk_dir / f"{media_id}{suffix}"
    disk_path.write_bytes(data)
    thumb_url = ""
    if thumb is not None:
        thumb_data = await thumb.read(MAX_BYTES + 1)
        if len(thumb_data) <= MAX_BYTES:
            thumb_path = disk_dir / f"{media_id}_thumb{suffix}"
            thumb_path.write_bytes(thumb_data)
            thumb_url = f"/{relative_dir.as_posix()}/{media_id}_thumb{suffix}"
    url = f"/{relative_dir.as_posix()}/{media_id}{suffix}"
    row = await db.scalar(select(Media).where(Media.id == media_id, Media.user_id == user.id))
    if row is None:
        row = Media(id=media_id, user_id=user.id, url=url)
        db.add(row)
    row.entry_id = entry_id
    row.sort_order = sort_order
    row.width = width
    row.height = height
    row.size = len(data)
    row.url = url
    row.thumb_url = thumb_url
    await db.commit()
    await db.refresh(row)
    return ok(to_response(row))


@router.get("")
async def list_media(
    entry_id: uuid.UUID | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[list[MediaResponse]]:
    query = select(Media).where(Media.user_id == user.id)
    if entry_id:
        query = query.where(Media.entry_id == entry_id)
    rows = list((await db.execute(query.order_by(Media.created_at))).scalars())
    return ok([to_response(row) for row in rows])


@router.delete("/{media_id}")
async def delete_media(
    media_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[None]:
    row = await db.scalar(select(Media).where(Media.id == media_id, Media.user_id == user.id))
    if row is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    for path in (Path(settings.MEDIA_ROOT) / row.url.lstrip("/"), Path(settings.MEDIA_ROOT) / (row.thumb_url or "").lstrip("/")):
        if path.exists():
            path.unlink()
    await db.delete(row)
    await db.commit()
    return ok(None)
