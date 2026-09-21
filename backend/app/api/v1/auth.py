import uuid
from datetime import timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.ids import new_id
from app.core.rate_limit import login_rate_limiter
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.core.time import utcnow
from app.db.session import get_db
from app.models.refresh_session import RefreshSession
from app.models.user import User
from app.schemas.envelope import Envelope, ok

router = APIRouter(prefix="/auth", tags=["auth"])
REFRESH_COOKIE = "quire_refresh_token"


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=128)
    password: str = Field(min_length=8, max_length=128)
    timezone: str = Field(default="Asia/Shanghai", max_length=64)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=128)
    password: str = Field(min_length=1, max_length=128)


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str | None
    nickname: str | None
    timezone: str


class AuthResponse(BaseModel):
    user: UserResponse
    access_token: str
    expires_in: int


class RefreshResponse(BaseModel):
    access_token: str
    expires_in: int


def user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        nickname=user.nickname,
        timezone=user.timezone,
    )


def set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        httponly=True,
        secure=not settings.DEBUG,
        samesite="lax",
        path=f"{settings.API_V1_PREFIX}/auth",
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path=f"{settings.API_V1_PREFIX}/auth")


async def new_refresh_session(db: AsyncSession, user: User) -> tuple[RefreshSession, str]:
    session = RefreshSession(
        id=new_id(),
        user_id=user.id,
        token_version=user.token_version,
        expires_at=utcnow() + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(session)
    await db.flush()
    return session, create_refresh_token(user, session.id)


async def issue_auth(
    response: Response,
    user: User,
    db: AsyncSession,
) -> Envelope[AuthResponse]:
    access = create_access_token(user)
    _, refresh = await new_refresh_session(db, user)
    await db.commit()
    set_refresh_cookie(response, refresh)
    return ok(
        AuthResponse(
            user=user_response(user),
            access_token=access,
            expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        )
    )


@router.post("/register")
async def register(
    body: RegisterRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> Envelope[AuthResponse]:
    email = body.email.strip().lower()
    exists = await db.scalar(select(User).where(User.email == email))
    if exists:
        raise HTTPException(status_code=409, detail="邮箱已注册")
    user = User(
        id=new_id(),
        email=email,
        password_hash=hash_password(body.password),
        timezone=body.timezone,
    )
    db.add(user)
    await db.flush()
    return await issue_auth(response, user, db)


@router.post("/login")
async def login(
    request: Request,
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> Envelope[AuthResponse]:
    email = body.email.strip().lower()
    client_ip = request.client.host if request.client else "unknown"
    rate_key = f"{client_ip}:{email}"
    login_rate_limiter.check(rate_key)

    user = await db.scalar(select(User).where(User.email == email))
    if user is None or not user.password_hash or not verify_password(body.password, user.password_hash):
        login_rate_limiter.fail(rate_key)
        raise HTTPException(status_code=401, detail="邮箱或密码错误")

    login_rate_limiter.clear(rate_key)
    return await issue_auth(response, user, db)


@router.post("/refresh")
async def refresh(
    response: Response,
    quire_refresh_token: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> Envelope[RefreshResponse]:
    if not quire_refresh_token:
        raise HTTPException(status_code=401, detail="缺少刷新令牌")
    payload = decode_token(quire_refresh_token, "refresh")
    try:
        user_id = uuid.UUID(str(payload["sub"]))
        session_id = uuid.UUID(str(payload["jti"]))
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="刷新令牌无效") from exc

    user = await db.scalar(select(User).where(User.id == user_id))
    session = await db.scalar(
        select(RefreshSession)
        .where(
            RefreshSession.id == session_id,
            RefreshSession.user_id == user_id,
        )
        .with_for_update()
    )
    now = utcnow()
    if (
        user is None
        or session is None
        or session.revoked_at is not None
        or session.expires_at <= now
        or session.token_version != user.token_version
        or int(payload.get("tv", -1)) != user.token_version
    ):
        raise HTTPException(status_code=401, detail="刷新令牌已失效")

    session.revoked_at = now
    _, refresh_token = await new_refresh_session(db, user)
    access = create_access_token(user)
    await db.commit()
    set_refresh_cookie(response, refresh_token)
    return ok(
        RefreshResponse(
            access_token=access,
            expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        )
    )


@router.post("/logout")
async def logout(
    response: Response,
    quire_refresh_token: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
) -> Envelope[None]:
    if quire_refresh_token:
        try:
            payload = decode_token(quire_refresh_token, "refresh")
            session_id = uuid.UUID(str(payload["jti"]))
            session = await db.scalar(
                select(RefreshSession).where(RefreshSession.id == session_id)
            )
            if session is not None and session.revoked_at is None:
                session.revoked_at = utcnow()
                await db.commit()
        except (HTTPException, ValueError):
            pass
    clear_refresh_cookie(response)
    return ok(None)


@router.get("/me")
async def me(user: User = Depends(get_current_user)) -> Envelope[UserResponse]:
    return ok(user_response(user))
