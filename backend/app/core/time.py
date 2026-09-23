from datetime import datetime, timezone


def utcnow() -> datetime:
    """返回适合写入 MySQL DATETIME 的 UTC naive 时间。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def as_utc_naive(value: datetime) -> datetime:
    """把客户端 ISO 时间统一转换为 UTC naive，避免 aware/naive 混合比较。

    MySQL DATETIME 不保存时区；带偏移时间必须先换算到 UTC，不能直接删除 tzinfo。
    已经是 naive 的数据库时间按约定视为 UTC。
    """
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)
