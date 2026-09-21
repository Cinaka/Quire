import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ids import new_id
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.tag import Tag
from app.models.user import User
from app.schemas.envelope import Envelope, ok

router = APIRouter(prefix="/tags", tags=["tags"])


class TagRequest(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    color: str | None = Field(default=None, max_length=16)
    created_at: datetime | None = None


class TagResponse(TagRequest):
    id: uuid.UUID
    created_at: datetime


def to_response(tag: Tag) -> TagResponse:
    return TagResponse(id=tag.id, name=tag.name, color=tag.color, created_at=tag.created_at)


@router.get("")
async def list_tags(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> Envelope[list[TagResponse]]:
    rows = list((await db.execute(select(Tag).where(Tag.user_id == user.id).order_by(Tag.name))).scalars())
    return ok([to_response(row) for row in rows])


@router.put("/{tag_id}")
async def put_tag(
    tag_id: uuid.UUID,
    body: TagRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[TagResponse]:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="标签名不能为空")
    tag = await db.scalar(select(Tag).where(Tag.id == tag_id, Tag.user_id == user.id))
    duplicate = await db.scalar(select(Tag).where(Tag.user_id == user.id, Tag.name == name))
    if duplicate is not None and duplicate.id != tag_id:
        raise HTTPException(status_code=409, detail=f"标签已存在: {duplicate.id}")
    if tag is None:
        tag = Tag(id=tag_id or new_id(), user_id=user.id, name=name, color=body.color)
        db.add(tag)
    else:
        tag.name = name
        tag.color = body.color
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="标签已存在") from exc
    await db.refresh(tag)
    return ok(to_response(tag))
