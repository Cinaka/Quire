"""Target storage type for the UUID32 migration, NOT wired to existing models yet.

Keep Python UUID objects internally so .hex/.bytes and identity comparisons remain
well-defined. API text output is controlled separately by schemas/uuid_hex.py.
"""

import uuid

from sqlalchemy import CHAR, TypeDecorator
from sqlalchemy.dialects.mysql import CHAR as MySQLChar

from app.core.uuid_hex import parse_uuid, uuid_to_hex


class UUIDHexText(TypeDecorator):
    impl = CHAR(32)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "mysql":
            return dialect.type_descriptor(MySQLChar(32, charset="ascii", collation="ascii_bin"))
        return dialect.type_descriptor(CHAR(32))

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return uuid_to_hex(value)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if not isinstance(value, str) or len(value) != 32:
            raise ValueError("UUIDHexText requires a 32-character stored value")
        if value != uuid_to_hex(value):
            raise ValueError("stored UUID must be lowercase ASCII hex")
        return parse_uuid(value)

    @property
    def python_type(self):
        return uuid.UUID
