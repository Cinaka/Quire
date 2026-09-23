from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.media_storage import media_disk_paths, remove_media_paths
from app.core.time import utcnow
from app.models.diary_entry import DiaryEntry
from app.models.entry_tag import EntryTag
from app.models.media import Media


@dataclass(frozen=True)
class TombstonePurgeResult:
    entries: int
    media: int


async def purge_expired_tombstones(
    db: AsyncSession,
    *,
    retention_days: int = 180,
    batch_size: int = 500,
    now: datetime | None = None,
) -> TombstonePurgeResult:
    """物理清理一批超过保留期的日记墓碑及其关联数据。"""
    if retention_days < 1:
        raise ValueError("retention_days must be at least 1")
    if batch_size < 1 or batch_size > 5000:
        raise ValueError("batch_size must be between 1 and 5000")

    cutoff = (now or utcnow()) - timedelta(days=retention_days)
    entry_ids = list(
        (
            await db.scalars(
                select(DiaryEntry.id)
                .where(
                    DiaryEntry.deleted_at.is_not(None),
                    DiaryEntry.deleted_at < cutoff,
                )
                .order_by(DiaryEntry.deleted_at, DiaryEntry.id)
                .limit(batch_size)
                .with_for_update(skip_locked=True)
            )
        ).all()
    )
    if not entry_ids:
        return TombstonePurgeResult(entries=0, media=0)

    media_rows = list(
        (await db.scalars(select(Media).where(Media.entry_id.in_(entry_ids)))).all()
    )
    media_paths = [
        path
        for row in media_rows
        for path in media_disk_paths(row.url, row.thumb_url or "")
    ]

    await db.execute(delete(EntryTag).where(EntryTag.entry_id.in_(entry_ids)))
    await db.execute(delete(Media).where(Media.entry_id.in_(entry_ids)))
    await db.execute(delete(DiaryEntry).where(DiaryEntry.id.in_(entry_ids)))
    await db.commit()

    # 文件必须在事务成功后再删；提交失败时数据库记录和磁盘文件都保持原样。
    remove_media_paths(media_paths)
    return TombstonePurgeResult(entries=len(entry_ids), media=len(media_rows))
