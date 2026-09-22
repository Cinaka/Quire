import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.media_storage import media_disk_paths, remove_media_paths
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.media import Media
from app.models.user import User
from app.schemas.envelope import Envelope, ok

router = APIRouter(prefix="/media", tags=["media"])
ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MIME_SUFFIX = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
SUFFIX_MIME = {value: key for key, value in MIME_SUFFIX.items()}
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


def detect_image_mime(data: bytes) -> str | None:
    """按文件头识别允许的图片格式，不信任客户端声明的 Content-Type。"""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_image_bytes(data: bytes, claimed_mime: str | None) -> str:
    if not data:
        raise HTTPException(status_code=422, detail="图片文件不能为空")
    if claimed_mime not in ALLOWED_MIME:
        raise HTTPException(status_code=422, detail="不支持的图片格式")
    detected = detect_image_mime(data)
    if detected is None:
        raise HTTPException(status_code=422, detail="文件内容不是受支持的图片")
    if detected != claimed_mime:
        raise HTTPException(status_code=422, detail="图片格式与文件内容不一致")
    return detected


def stored_media_files_exist(row: Media) -> bool:
    public_paths = [row.url]
    if row.thumb_url:
        public_paths.append(row.thumb_url)
    paths = media_disk_paths(*public_paths)
    return len(paths) == len(public_paths) and all(path.is_file() for path in paths)


def to_response(row: Media) -> MediaResponse:
    return MediaResponse(
        id=row.id,
        entry_id=row.entry_id,
        sort_order=row.sort_order,
        width=row.width,
        height=row.height,
        size=row.size,
        mime=SUFFIX_MIME.get(Path(row.url).suffix.lower(), "application/octet-stream"),
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
    existing = await db.scalar(
        select(Media).where(Media.id == media_id, Media.user_id == user.id)
    )
    if existing is not None and existing.url and stored_media_files_exist(existing):
        return ok(to_response(existing))

    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="图片不能超过 10 MB")
    mime = validate_image_bytes(data, file.content_type)

    thumb_data: bytes | None = None
    thumb_mime: str | None = None
    if thumb is not None:
        thumb_data = await thumb.read(MAX_BYTES + 1)
        if len(thumb_data) > MAX_BYTES:
            raise HTTPException(status_code=413, detail="缩略图不能超过 10 MB")
        thumb_mime = validate_image_bytes(thumb_data, thumb.content_type)

    old_paths = media_disk_paths(existing.url, existing.thumb_url or "") if existing else []
    relative_dir = Path(media_id.hex[:4])
    disk_dir = Path(settings.MEDIA_ROOT) / relative_dir
    disk_dir.mkdir(parents=True, exist_ok=True)

    suffix = MIME_SUFFIX[mime]
    original_path = disk_dir / f"{media_id}{suffix}"
    url = f"{settings.MEDIA_PUBLIC_PREFIX}/{relative_dir.as_posix()}/{media_id}{suffix}"
    written_paths = [original_path]
    created_paths = [original_path] if not original_path.exists() else []
    committed = False
    try:
        original_path.write_bytes(data)

        thumb_url = ""
        if thumb_data is not None and thumb_mime is not None:
            thumb_suffix = MIME_SUFFIX[thumb_mime]
            thumb_path = disk_dir / f"{media_id}_thumb{thumb_suffix}"
            written_paths.append(thumb_path)
            if not thumb_path.exists():
                created_paths.append(thumb_path)
            thumb_path.write_bytes(thumb_data)
            thumb_url = (
                f"{settings.MEDIA_PUBLIC_PREFIX}/{relative_dir.as_posix()}"
                f"/{media_id}_thumb{thumb_suffix}"
            )

        row = existing or Media(id=media_id, user_id=user.id, url=url)
        if existing is None:
            db.add(row)
        row.entry_id = entry_id
        row.sort_order = sort_order
        row.width = width
        row.height = height
        row.size = len(data)
        row.url = url
        row.thumb_url = thumb_url
        await db.commit()
        committed = True
    finally:
        if not committed:
            remove_media_paths(created_paths)

    remove_media_paths([path for path in old_paths if path not in written_paths])
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
    row = await db.scalar(
        select(Media).where(Media.id == media_id, Media.user_id == user.id)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    paths = media_disk_paths(row.url, row.thumb_url or "")
    await db.delete(row)
    await db.commit()
    remove_media_paths(paths)
    return ok(None)
