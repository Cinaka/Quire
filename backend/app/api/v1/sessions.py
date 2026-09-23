import uuid
from datetime import datetime

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth import REFRESH_COOKIE, clear_refresh_cookie
from app.core.security import decode_token, get_current_user
from app.core.time import utcnow
from app.db.session import get_db
from app.models.refresh_session import RefreshSession
from app.models.user import User
from app.schemas.envelope import Envelope, ok

router = APIRouter(prefix="/auth/sessions", tags=["auth"])


class SessionResponse(BaseModel):
    id: uuid.UUID
    createdAt: datetime
    expiresAt: datetime
    current: bool


class RevokeResponse(BaseModel):
    revoked: int


def current_session_id(token: str | None) -> uuid.UUID | None:
    if not token:
        return None
    try:
        payload = decode_token(token, "refresh")
        return uuid.UUID(str(payload["jti"]))
    except (HTTPException, ValueError):
        return None


@router.get("")
async def list_sessions(
    quire_refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[list[SessionResponse]]:
    now = utcnow()
    rows = (
        await db.scalars(
            select(RefreshSession)
            .where(
                RefreshSession.user_id == user.id,
                RefreshSession.revoked_at.is_(None),
                RefreshSession.expires_at > now,
                RefreshSession.token_version == user.token_version,
            )
            .order_by(RefreshSession.created_at.desc())
        )
    ).all()
    current_id = current_session_id(quire_refresh_token)
    return ok(
        [
            SessionResponse(
                id=row.id,
                createdAt=row.created_at,
                expiresAt=row.expires_at,
                current=row.id == current_id,
            )
            for row in rows
        ]
    )


@router.post("/revoke-others")
async def revoke_other_sessions(
    quire_refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[RevokeResponse]:
    current_id = current_session_id(quire_refresh_token)
    rows = (
        await db.scalars(
            select(RefreshSession).where(
                RefreshSession.user_id == user.id,
                RefreshSession.revoked_at.is_(None),
                RefreshSession.token_version == user.token_version,
            )
        )
    ).all()
    now = utcnow()
    revoked = 0
    for row in rows:
        if row.id != current_id:
            row.revoked_at = now
            revoked += 1
    await db.commit()
    return ok(RevokeResponse(revoked=revoked))


@router.delete("/{session_id}")
async def revoke_session(
    session_id: uuid.UUID,
    response: Response,
    quire_refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Envelope[None]:
    row = await db.scalar(
        select(RefreshSession).where(
            RefreshSession.id == session_id,
            RefreshSession.user_id == user.id,
            RefreshSession.revoked_at.is_(None),
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="会话不存在或已失效")
    row.revoked_at = utcnow()
    await db.commit()
    if session_id == current_session_id(quire_refresh_token):
        clear_refresh_cookie(response)
    return ok(None)
