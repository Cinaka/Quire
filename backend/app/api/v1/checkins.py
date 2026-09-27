import logging
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ids import new_id
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.checkin import Checkin
from app.models.user import User
from app.schemas.envelope import Envelope, ok
from app.services.checkins import account_local_date, current_streak, longest_streak, month_bounds

router = APIRouter(prefix="/checkins", tags=["checkins"])
logger = logging.getLogger(__name__)


class TodayCheckinResponse(BaseModel):
    checkin_date: date
    checked_in: bool
    created: bool
    current_streak: int
    longest_streak: int
    total_checkins: int


class MonthCheckinResponse(BaseModel):
    year: int
    month: int
    checkin_dates: list[date]
    today: date
    checked_in_today: bool
    current_streak: int
    longest_streak: int
    total_checkins: int


async def checkin_today(
    db: AsyncSession,
    user: User,
    *,
    now: datetime | None = None,
) -> TodayCheckinResponse:
    """创建或读取今日签到，并返回幂等结果。"""
    user_id: uuid.UUID = user.id
    today = account_local_date(user.timezone, now=now)
    existing = await db.scalar(
        select(Checkin).where(Checkin.user_id == user_id, Checkin.checkin_date == today)
    )
    created = False

    if existing is None:
        db.add(Checkin(id=new_id(), user_id=user_id, checkin_date=today))
        try:
            await db.flush()
            created = True
        except IntegrityError:
            await db.rollback()
            existing = await db.scalar(
                select(Checkin).where(
                    Checkin.user_id == user_id,
                    Checkin.checkin_date == today,
                )
            )
            if existing is None:
                raise

    rows = await db.execute(
        select(Checkin.checkin_date).where(
            Checkin.user_id == user_id,
            Checkin.checkin_date <= today,
        )
    )
    checkin_dates = set(rows.scalars())
    if created:
        await db.commit()

    return TodayCheckinResponse(
        checkin_date=today,
        checked_in=True,
        created=created,
        current_streak=current_streak(checkin_dates, today),
        longest_streak=longest_streak(checkin_dates),
        total_checkins=len(checkin_dates),
    )


async def get_month_checkins(
    db: AsyncSession,
    user: User,
    year: int | None,
    month: int | None,
    *,
    now: datetime | None = None,
) -> MonthCheckinResponse:
    """读取指定月份；年月均省略时读取账号时区下的当前月。"""
    user_id: uuid.UUID = user.id
    today = account_local_date(user.timezone, now=now)
    target_year = year if year is not None else today.year
    target_month = month if month is not None else today.month
    start, end = month_bounds(target_year, target_month)

    month_rows = await db.execute(
        select(Checkin.checkin_date)
        .where(
            Checkin.user_id == user_id,
            Checkin.checkin_date >= start,
            Checkin.checkin_date < end,
        )
        .order_by(Checkin.checkin_date.asc())
    )
    checkin_dates = list(month_rows.scalars())

    streak_rows = await db.execute(
        select(Checkin.checkin_date).where(
            Checkin.user_id == user_id,
            Checkin.checkin_date <= today,
        )
    )
    streak_dates = set(streak_rows.scalars())

    return MonthCheckinResponse(
        year=target_year,
        month=target_month,
        checkin_dates=checkin_dates,
        today=today,
        checked_in_today=today in streak_dates,
        current_streak=current_streak(streak_dates, today),
        longest_streak=longest_streak(streak_dates),
        total_checkins=len(streak_dates),
    )


@router.post("/today")
async def post_today_checkin(
    response: Response,
    idempotency_key: uuid.UUID | None = Header(default=None, alias="X-Idempotency-Key"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[TodayCheckinResponse]:
    try:
        result = await checkin_today(db, user)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(status_code=422, detail="账号时区无效") from exc

    if idempotency_key is not None:
        key = str(idempotency_key)
        response.headers["X-Idempotency-Key"] = key
        logger.info(
            "daily check-in user=%s idempotency_key=%s created=%s",
            user.id,
            key,
            result.created,
        )
    return ok(result)


@router.get("/month")
async def get_month_checkin_summary(
    year: int | None = Query(None, ge=1970, le=9998),
    month: int | None = Query(None, ge=1, le=12),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[MonthCheckinResponse]:
    if (year is None) != (month is None):
        raise HTTPException(status_code=422, detail="year 与 month 必须同时提供")
    try:
        result = await get_month_checkins(db, user, year, month)
    except ZoneInfoNotFoundError as exc:
        raise HTTPException(status_code=422, detail="账号时区无效") from exc
    return ok(result)
