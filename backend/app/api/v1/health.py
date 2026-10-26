from fastapi import APIRouter
from sqlalchemy import text

from app.core.config import settings
from app.core.redis_limits import redis_limits
from app.db.session import engine

router = APIRouter(tags=["system"])


@router.get("/health")
async def health():
    result = {"status": "ok", "mysql": False, "redis": "disabled"}

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        result["mysql"] = True
    except Exception:  # noqa: BLE001 - health 必须把连接失败降级为响应
        result["status"] = "degraded"

    if settings.REDIS_ENABLED:
        result["redis"] = await redis_limits.healthy()
        if not result["redis"]:
            result["status"] = "degraded"

    return result
