"""Target explicit API UUID type; does not change all Pydantic models globally."""

import uuid
from typing import Annotated

from pydantic import BeforeValidator, PlainSerializer, WithJsonSchema

from app.core.uuid_hex import parse_uuid, uuid_to_hex

UUIDHex = Annotated[
    uuid.UUID,
    BeforeValidator(parse_uuid),
    PlainSerializer(uuid_to_hex, return_type=str, when_used="json"),
    WithJsonSchema({"type": "string", "pattern": "^[0-9a-f]{32}$"}, mode="serialization"),
]
