"""Create-only independent tags; presence proof, never conversion or diary acknowledgement."""

import json
import unicodedata
import uuid
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import select

from app.core.time import utcnow
from app.models.diary_entry import DiaryEntry
from app.models.media import Media
from app.models.schedule import Schedule
from app.models.tag import Tag


def name_key(value):
    return "".join(
        char for char in unicodedata.normalize("NFKD", value)
        if not unicodedata.category(char).startswith("M")
    ).strip().lower()


def proof_key(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class IndependentTagCopy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_tag_id: uuid.UUID
    id: uuid.UUID
    name: str = Field(min_length=1, max_length=32)
    color: str | None = Field(max_length=16)

    @field_validator("from_tag_id", "id")
    @classmethod
    def v7_identity(cls, value):
        if value.version != 7:
            raise ValueError("标签身份必须为UUID v7")
        return value

    @field_validator("name")
    @classmethod
    def explicit_name(cls, value):
        if value != value.strip() or not name_key(value):
            raise ValueError("请明确填写无首尾空格的独立名称")
        return value


class IndependentTagCopiesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_id: uuid.UUID
    choice: Literal["cloud-source-use-diary", "cloud-source-keep-diary"]
    confirmed: bool = Field(strict=True)
    expected_resources: dict
    copies: list[IndependentTagCopy] = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def complete_explicit_batch(self):
        if self.plan_id.version != 7 or self.confirmed is not True:
            raise ValueError("需要有效准备身份与明确发布确认")
        if len(proof_key(self.expected_resources).encode("utf-8")) > 1024 * 1024:
            raise ValueError("资源证明过大，请保留原准备重新核对")
        old_ids = {row.from_tag_id for row in self.copies}
        new_ids = {row.id for row in self.copies}
        keys = {name_key(row.name) for row in self.copies}
        if (len(old_ids) != len(self.copies) or len(new_ids) != len(self.copies)
                or len(keys) != len(self.copies) or old_ids & new_ids
                or self.plan_id in old_ids | new_ids):
            raise ValueError("副本映射、明确名称或准备身份重复")
        return self


async def create_independent_tags(db, owner, schedule_id, body, proof, *, require_existing=False):
    """Caller holds source/resource locks, owns the one commit and handles duplicate races."""
    if (proof.resource_state != "verified" or not proof.resources_complete
            or not proof.review.reviewable or not proof.review.receipt_known
            or proof.review.entry_state != "active"
            or proof.review.schedule is None or proof.review.schedule.deleted_at is not None
            or proof.review.entry is None):
        raise HTTPException(status_code=409, detail="终态或资源证明尚不能发布独立标签")
    if proof_key(body.expected_resources) != proof_key(proof.model_dump(mode="json")):
        raise HTTPException(status_code=409, detail="当前资源证明已变化，保留准备重新核对")
    if body.choice == "cloud-source-use-diary":
        if {row.from_tag_id for row in body.copies} != set(proof.tag_ids):
            raise HTTPException(status_code=409, detail="命名未完整对应当前云端日记标签")
        definitions = {tag.id: tag for tag in proof.tags}
        if any(row.color != definitions[row.from_tag_id].color for row in body.copies):
            raise HTTPException(status_code=409, detail="副本颜色不对应明确选择的云端版本")
    original_ids = {schedule_id, *proof.media_ids, *proof.tag_ids}
    forbidden = {body.plan_id, *original_ids}
    if body.plan_id in original_ids or any(row.id in forbidden for row in body.copies):
        raise HTTPException(status_code=409, detail="副本身份已被来源或资源占用")
    # A bounded full owner catalog catches conservative near-name ambiguity. SQL's
    # own comparison/unique constraint remains authoritative for MySQL collation.
    catalog = list((await db.execute(select(Tag).where(
        Tag.user_id == owner.id,
    ).order_by(Tag.id).limit(10001).with_for_update())).scalars())
    if len(catalog) > 10000:
        raise HTTPException(status_code=409, detail="标签目录过大，未发布")
    existing = []
    for copy in body.copies:
        # Never canonicalize a duplicate name to another ID, even if definitions match.
        if any(tag.id != copy.id and name_key(tag.name) == name_key(copy.name)
               for tag in catalog):
            raise HTTPException(status_code=409, detail="独立名称已占用，未合并或自动改名")
        # Let the database's collation detect additional equivalent spellings as well.
        equivalent = list((await db.execute(select(Tag).where(
            Tag.user_id == owner.id, Tag.name == copy.name,
        ).with_for_update())).scalars())
        if any(tag.id != copy.id for tag in equivalent):
            raise HTTPException(status_code=409, detail="独立名称已占用，未合并或自动改名")
        for model in (Schedule, DiaryEntry, Media):
            if await db.scalar(select(model.id).where(
                model.id == copy.id,
            ).with_for_update()) is not None:
                raise HTTPException(status_code=409, detail="副本身份已占用，未覆盖")
        row = await db.scalar(select(Tag).where(Tag.id == copy.id).with_for_update())
        if row is not None and (
            row.user_id != owner.id or row.name != copy.name or row.color != copy.color
        ):
            raise HTTPException(status_code=409, detail="副本身份已占用或定义已变化，未覆盖")
        if require_existing and row is None:
            raise HTTPException(status_code=409, detail="独立标签已缺失，复核不重新创建")
        existing.append(row)
    clock = utcnow()
    created_at = clock.replace(microsecond=clock.microsecond // 1000 * 1000)
    result = []
    created = False
    for copy, row in zip(body.copies, existing, strict=True):
        is_new = row is None
        if is_new:
            row = Tag(
                id=copy.id, user_id=owner.id, name=copy.name, color=copy.color,
                created_at=created_at,
            )
            db.add(row)
            created = True
        result.append({
            "from_tag_id": copy.from_tag_id, "id": row.id, "name": row.name,
            "color": row.color, "created_at": row.created_at, "created": is_new,
        })
    if created:
        await db.flush()
    return result, created
