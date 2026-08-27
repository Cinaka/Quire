from fastapi import APIRouter
from sqlalchemy import text

from app.core.config import settings
from app.db.session import engine

router = APIRouter(tags=["system"])


@router.get("/health")
async def health():
    result = {"status": "ok", "mysql": False, "redis": "disabled"}

    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        result["mysql"] = True
    except Exception as e:  # noqa: BLE001 - health 必须把连接失败降级为响应
        result["status"] = "degraded"
        result["mysql_error"] = str(e)[:200]

    if settings.REDIS_ENABLED:
        try:
            import redis.asyncio as aioredis  # 延迟导入，未启用时完全不加载

            client = aioredis.from_url(settings.REDIS_URL)
            await client.ping()
            await client.aclose()
            result["redis"] = True
        except Exception as e:  # noqa: BLE001 - health 必须把连接失败降级为响应
            result["status"] = "degraded"
            result["redis"] = False
            result["redis_error"] = str(e)[:200]

    return result
