"""Dependency-free codec tests. Not ORM, MySQL, FastAPI or migration integration."""

import importlib.util
import unittest
import uuid
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "app/core/uuid_hex.py"
spec = importlib.util.spec_from_file_location("quire_uuid_hex", MODULE)
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)
CANONICAL = "01a01dfa-6c0a-72a6-a7f5-76323ee01718"
HEX = "01a01dfa6c0a72a6a7f576323ee01718"


class UUIDHexTests(unittest.TestCase):
    def test_known_user_example(self):
        self.assertEqual(codec.uuid_to_hex(CANONICAL, require_v7=True), HEX)

    def test_uppercase_input_normalizes_lowercase(self):
        self.assertEqual(codec.uuid_to_hex(CANONICAL.upper()), HEX)
        self.assertEqual(codec.uuid_to_hex(HEX.upper()), HEX)

    def test_uuid_object_preserves_identity(self):
        value = uuid.UUID(CANONICAL)
        self.assertEqual(codec.uuid_to_hex(value), value.hex)
        self.assertEqual(codec.parse_uuid(HEX), value)

    def test_no_time_swap_in_binary_conversion(self):
        self.assertEqual(codec.binary_uuid_to_hex(uuid.UUID(CANONICAL).bytes), HEX)
        self.assertEqual(codec.hex_uuid_to_binary(HEX), uuid.UUID(CANONICAL).bytes)

    def test_text_roundtrip(self):
        self.assertEqual(codec.uuid_to_legacy_text(HEX), CANONICAL)
        self.assertEqual(codec.uuid_to_hex(codec.uuid_to_legacy_text(HEX)), HEX)

    def test_legacy_v4_only_when_not_requiring_business_v7(self):
        value = uuid.UUID("550e8400-e29b-41d4-a716-446655440000")
        self.assertEqual(codec.uuid_to_hex(value), value.hex)
        with self.assertRaises(ValueError):
            codec.uuid_to_hex(value, require_v7=True)

    def test_invalid_version_or_variant(self):
        for value in (HEX[:12] + "4" + HEX[13:], HEX[:16] + "f" + HEX[17:]):
            with self.assertRaises(ValueError):
                codec.uuid_to_hex(value, require_v7=True)

    def test_no_whitespace_urn_braces_or_partial_input(self):
        for value in (" " + HEX, HEX + "\n", "urn:uuid:" + CANONICAL,
                      "{" + CANONICAL + "}", "", HEX[:-1], HEX + "0",
                      "g" * 32, "-" * 32, None, 123, [], b"x" * 16):
            with self.subTest(value=repr(value)):
                with self.assertRaises(ValueError):
                    codec.uuid_to_hex(value)

    def test_invalid_legacy_bytes_rejected(self):
        for value in (b"", b"0" * 15, b"0" * 17, HEX, bytearray(16), None):
            with self.assertRaises(ValueError):
                codec.binary_uuid_to_hex(value)

    def test_alias_collision_is_not_silently_deduplicated(self):
        for values in ([HEX, CANONICAL], [HEX, HEX.upper()], [HEX, HEX]):
            with self.assertRaises(ValueError):
                codec.normalize_uuid_list(values)

    def test_list_order_preserved(self):
        other = "01a01e0ef90574aa894eff02c02fd01a"
        self.assertEqual(codec.normalize_uuid_list([CANONICAL, other], require_v7=True),
                         [HEX, other])

    def test_nil_preserved_only_as_legacy_identity(self):
        self.assertEqual(codec.uuid_to_hex("0" * 32), "0" * 32)
        with self.assertRaises(ValueError):
            codec.uuid_to_hex("0" * 32, require_v7=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
