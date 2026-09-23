from collections.abc import Iterable
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo


def account_local_date(timezone_name: str, *, now: datetime | None = None) -> date:
    """返回指定账号时区下的当前自然日。

    `now` 仅用于测试和确定性调用；naive datetime 按项目约定视为 UTC。
    无效的 IANA 时区名由 ZoneInfo 抛错，禁止静默退回客户端日期。
    """
    instant = now or datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(ZoneInfo(timezone_name)).date()


def current_streak(checkin_dates: Iterable[date], today: date) -> int:
    """计算当前连续签到天数。

    今天已签到时从今天向前计算；今天未签到时从昨天向前计算，避免在用户
    当天尚未操作时提前把连续天数显示为零。
    """
    checked_days = set(checkin_dates)
    cursor = today if today in checked_days else today - timedelta(days=1)
    streak = 0
    while cursor in checked_days:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def month_bounds(year: int, month: int) -> tuple[date, date]:
    """返回月份查询的左闭右开日期边界。"""
    start = date(year, month, 1)
    if month == 12:
        return start, date(year + 1, 1, 1)
    return start, date(year, month + 1, 1)
