import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

os.environ.setdefault("MYSQL_PASSWORD", "test-only")
os.environ.setdefault("JWT_SECRET", "test-only-secret")

from app.api.v1.media import list_media
from app.models.media import Media

USER_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
MEDIA_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123458")


class ExecuteResult:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self.rows


def test_media_list_supports_utc_normalized_since_cursor() -> None:
    row = Media(
        id=MEDIA_ID,
        user_id=USER_ID,
        entry_id=None,
        url="/media/abcd/image.webp",
        thumb_url="",
        sort_order=0,
        width=800,
        height=600,
        size=1234,
        created_at=datetime(2026, 9, 23, 1, 0),
    )
    db = SimpleNamespace(execute=AsyncMock(return_value=ExecuteResult([row])))
    user = SimpleNamespace(id=USER_ID)
    since = datetime(2026, 9, 23, 8, 0, tzinfo=timezone(timedelta(hours=8)))

    response = asyncio.run(
        list_media(entry_id=None, since=since, user=user, db=db)
    )

    assert response.data is not None
    assert response.data[0].id == MEDIA_ID
    assert response.data[0].created_at == row.created_at
    statement = db.execute.await_args.args[0]
    assert "media.created_at >" in str(statement)
