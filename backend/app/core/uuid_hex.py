"""Lossless UUID representation helpers; no monkeypatching and no data mutation.

The UUID's 128-bit identity is unchanged. Business generators still use UUID v7.
Legacy canonical strings are accepted only as input and normalized before use.
"""

import re
import uuid

_HEX = re.compile(r"[0-9a-fA-F]{32}\Z")
_CANONICAL = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z",
)


def parse_uuid(value: str | uuid.UUID, *, require_v7: bool = False) -> uuid.UUID:
    """Accept exact hex32/canonical text or UUID; reject whitespace, URNs and guessing."""
    if isinstance(value, uuid.UUID):
        result = value
    elif isinstance(value, str) and (_HEX.fullmatch(value) or _CANONICAL.fullmatch(value)):
        result = uuid.UUID(value)
    else:
        raise ValueError("UUID must be exactly 32 hex characters or a canonical UUID")
    if require_v7 and (result.version != 7 or result.variant != uuid.RFC_4122):
        raise ValueError("business identifier must be a UUID v7")
    return result


def uuid_to_hex(value: str | uuid.UUID, *, require_v7: bool = False) -> str:
    """Canonical application/database representation: 32 lowercase ASCII hex chars."""
    return parse_uuid(value, require_v7=require_v7).hex


def uuid_to_legacy_text(value: str | uuid.UUID) -> str:
    """Explicit compatibility boundary for pre-existing media paths and old protocols."""
    return str(parse_uuid(value))


def binary_uuid_to_hex(value: bytes) -> str:
    """Legacy MySQL UUIDBinary used raw UUID bytes; never use time-swap flag 1."""
    if not isinstance(value, bytes) or len(value) != 16:
        raise ValueError("legacy UUID storage must contain exactly 16 bytes")
    return uuid.UUID(bytes=value).hex


def hex_uuid_to_binary(value: str | uuid.UUID) -> bytes:
    """Lossless reverse conversion for a separately reviewed database rollback."""
    return parse_uuid(value).bytes


def normalize_uuid_list(values: list[str], *, require_v7: bool = False) -> list[str]:
    """Refuse aliases that collapse to the same key; never silently overwrite rows."""
    result = [uuid_to_hex(value, require_v7=require_v7) for value in values]
    if len(set(result)) != len(result):
        raise ValueError("multiple identifier representations refer to the same UUID")
    return result
