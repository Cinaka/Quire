# app/schemas/envelope.py —— 统一响应体。全项目只有这一处构造 {code,message,data}
from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    code: int = 0
    message: str = "ok"
    data: T | None = None


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


def ok(data: T | None = None) -> Envelope[T]:
    return Envelope[T](code=0, message="ok", data=data)


def paged(items: list[T], total: int, page: int, page_size: int) -> Envelope[Page[T]]:
    return ok(Page[T](items=items, total=total, page=page, page_size=page_size))
