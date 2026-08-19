import uuid

from sqlalchemy import BINARY, TypeDecorator
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass

class UUIDBinary(TypeDecorator):
    """UUID ←→ BINARY(16)。
    本项目用 UUID v7，前 48 bit 即毫秒时间戳且为大端序，原始字节天然有序，
    因此直接存 uuid.bytes，不做 UUID_TO_BIN(x, 1) 的时间位交换。
    等价于 MySQL 的 UUID_TO_BIN(x, 0)。
    """
    impl = BINARY(16)
    cache_ok = True
    def process_bind_param(self, value, dialect):
        if value is None:
            return None

        if isinstance(value, str):
            value = uuid.UUID(value)
        return value.bytes

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return uuid.UUID(bytes=value)
