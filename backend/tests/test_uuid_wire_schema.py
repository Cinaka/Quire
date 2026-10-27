"""Actual Pydantic UUID32 serializers; runnable with unittest and no API/DB imports."""

import json
import unittest
import uuid

from pydantic import BaseModel, Field, ValidationError

from app.schemas.uuid_hex import UUIDHex

TEXT = "01a01dfa-6c0a-72a6-a7f5-76323ee01718"
HEX = "01a01dfa6c0a72a6a7f576323ee01718"


class Identity(BaseModel):
    id: UUIDHex
    parent: UUIDHex | None = None
    ids: list[UUIDHex] = Field(default_factory=list)
    note: str = TEXT


class Container(BaseModel):
    user: Identity
    sessions: list[Identity]


class UUIDWireSchemaTests(unittest.TestCase):
    def test_json_is_hex_for_both_input_forms(self):
        for value in (TEXT, HEX, TEXT.upper(), HEX.upper(), uuid.UUID(TEXT)):
            with self.subTest(value=value):
                self.assertEqual(json.loads(Identity(id=value).model_dump_json())["id"], HEX)

    def test_python_value_and_dump_keep_uuid_objects(self):
        value = Identity(id=HEX)
        self.assertIsInstance(value.id, uuid.UUID)
        self.assertEqual(value.model_dump()["id"], uuid.UUID(TEXT))

    def test_lists_and_nullable_relationships(self):
        value = Identity(id=TEXT, parent=TEXT, ids=[TEXT, HEX])
        result = value.model_dump(mode="json")
        self.assertEqual(result["parent"], HEX)
        self.assertEqual(result["ids"], [HEX, HEX])
        self.assertIsNone(Identity(id=HEX).model_dump(mode="json")["parent"])

    def test_nested_models_serialize_without_global_uuid_patch(self):
        value = Container(user=Identity(id=TEXT), sessions=[Identity(id=HEX)])
        result = value.model_dump(mode="json")
        self.assertEqual(result["user"]["id"], HEX)
        self.assertEqual(result["sessions"][0]["id"], HEX)
        self.assertEqual(str(uuid.UUID(HEX)), TEXT)

    def test_arbitrary_text_is_unchanged(self):
        self.assertEqual(Identity(id=HEX).model_dump(mode="json")["note"], TEXT)

    def test_rejects_non_exact_text_and_non_strings(self):
        for value in ("urn:uuid:" + TEXT, "{" + TEXT + "}", HEX + "\n", " " + HEX,
                      "", "x" * 32, 123, None, [], {}):
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    Identity(id=value)

    def test_input_schema_documents_two_exact_shapes(self):
        shape = Identity.model_json_schema(mode="validation")["properties"]["id"]
        self.assertEqual(shape["type"], "string")
        self.assertEqual([item["minLength"] for item in shape["oneOf"]], [32, 36])
        self.assertEqual([item["maxLength"] for item in shape["oneOf"]], [32, 36])

    def test_output_schema_only_documents_lowercase_hex32(self):
        shape = Identity.model_json_schema(mode="serialization")["properties"]["id"]
        self.assertEqual(shape["pattern"], "^[0-9a-f]{32}$")
        self.assertEqual(shape["minLength"], 32)
        self.assertEqual(shape["maxLength"], 32)
        self.assertNotIn("format", shape)


if __name__ == "__main__":
    unittest.main()
