import uuid

import uuid_utils


def new_id() -> uuid.UUID:
    """Generate UUID v7; keep UUID objects internally, UUIDHexText stores .hex.

    Business keys usually originate on the client. Server-created records and
    tests use this function; changing storage never regenerates an existing ID.
    """
    return uuid.UUID(str(uuid_utils.uuid7()))


def new_id_hex() -> str:
    """Explicit 32-character lowercase representation for text boundaries."""
    return new_id().hex
