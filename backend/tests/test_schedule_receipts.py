"""Pure first-intent receipt tests; runnable with standard-library unittest."""

import json
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone

from app.services.schedule_receipts import (
    conversion_receipt,
    entry_fingerprint,
    receipt_matches,
    valid_receipt,
)

AT = datetime(2026, 10, 8, 10, 0, 0, 123000)


def snapshot(**changes):
    body = {
        "id": "0198f2a1-4b3c-7000-8000-000000000001",
        "from_schedule_id": "0198f2a1-4b3c-7000-8000-000000000001",
        "entry_date": "2026-10-08", "sort_order": 0, "title": "私密原文标题",
        "content": {"schemaVersion": 1, "doc": {"type": "doc", "content": []}},
        "deleted_at": None, "client_updated_at": "2026-10-08T10:00:00.124Z",
    }
    body.update(changes)
    return body


class ConversionReceiptTests(unittest.TestCase):
    def test_receipt_is_valid_and_same_payload_matches(self):
        body = snapshot()
        receipt = conversion_receipt(AT, body)
        self.assertTrue(valid_receipt(receipt))
        self.assertTrue(receipt_matches(receipt, AT, body))

    def test_receipt_has_no_title_or_body_copy(self):
        receipt = conversion_receipt(AT, snapshot())
        encoded = json.dumps(receipt, ensure_ascii=False)
        self.assertNotIn("私密原文标题", encoded)
        self.assertNotIn('"content"', encoded)
        self.assertEqual(len(receipt["fingerprint"]), 64)

    def test_selected_date_difference_is_conflict(self):
        body = snapshot()
        receipt = conversion_receipt(AT, body)
        self.assertFalse(receipt_matches(receipt, AT, snapshot(entry_date="2026-10-07")))

    def test_expected_source_revision_difference_is_conflict(self):
        body = snapshot()
        later = AT + timedelta(milliseconds=1)
        self.assertFalse(receipt_matches(conversion_receipt(AT, body), later, body))

    def test_title_and_content_difference_are_not_silently_equivalent(self):
        receipt = conversion_receipt(AT, snapshot())
        for body in [snapshot(title="另一原稿"), snapshot(content=None)]:
            self.assertFalse(receipt_matches(receipt, AT, body))

    def test_metadata_clocks_ordering_and_derived_text_do_not_change_business_intent(self):
        body = snapshot()
        receipt = conversion_receipt(AT, body)
        later = snapshot(
            sort_order=8, client_updated_at="2026-10-09T10:00:00.000Z", content_text="不信任",
        )
        self.assertTrue(receipt_matches(receipt, AT, later))

    def test_utc_offset_represents_the_same_source_revision(self):
        offset = AT.replace(tzinfo=timezone.utc).astimezone(timezone(timedelta(hours=8)))
        self.assertTrue(receipt_matches(conversion_receipt(AT, snapshot()), offset, snapshot()))

    def test_deleted_and_active_intents_are_not_equivalent(self):
        body = snapshot()
        deleted = snapshot(deleted_at=AT.isoformat())
        self.assertFalse(receipt_matches(conversion_receipt(AT, body), AT, deleted))

    def test_two_deleted_timestamp_metadata_values_keep_same_visibility_intent(self):
        body = snapshot(deleted_at=AT.isoformat())
        receipt = conversion_receipt(AT, body)
        self.assertTrue(receipt_matches(receipt, AT, snapshot(deleted_at="2026-10-09T10:00:00Z")))

    def test_unknown_missing_or_malformed_receipts_do_not_authorize_replay(self):
        original = conversion_receipt(AT, snapshot())
        for receipt in [None, {}, original | {"version": 2}, original | {"version": True},
                        original | {"source_client_updated_at": "bad"},
                        original | {"entry_date": "2026-02-29"}, original | {"fingerprint": "bad"},
                        original | {"deleted": 1}, original | {"extra": "unknown"}]:
            with self.subTest(receipt=receipt):
                self.assertIsNone(receipt_matches(receipt, AT, snapshot()))

    def test_object_key_order_is_semantically_irrelevant_but_json_types_are_not(self):
        body = snapshot(content={"a": 1, "b": "原文"})
        reordered = snapshot(content={"b": "原文", "a": 1})
        self.assertEqual(entry_fingerprint(body), entry_fingerprint(reordered))
        different = snapshot(content={"a": True, "b": "原文"})
        self.assertNotEqual(entry_fingerprint(body), entry_fingerprint(different))

    def test_verification_does_not_mutate_receipt_or_input(self):
        body = snapshot()
        receipt = conversion_receipt(AT, body)
        originals = deepcopy((receipt, body))
        receipt_matches(receipt, AT, body)
        self.assertEqual((receipt, body), originals)
