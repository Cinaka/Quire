import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.entries import EntryRequest, to_response, upsert_entry
from app.core.config import settings
from app.core.security import get_current_user
from app.core.time import utcnow
from app.db.session import get_db
from app.models.diary_entry import DiaryEntry
from app.models.entry_tag import EntryTag
from app.models.media import Media
from app.models.tag import Tag
from app.models.user import User
from app.schemas.envelope import Envelope, ok

router = APIRouter(prefix="/sync", tags=["sync"])
SUFFIX_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif",
}

class SyncEntry(EntryRequest):
    id: uuid.UUID

class SyncTag(BaseModel):
    id: uuid.UUID
    name: str = Field(min_length=1, max_length=32)
    color: str | None = None
    created_at: datetime

class SyncMedia(BaseModel):
    id: uuid.UUID
    entry_id: uuid.UUID | None
    sort_order: int = 0
    width: int | None = None
    height: int | None = None
    size: int = 0
    mime: str
    created_at: datetime

class PushRequest(BaseModel):
    entries: list[SyncEntry] = Field(default_factory=list, max_length=50)
    tags: list[SyncTag] = Field(default_factory=list, max_length=50)
    media_meta: list[SyncMedia] = Field(default_factory=list, max_length=50)

async def touch_entries(db: AsyncSession, user_id: uuid.UUID, entry_ids: set[uuid.UUID]) -> None:
    if not entry_ids: return
    await db.execute(
        update(DiaryEntry)
        .where(DiaryEntry.user_id == user_id, DiaryEntry.id.in_(entry_ids))
        .values(updated_at=utcnow())
    )

def remove_media_files(row: Media) -> None:
    for public_path in (row.url, row.thumb_url or ""):
        if not public_path: continue
        relative = public_path.removeprefix(settings.MEDIA_PUBLIC_PREFIX).lstrip("/")
        path = Path(settings.MEDIA_ROOT) / relative
        if path.exists(): path.unlink()

async def push_tag(db: AsyncSession, user: User, item: SyncTag) -> dict:
    existing = await db.scalar(select(Tag).where(Tag.id == item.id, Tag.user_id == user.id))
    duplicate = await db.scalar(select(Tag).where(Tag.user_id == user.id, Tag.name == item.name))
    if duplicate is not None and duplicate.id != item.id:
        return {"id": str(item.id), "status": "error", "message": f"duplicate_tag:{duplicate.id}"}
    if existing is None:
        db.add(Tag(id=item.id, user_id=user.id, name=item.name, color=item.color))
    else:
        changed = existing.name != item.name or existing.color != item.color
        existing.name = item.name; existing.color = item.color
        if changed:
            linked_ids = set((await db.scalars(select(EntryTag.entry_id).where(EntryTag.tag_id == item.id))).all())
            await touch_entries(db, user.id, linked_ids)
    return {"id": str(item.id), "status": "applied"}

async def push_media(db: AsyncSession, user: User, item: SyncMedia) -> dict:
    existing = await db.scalar(select(Media).where(Media.id == item.id, Media.user_id == user.id))
    old_entry_id = existing.entry_id if existing is not None else None
    if item.entry_id is None:
        if existing is not None:
            remove_media_files(existing)
            await db.delete(existing)
        await touch_entries(db, user.id, {old_entry_id} if old_entry_id else set())
        return {"id": str(item.id), "status": "applied"}
    if existing is None:
        existing = Media(id=item.id, user_id=user.id, entry_id=item.entry_id, url="", thumb_url="")
        db.add(existing)
    existing.entry_id = item.entry_id
    existing.sort_order = item.sort_order
    existing.width = item.width
    existing.height = item.height
    existing.size = item.size
    await touch_entries(db, user.id, {value for value in (old_entry_id, item.entry_id) if value})
    return {"id": str(item.id), "status": "applied"}

@router.post("/push")
async def push(body: PushRequest, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> Envelope[dict]:
    entries: list[dict] = []
    tags: list[dict] = []
    media_meta: list[dict] = []
    for item in body.entries:
        entry, result = await upsert_entry(db, user, item.id, EntryRequest(**item.model_dump(exclude={"id"})))
        if result == "stale":
            entries.append({
                "id": str(item.id), "status": "stale",
                "server_client_updated_at": entry.client_updated_at.isoformat() if entry.client_updated_at else None,
            })
        else: entries.append({"id": str(item.id), "status": "applied"})
    for item in body.tags: tags.append(await push_tag(db, user, item))
    for item in body.media_meta: media_meta.append(await push_media(db, user, item))
    await db.commit()
    return ok({"server_time": utcnow(), "entries": entries, "tags": tags, "media_meta": media_meta})

@router.get("/changes")
async def changes(
    since: datetime | None = None,
    after_id: uuid.UUID | None = None,
    until: datetime | None = None,
    limit: int = Query(200, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[dict]:
    if since is not None and since.tzinfo is not None:
        since = since.astimezone(timezone.utc).replace(tzinfo=None)
    if until is not None and until.tzinfo is not None:
        until = until.astimezone(timezone.utc).replace(tzinfo=None)

    # MySQL DATETIME(3) 只保存毫秒。高水位也截断到毫秒，避免游标精度高于数据列。
    now = utcnow()
    now = now.replace(microsecond=(now.microsecond // 1000) * 1000)
    high_water = until if until is not None and until <= now else now
    query = select(DiaryEntry).where(
        DiaryEntry.user_id == user.id,
        DiaryEntry.updated_at <= high_water,
    )
    if since is not None and after_id is not None:
        query = query.where(or_(DiaryEntry.updated_at > since, and_(DiaryEntry.updated_at == since, DiaryEntry.id > after_id)))
    elif since is not None:
        # 跨轮同步重放边界毫秒，防止查询期间同毫秒落库的变更被永久跳过。
        query = query.where(DiaryEntry.updated_at >= since)
    page = list((await db.execute(query.order_by(DiaryEntry.updated_at, DiaryEntry.id).limit(limit + 1))).scalars())
    has_more = len(page) > limit
    entries = page[:limit]
    ids = [row.id for row in entries]
    tag_rows = list((await db.execute(select(EntryTag).where(EntryTag.entry_id.in_(ids)))).scalars()) if ids else []
    # 标签数量通常很小，而且 Tag 尚无独立变更游标。每轮返回完整标签目录，
    # 保证未关联到任何日记的新标签、重命名和颜色修改也能传播到其他设备。
    tags = list((await db.execute(
        select(Tag).where(Tag.user_id == user.id).order_by(Tag.created_at, Tag.id)
    )).scalars())
    media = list((await db.execute(select(Media).where(Media.user_id == user.id, Media.entry_id.in_(ids)))).scalars()) if ids else []
    tag_map: dict[uuid.UUID, list[uuid.UUID]] = {entry_id: [] for entry_id in ids}
    for row in tag_rows: tag_map.setdefault(row.entry_id, []).append(row.tag_id)
    entry_items = []
    for row in entries:
        item = to_response(row, tag_map.get(row.id, [])).model_dump(mode="json")
        item["updated_at"] = row.updated_at
        entry_items.append(item)
    last = entries[-1] if entries else None
    cursor_time = last.updated_at if has_more and last is not None else high_water
    cursor_id = str(last.id) if has_more and last is not None else None
    return ok({
        "server_time": cursor_time, "sync_until": high_water,
        "cursor_id": cursor_id, "has_more": has_more,
        "entries": entry_items,
        "tags": [{"id": row.id, "name": row.name, "color": row.color, "created_at": row.created_at} for row in tags],
        "media_meta": [{
            "id": row.id, "entry_id": row.entry_id, "sort_order": row.sort_order,
            "width": row.width, "height": row.height, "size": row.size,
            "mime": SUFFIX_MIME.get(Path(row.url).suffix.lower(), "application/octet-stream"),
            "url": row.url, "thumb_url": row.thumb_url or "", "created_at": row.created_at,
        } for row in media],
    })
