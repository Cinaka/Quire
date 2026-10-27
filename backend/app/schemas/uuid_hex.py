"""Explicit UUID32 wire type; add to reviewed schemas, never patch UUID globally."""

import uuid
from typing import Annotated

from pydantic import BeforeValidator, PlainSerializer, WithJsonSchema

from app.core.uuid_hex import parse_uuid, uuid_to_hex

UUIDHex = Annotated[
    uuid.UUID,
    BeforeValidator(parse_uuid),
    PlainSerializer(uuid_to_hex, return_type=str, when_used="json"),
    WithJsonSchema({
        "type": "string",
        "oneOf": [
            {"minLength": 32, "maxLength": 32, "pattern": "^[0-9a-fA-F]{32}$"},
            {"minLength": 36, "maxLength": 36,
             "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                        "[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},
        ],
    }, mode="validation"),
    WithJsonSchema({"type": "string", "minLength": 32, "maxLength": 32,
                    "pattern": "^[0-9a-f]{32}$"}, mode="serialization"),
]
