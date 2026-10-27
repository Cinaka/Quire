"""Actual media DTO/annotation checks without importing FastAPI or SQLAlchemy.

The ASGI/JWT/SQLite cases live separately in test_p7_media_security.py.
"""

import ast
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel, TypeAdapter, ValidationError

from app.schemas.uuid_hex import UUIDHex

ID = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123458")
OTHER = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123459")
SOURCE = Path(__file__).resolve().parents[1] / "app/api/v1/media.py"


class UUIDMediaSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse(SOURCE.read_text())
        nodes = [node for node in cls.tree.body
                 if isinstance(node, ast.ClassDef) and node.name == "MediaResponse"]
        if len(nodes) != 1:
            raise AssertionError("MediaResponse class missing")
        namespace = {"__name__": __name__, "BaseModel": BaseModel,
                     "UUIDHex": UUIDHex, "datetime": datetime}
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), "exec"), namespace)
        cls.dto = namespace["MediaResponse"]

    def media(self, **changes):
        values = {"id": ID, "entry_id": OTHER, "sort_order": 0, "width": None,
                  "height": None, "size": 12, "mime": "image/png",
                  "url": f"/media/{ID.hex[:4]}/{ID}.png", "thumb_url": "",
                  "created_at": datetime(2026, 10, 27, tzinfo=timezone.utc)}
        values.update(changes)
        return self.dto(**values)

    def test_explicit_identity_fields_serialize_hex32(self):
        row = self.media(id=str(ID).upper(), entry_id=OTHER.hex.upper())
        self.assertEqual((row.id, row.entry_id), (ID, OTHER))
        data = row.model_dump(mode="json")
        self.assertEqual((data["id"], data["entry_id"]), (ID.hex, OTHER.hex))

    def test_optional_entry_remains_null(self):
        self.assertIsNone(self.media(entry_id=None).model_dump(mode="json")["entry_id"])

    def test_stored_legacy_url_is_not_rewritten(self):
        row = self.media(thumb_url=f"/media/{ID.hex[:4]}/{ID}_thumb.png")
        data = row.model_dump(mode="json")
        self.assertEqual(data["url"], row.url)
        self.assertEqual(data["thumb_url"], row.thumb_url)

    def test_exact_id_input_aliases_share_identity(self):
        for value in [ID.hex, str(ID), ID.hex.upper(), str(ID).upper()]:
            with self.subTest(value=value):
                self.assertEqual(TypeAdapter(UUIDHex).validate_python(value), ID)

    def test_invalid_id_is_not_guessed(self):
        for value in ["urn:uuid:" + str(ID), "{" + str(ID) + "}", " " + ID.hex,
                      ID.hex + " ", "bad", ID.bytes]:
            for field in ["id", "entry_id"]:
                with self.subTest(value=value, field=field), self.assertRaises(ValidationError):
                    self.media(**{field: value})

    def test_output_schema_is_lowercase_hex32(self):
        props = self.dto.model_json_schema(mode="serialization")["properties"]
        self.assertEqual(props["id"]["pattern"], "^[0-9a-f]{32}$")
        entry = next(item for item in props["entry_id"]["anyOf"] if item["type"] == "string")
        self.assertEqual(entry["maxLength"], 32)

    def test_input_schema_keeps_exact_32_and_36_compatibility(self):
        schema = self.dto.model_json_schema(mode="validation")["properties"]["id"]
        self.assertEqual([item["maxLength"] for item in schema["oneOf"]], [32, 36])

    def test_all_media_route_id_annotations_use_reviewed_codec(self):
        expected = {"upload_media": {"media_id": "UUIDHex", "entry_id": "UUIDHex | None"},
                    "private_media": {"media_id": "UUIDHex"},
                    "list_media": {"entry_id": "UUIDHex | None"},
                    "delete_media": {"media_id": "UUIDHex"}}
        functions = {node.name: node for node in self.tree.body
                     if isinstance(node, ast.AsyncFunctionDef)}
        for name, fields in expected.items():
            args = {arg.arg: ast.unparse(arg.annotation) for arg in functions[name].args.args
                    if arg.annotation is not None}
            for field, annotation in fields.items():
                self.assertEqual(args[field], annotation, f"{name}.{field}")


if __name__ == "__main__":
    unittest.main()
