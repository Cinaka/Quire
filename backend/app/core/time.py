from datetime import datetime, timezone


def utcnow() -> datetime:
    """写库时间统一走这个函数。禁止直接用 datetime.now()。
    末尾 replace(tzinfo=None) 是必须的：MySQL DATETIME 不存时区，
    传 aware datetime 进去驱动会直接丢掉 tzinfo 而不做转换。
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)
