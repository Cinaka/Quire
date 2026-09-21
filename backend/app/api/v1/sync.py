import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.entries import EntryRequest, to_response, upsert_entry
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


async def push_tag(db: AsyncSession, user: User, item: SyncTag) -> dict:
    existing = await db.scalar(select(Tag).where(Tag.id == item.id, Tag.user_id == user.id))
    duplicate = await db.scalar(select(Tag).where(Tag.user_id == user.id, Tag.name == item.name))
    if duplicate is not None and duplicate.id != item.id:
        return {"id": str(item.id), "status": "error", "message": f"duplicate_tag:{duplicate.id}"}
    if existing is None:
        existing = Tag(id=item.id, user_id=user.id, name=item.name, color=item.color)
        db.add(existing)
    else:
        existing.name = item.name
        existing.color = item.color
    return {"id": str(item.id), "status": "applied"}


async def push_media(db: AsyncSession, user: User, item: SyncMedia) -> dict:
    existing = await db.scalar(select(Media).where(Media.id == item.id, Media.user_id == user.id))
    if existing is None:
        existing = Media(id=item.id, user_id=user.id, entry_id=item.entry_id, url="", thumb_url="")
        db.add(existing)
    existing.entry_id = item.entry_id
    existing.sort_order = item.sort_order
    existing.width = item.width
    existing.height = item.height
    existing.size = item.size
    return {"id": str(item.id), "status": "applied"}


@router.post("/push")
async def push(
    body: PushRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[dict]:
    entries: list[dict] = []
    tags: list[dict] = []
    media_meta: list[dict] = []
    for item in body.entries:
        entry_body = EntryRequest(**item.model_dump(exclude={"id"}))
        entry, result = await upsert_entry(db, user, item.id, entry_body)
        if result == "stale":
            entries.append({"id": str(item.id), "status": "stale", "server_client_updated_at": entry.client_updated_at.isoformat() if entry.client_updated_at else None})
        else:
            entries.append({"id": str(item.id), "status": "applied"})
    for item in body.tags:
        tags.append(await push_tag(db, user, item))
    for item in body.media_meta:
        media_meta.append(await push_media(db, user, item))
    await db.commit()
    return ok({"server_time": utcnow(), "entries": entries, "tags": tags, "media_meta": media_meta})


@router.get("/changes")
async def changes(
    since: datetime | None = None,
    limit: int = Query(200, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[dict]:
    entry_query = select(DiaryEntry).where(DiaryEntry.user_id == user.id)
    if since:
        entry_query = entry_query.where(DiaryEntry.updated_at > since)
    entries = list((await db.execute(entry_query.order_by(DiaryEntry.updated_at).limit(limit))).scalars())
    ids = [row.id for row in entries]
    tag_rows = list((await db.execute(select(EntryTag).where(EntryTag.entry_id.in_(ids)))).scalars()) if ids else []
    tag_ids = {row.tag_id for row in tag_rows}
    tags = list((await db.execute(select(Tag).where(Tag.user_id == user.id, Tag.id.in_(tag_ids)))).scalars()) if tag_ids else []
    media = list((await db.execute(select(Media).where(Media.user_id == user.id, Media.entry_id.in_(ids)))).scalars()) if ids else []
    tag_map: dict[uuid.UUID, list[uuid.UUID]] = {entry_id: [] for entry_id in ids}
    for row in tag_rows:
        tag_map.setdefault(row.entry_id, []).append(row.tag_id)
    entry_items = []
    for row in entries:
        item = to_response(row, tag_map.get(row.id, [])).model_dump(mode="json")
        item["updated_at"] = row.updated_at
        entry_items.append(item)
    return ok({
        "server_time": utcnow(),
        "has_more": len(entries) == limit,
        "entries": entry_items,
        "tags": [
            {"id": row.id, "name": row.name, "color": row.color, "created_at": row.created_at}
            for row in tags
        ],
        "media_meta": [
            {"id": row.id, "entry_id": row.entry_id, "sort_order": row.sort_order, "width": row.width, "height": row.height, "size": row.size, "mime": "", "url": row.url, "thumb_url": row.thumb_url or "", "created_at": row.created_at}
            for row in media
        ],
    })
