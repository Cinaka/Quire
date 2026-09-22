import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.time import as_utc_naive, utcnow
from app.db.session import get_db
from app.models.diary_entry import DiaryEntry
from app.models.entry_tag import EntryTag
from app.models.user import User
from app.schemas.envelope import Envelope, Page, ok, paged

router = APIRouter(prefix="/entries", tags=["entries"])


class EntryRequest(BaseModel):
    entry_date: date
    sort_order: int = 0
    title: str = ""
    content: dict | None = None
    content_text: str = ""
    mood: str | None = None
    weather: str | None = None
    tag_ids: list[uuid.UUID] = Field(default_factory=list)
    from_schedule_id: uuid.UUID | None = None
    client_updated_at: datetime
    deleted_at: datetime | None = None


class EntryResponse(EntryRequest):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime


async def tag_map(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[uuid.UUID]]:
    if not ids:
        return {}
    rows = (await db.execute(select(EntryTag).where(EntryTag.entry_id.in_(ids)))).scalars()
    result: dict[uuid.UUID, list[uuid.UUID]] = {item: [] for item in ids}
    for row in rows:
        result.setdefault(row.entry_id, []).append(row.tag_id)
    return result


def to_response(entry: DiaryEntry, tags: list[uuid.UUID]) -> EntryResponse:
    return EntryResponse(
        id=entry.id,
        entry_date=entry.entry_date,
        sort_order=entry.sort_order,
        title=entry.title or "",
        content=entry.content,
        content_text=entry.content_text or "",
        mood=entry.mood,
        weather=entry.weather,
        tag_ids=tags,
        from_schedule_id=entry.from_schedule_id,
        client_updated_at=entry.client_updated_at or utcnow(),
        deleted_at=entry.deleted_at,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )


async def upsert_entry(
    db: AsyncSession, user: User, entry_id: uuid.UUID, body: EntryRequest
) -> tuple[DiaryEntry, str]:
    entry = await db.scalar(
        select(DiaryEntry).where(DiaryEntry.id == entry_id, DiaryEntry.user_id == user.id)
    )
    incoming_updated_at = as_utc_naive(body.client_updated_at)
    if (
        entry is not None
        and entry.client_updated_at
        and incoming_updated_at <= entry.client_updated_at
    ):
        return entry, "stale"
    if entry is None:
        entry = DiaryEntry(id=entry_id, user_id=user.id)
        db.add(entry)
    entry.entry_date = body.entry_date
    entry.sort_order = body.sort_order
    entry.title = body.title
    entry.content = body.content
    entry.content_text = body.content_text
    entry.mood = body.mood
    entry.weather = body.weather
    entry.from_schedule_id = body.from_schedule_id
    entry.client_updated_at = incoming_updated_at
    entry.deleted_at = as_utc_naive(body.deleted_at) if body.deleted_at else None
    await db.flush()
    await db.execute(delete(EntryTag).where(EntryTag.entry_id == entry_id))
    for tag_id in set(body.tag_ids):
        await db.merge(EntryTag(entry_id=entry_id, tag_id=tag_id))
    return entry, "applied"


@router.get("")
async def list_entries(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    keyword: str | None = None,
    tag_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    only_deleted: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[Page[EntryResponse]]:
    query = select(DiaryEntry).where(DiaryEntry.user_id == user.id)
    if only_deleted:
        query = query.where(DiaryEntry.deleted_at.is_not(None))
    else:
        query = query.where(DiaryEntry.deleted_at.is_(None))
    if keyword:
        query = query.where(
            (DiaryEntry.title.contains(keyword))
            | (DiaryEntry.content_text.contains(keyword))
        )
    if date_from:
        query = query.where(DiaryEntry.entry_date >= date_from)
    if date_to:
        query = query.where(DiaryEntry.entry_date <= date_to)
    if tag_id:
        query = query.join(EntryTag, EntryTag.entry_id == DiaryEntry.id).where(
            EntryTag.tag_id == tag_id
        )
    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = list(
        (
            await db.execute(
                query.order_by(
                    DiaryEntry.entry_date.desc(), DiaryEntry.sort_order.desc()
                )
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        ).scalars()
    )
    mapping = await tag_map(db, [row.id for row in rows])
    return paged(
        [to_response(row, mapping.get(row.id, [])) for row in rows],
        total,
        page,
        page_size,
    )


@router.get("/{entry_id}")
async def get_entry(
    entry_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[EntryResponse]:
    entry = await db.scalar(
        select(DiaryEntry).where(
            DiaryEntry.id == entry_id, DiaryEntry.user_id == user.id
        )
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="日记不存在")
    mapping = await tag_map(db, [entry.id])
    return ok(to_response(entry, mapping.get(entry.id, [])))


@router.put("/{entry_id}")
async def put_entry(
    entry_id: uuid.UUID,
    body: EntryRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[EntryResponse]:
    entry, result = await upsert_entry(db, user, entry_id, body)
    if result == "stale":
        raise HTTPException(status_code=409, detail="服务端已有更新版本")
    await db.commit()
    await db.refresh(entry)
    mapping = await tag_map(db, [entry.id])
    return ok(to_response(entry, mapping.get(entry.id, [])))


@router.delete("/{entry_id}")
async def delete_entry(
    entry_id: uuid.UUID,
    body: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[EntryResponse]:
    entry = await db.scalar(
        select(DiaryEntry).where(
            DiaryEntry.id == entry_id, DiaryEntry.user_id == user.id
        )
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="日记不存在")
    client_updated_at = body.get("client_updated_at")
    if not client_updated_at:
        raise HTTPException(status_code=422, detail="缺少 client_updated_at")
    try:
        parsed = as_utc_naive(
            datetime.fromisoformat(str(client_updated_at).replace("Z", "+00:00"))
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="client_updated_at 格式无效") from exc
    if entry.client_updated_at and parsed <= entry.client_updated_at:
        raise HTTPException(status_code=409, detail="服务端已有更新版本")
    entry.client_updated_at = parsed
    entry.deleted_at = utcnow()
    await db.commit()
    await db.refresh(entry)
    mapping = await tag_map(db, [entry.id])
    return ok(to_response(entry, mapping.get(entry.id, [])))
