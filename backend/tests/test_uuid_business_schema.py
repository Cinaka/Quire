"""Isolated checks of the actual DTO class bodies, without importing API/DB dependencies.

HTTP routing, auth and database behavior are covered separately by test_uuid_business_wire.
"""

import ast
import unittest
import uuid
from datetime import date, datetime
from pathlib import Path

from pydantic import BaseModel, Field, ValidationError

from app.schemas.uuid_hex import UUIDHex

ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
AT = datetime(2026, 10, 8, 10)
API = Path(__file__).resolve().parents[1] / "app" / "api" / "v1"


def actual_dtos():
    namespace = {"__name__": __name__, "BaseModel": BaseModel, "Field": Field,
                 "UUIDHex": UUIDHex, "date": date, "datetime": datetime}
    selected = {
        "entries.py": {"EntryRequest", "EntryResponse"},
        "tags.py": {"TagRequest", "TagResponse"},
        "sync.py": {"SyncEntry", "SyncTag", "SyncMedia", "PushRequest"},
    }
    for filename, names in selected.items():
        path = API / filename
        tree = ast.parse(path.read_text())
        nodes = [node for node in tree.body
                 if isinstance(node, ast.ClassDef) and node.name in names]
        if {node.name for node in nodes} != names:
            raise AssertionError(f"missing DTO definitions in {filename}")
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


class UUIDBusinessSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dtos = actual_dtos()

    def entry(self, **changes):
        values = {"entry_date": "2026-10-08", "client_updated_at": AT,
                  "id": ID, "created_at": AT, "updated_at": AT}
        values.update(changes)
        return self.dtos["EntryResponse"](**values)

    def test_entry_ids_are_hex32_but_python_values_stay_uuid(self):
        row = self.entry(tag_ids=[str(ID).upper()], from_schedule_id=ID.hex.upper())
        self.assertEqual(row.id, ID)
        self.assertEqual(row.tag_ids, [ID])
        self.assertEqual(row.from_schedule_id, ID)
        data = row.model_dump(mode="json")
        self.assertEqual((data["id"], data["tag_ids"], data["from_schedule_id"]),
                         (ID.hex, [ID.hex], ID.hex))

    def test_plain_text_and_content_are_not_uuid_rewritten(self):
        text = str(ID)
        row = self.entry(title=text, content_text=text, content={"text": text})
        data = row.model_dump(mode="json")
        self.assertEqual((data["title"], data["content_text"], data["content"]),
                         (text, text, {"text": text}))

    def test_optional_relation_stays_null(self):
        self.assertIsNone(self.entry().model_dump(mode="json")["from_schedule_id"])

    def test_tag_response_id_only_is_normalized(self):
        row = self.dtos["TagResponse"](id=str(ID).upper(), name=str(ID)[:32], created_at=AT)
        self.assertEqual(row.id, ID)
        self.assertEqual(row.model_dump(mode="json")["id"], ID.hex)
        self.assertEqual(row.name, str(ID)[:32])

    def test_sync_batch_normalizes_nested_identity_fields(self):
        row = self.dtos["PushRequest"](
            entries=[{"id": str(ID), "entry_date": "2026-10-08", "client_updated_at": AT,
                      "tag_ids": [ID.hex], "from_schedule_id": str(ID)}],
            tags=[{"id": str(ID), "name": "标签", "created_at": AT}],
            media_meta=[{"id": str(ID), "entry_id": ID.hex, "mime": "image/png",
                         "created_at": AT}],
        )
        data = row.model_dump(mode="json")
        for key in ["entries", "tags", "media_meta"]:
            self.assertEqual(data[key][0]["id"], ID.hex)
        self.assertEqual(data["media_meta"][0]["entry_id"], ID.hex)
        self.assertEqual(row.entries[0].model_dump()["id"], ID)

    def test_sync_media_unlink_keeps_null(self):
        row = self.dtos["SyncMedia"](id=ID, entry_id=None, mime="image/png", created_at=AT)
        self.assertIsNone(row.model_dump(mode="json")["entry_id"])

    def test_malformed_identity_is_rejected_not_silently_repaired(self):
        for value in ["urn:uuid:" + str(ID), "{" + str(ID) + "}", " " + ID.hex, "bad"]:
            for field in ["id", "from_schedule_id", "tag_ids"]:
                with self.subTest(value=value, field=field), self.assertRaises(ValidationError):
                    self.entry(**{field: [value] if field == "tag_ids" else value})

    def test_response_schema_documents_hex32(self):
        schema = self.dtos["EntryResponse"].model_json_schema(mode="serialization")
        self.assertEqual(schema["properties"]["id"]["pattern"], "^[0-9a-f]{32}$")
        self.assertEqual(schema["properties"]["tag_ids"]["items"]["maxLength"], 32)


if __name__ == "__main__":
    unittest.main()
