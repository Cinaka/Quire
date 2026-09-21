import uuid
from datetime import timedelta

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.ids import new_id
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    get_current_user,
    hash_password,
    verify_password,
)
from app.db.session import get_db
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


async def issue_auth(response: Response, user: User) -> Envelope[AuthResponse]:
    access = create_access_token(user)
    refresh = create_refresh_token(user)
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
    await db.commit()
    await db.refresh(user)
    return await issue_auth(response, user)


@router.post("/login")
async def login(
    body: LoginRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> Envelope[AuthResponse]:
    email = body.email.strip().lower()
    user = await db.scalar(select(User).where(User.email == email))
    if user is None or not user.password_hash or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    return await issue_auth(response, user)


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
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="用户标识无效") from exc
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None or int(payload.get("tv", -1)) != user.token_version:
        raise HTTPException(status_code=401, detail="刷新令牌已失效")
    access = create_access_token(user)
    set_refresh_cookie(response, create_refresh_token(user))
    return ok(RefreshResponse(access_token=access, expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60))


@router.post("/logout")
async def logout(response: Response) -> Envelope[None]:
    clear_refresh_cookie(response)
    return ok(None)


@router.get("/me")
async def me(user: User = Depends(get_current_user)) -> Envelope[UserResponse]:
    return ok(user_response(user))
