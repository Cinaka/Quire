import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.media_publish import discard_created, publish_media, stored_file_size
from app.core.media_storage import media_disk_paths, remove_media_paths
from app.core.request_limits import attempt_limiter
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.media import Media
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.services.schedule_resource_review import (
    probe_image,
    read_expected_image,
    stored_relative_path,
)

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
    created_at: datetime


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
        created_at=row.created_at,
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
    attempt_limiter.consume("upload-user", str(user.id), settings.UPLOAD_USER_PER_MINUTE, 60)
    created: list[tuple[Path, int, int]] = []
    commit_started = False
    try:
        # Serialize account allocations on a real row (no absent-row locking assumption).
        # Only uploads allocate bytes; sync metadata is never used to account for bytes.
        owner = (await db.execute(select(User.id).where(User.id == user.id)
                                  .with_for_update())).scalar_one_or_none()
        if owner is None:
            raise HTTPException(401, "登录已失效")
        existing = await db.scalar(select(Media).where(Media.id == media_id)
                                   .with_for_update().execution_options(populate_existing=True))
        if existing is not None and existing.user_id != user.id:
            raise HTTPException(404, "图片不存在")
        if existing is not None and existing.url and stored_media_files_exist(existing):
            # is_file alone follows symlinks; do not call an unsafe old row complete.
            for value, is_thumb in ((existing.url, False), (existing.thumb_url or "", True)):
                if not value:
                    continue
                mapped = stored_relative_path(value, settings.MEDIA_PUBLIC_PREFIX, media_id,
                                              thumbnail=is_thumb)
                if mapped is None:
                    raise HTTPException(409, "已有图片路径无法核对，已停止上传")
                relative, _ = mapped
                if stored_file_size(settings.MEDIA_ROOT, relative.parts[0], relative.name) <= 0:
                    raise HTTPException(409, "已有图片状态无法核对，已停止上传")
            result = to_response(existing)
            await db.rollback()
            return ok(result)

        data = await file.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise HTTPException(413, "图片不能超过 10 MB")
        mime = validate_image_bytes(data, file.content_type)
        files = {f"{media_id}{MIME_SUFFIX[mime]}": data}
        thumb_url = existing.thumb_url or "" if existing else ""
        if thumb is not None:
            thumb_data = await thumb.read(MAX_BYTES + 1)
            if len(thumb_data) > MAX_BYTES:
                raise HTTPException(413, "缩略图不能超过 10 MB")
            thumb_mime = validate_image_bytes(thumb_data, thumb.content_type)
            files[f"{media_id}_thumb{MIME_SUFFIX[thumb_mime]}"] = thumb_data
            thumb_url = (f"{settings.MEDIA_PUBLIC_PREFIX}/{media_id.hex[:4]}"
                         f"/{media_id}_thumb{MIME_SUFFIX[thumb_mime]}")

        url = f"{settings.MEDIA_PUBLIC_PREFIX}/{media_id.hex[:4]}/{media_id}{MIME_SUFFIX[mime]}"
        if existing and existing.url and existing.url != url:
            raise HTTPException(409, "图片格式与已有记录不一致，未覆盖")
        if existing and existing.thumb_url and thumb_url != existing.thumb_url:
            raise HTTPException(409, "缩略图格式与已有记录不一致，未覆盖")
        # A bounded current read; count actual original + thumbnail bytes, never client size.
        rows = list((await db.execute(select(Media).where(Media.user_id == user.id)
                     .limit(settings.MEDIA_USER_MAX_COUNT + 1).with_for_update()
                     .execution_options(populate_existing=True))).scalars())
        if len(rows) > settings.MEDIA_USER_MAX_COUNT or (
            existing is None and len(rows) >= settings.MEDIA_USER_MAX_COUNT
        ):
            raise HTTPException(413, "账号图片数量已达上限；本机图片仍保留，未上传")
        used = 0
        for row in rows:
            for value, is_thumb in ((row.url, False), (row.thumb_url or "", True)):
                if not value:
                    continue
                mapped = stored_relative_path(value, settings.MEDIA_PUBLIC_PREFIX, row.id,
                                              thumbnail=is_thumb)
                if mapped is None:
                    raise HTTPException(409, "已有图片路径无法核对，已停止上传")
                relative, _ = mapped
                used += stored_file_size(settings.MEDIA_ROOT, relative.parts[0], relative.name)
        added = 0
        for name, data_bytes in files.items():
            size = stored_file_size(settings.MEDIA_ROOT, media_id.hex[:4], name)
            added += 0 if size else len(data_bytes)
        if used + added > settings.MEDIA_USER_MAX_BYTES:
            raise HTTPException(413, "账号图片容量已达上限；本机图片仍保留，未上传")

        created = publish_media(settings.MEDIA_ROOT, media_id.hex[:4], files,
                                allow_existing=existing is not None,
                                reserve_bytes=settings.MEDIA_DISK_RESERVE_BYTES)
        row = existing or Media(id=media_id, user_id=user.id, url=url)
        if existing is None:
            db.add(row)
        row.entry_id = entry_id
        row.sort_order = sort_order
        row.width, row.height = width, height
        row.size, row.url, row.thumb_url = len(data), url, thumb_url
        # Constraint failure is known before COMMIT; cleanup only our exclusive inodes.
        await db.flush()
        commit_started = True
        await db.commit()
        await db.refresh(row)
        return ok(to_response(row))
    except BaseException as exc:
        try:
            await db.rollback()
        finally:
            # A lost COMMIT acknowledgement may mean the row committed. Never delete
            # potentially referenced files; retain for explicit reconciliation on retry.
            if not commit_started:
                discard_created(created)
        if isinstance(exc, IntegrityError):
            raise HTTPException(409, "图片上传发生冲突，未覆盖已有图片，请重试核对") from exc
        if isinstance(exc, OperationalError) and not commit_started:
            raise HTTPException(503, "图片存储事务暂不可用，请稍后重试核对",
                                headers={"Retry-After": "1"}) from exc
        if isinstance(exc, FileExistsError):
            raise HTTPException(409, "已有图片字节不允许覆盖，请重试核对") from exc
        if isinstance(exc, OSError):
            raise HTTPException(503, "图片存储暂不可用或空间不足；本机图片仍保留") from exc
        if commit_started and isinstance(exc, Exception):
            raise HTTPException(503, "图片提交结果未确认，请重试核对；本机图片仍保留") from exc
        raise


@router.get("/{media_id}/{variant}")
async def private_media(
    media_id: uuid.UUID,
    variant: Literal["original", "thumbnail"],
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    attempt_limiter.consume(
        "media-read-user", str(user.id), settings.MEDIA_READ_USER_PER_MINUTE, 60,
    )
    row = await db.scalar(select(Media).where(Media.id == media_id, Media.user_id == user.id))
    if row is None:
        raise HTTPException(404, "图片不存在")
    thumbnail = variant == "thumbnail"
    url = row.thumb_url if thumbnail else row.url
    mapped = stored_relative_path(url, settings.MEDIA_PUBLIC_PREFIX, media_id, thumbnail=thumbnail)
    if mapped is None:
        raise HTTPException(404, "图片不存在")
    relative, mime = mapped
    proof = probe_image(settings.MEDIA_ROOT, relative, mime, MAX_BYTES)
    if proof.state != "verified":
        raise HTTPException(404, "图片不存在或暂不可读")
    result = read_expected_image(settings.MEDIA_ROOT, relative, mime, proof.size, proof.sha256)
    if result.data is None or result.proof.state != "verified":
        raise HTTPException(409, "图片已变化，请重试")
    return Response(result.data, media_type=mime, headers={
        "Cache-Control": "private, no-store", "Vary": "Authorization",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; sandbox",
    })


@router.get("")
async def list_media(
    entry_id: uuid.UUID | None = None,
    since: datetime | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[list[MediaResponse]]:
    if since is not None and since.tzinfo is not None:
        since = since.astimezone(timezone.utc).replace(tzinfo=None)
    query = select(Media).where(Media.user_id == user.id)
    if entry_id:
        query = query.where(Media.entry_id == entry_id)
    if since:
        query = query.where(Media.created_at > since)
    rows = list((await db.execute(query.order_by(Media.created_at, Media.id))).scalars())
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
