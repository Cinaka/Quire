"""Pure review classification; runnable with standard-library unittest."""

import unittest
import uuid
from copy import deepcopy
from datetime import datetime
from types import SimpleNamespace

from app.services.schedule_receipts import conversion_receipt
from app.services.schedule_review import terminal_review_state

ID = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000001")
OTHER = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000002")
AT = datetime(2026, 10, 8, 10, 0, 0, 123000)


def source(**changes):
    receipt = conversion_receipt(AT, {
        "id": str(ID), "from_schedule_id": str(ID), "entry_date": "2026-10-09",
        "title": "首次文字", "content": None, "deleted_at": None,
    })
    values = {
        "id": ID, "user_id": OTHER, "status": 1, "converted_entry_id": ID,
        "converted_at": AT, "converted_receipt": receipt, "deleted_at": None,
    }
    return SimpleNamespace(**(values | changes))


def entry(**changes):
    return SimpleNamespace(**({
        "id": ID, "user_id": OTHER, "from_schedule_id": ID, "deleted_at": None,
        "title": "后来编辑", "entry_date": "2026-10-07",
    } | changes))


class TerminalReviewStateTests(unittest.TestCase):
    def test_known_active_identity(self):
        state = terminal_review_state(source(), entry())
        self.assertTrue(state.reviewable and state.receipt_known)
        self.assertEqual(state.entry_state, "active")

    def test_first_date_and_deletion_do_not_follow_current_diary(self):
        state = terminal_review_state(source(), entry(deleted_at=AT))
        self.assertEqual(state.first_entry_date, "2026-10-09")
        self.assertFalse(state.first_entry_deleted)
        self.assertEqual(state.entry_state, "deleted")

    def test_physically_missing_entry_is_purged_not_new_content(self):
        self.assertEqual(terminal_review_state(source(), None).entry_state, "purged")

    def test_source_deletion_is_independent_of_diary(self):
        state = terminal_review_state(source(deleted_at=AT), entry())
        self.assertEqual(state.entry_state, "active")

    def test_unknown_receipt_has_no_inferred_summary(self):
        for raw in [None, {}, {"version": 999, "private": "preserve"}]:
            state = terminal_review_state(source(converted_receipt=raw), entry())
            self.assertFalse(state.reviewable or state.receipt_known)
            self.assertIsNone(state.first_entry_date)
            self.assertIsNone(state.first_entry_deleted)
            self.assertEqual(state.reason, "receipt_unknown")

    def test_missing_receipt_still_reports_purged(self):
        state = terminal_review_state(source(converted_receipt=None), None)
        self.assertEqual((state.reason, state.entry_state), ("receipt_unknown", "purged"))

    def test_pending_does_not_convert(self):
        row = source(status=0, converted_entry_id=None, converted_at=None, converted_receipt=None)
        before = deepcopy(vars(row))
        self.assertEqual(terminal_review_state(row, None).reason, "not_terminal")
        self.assertEqual(vars(row), before)

    def test_invalid_pending_and_unknown_status(self):
        for row in [source(status=0), source(status=9)]:
            self.assertEqual(terminal_review_state(row, None).reason, "invalid_state")

    def test_missing_terminal_time_or_wrong_binding(self):
        for row in [source(converted_at=None), source(converted_entry_id=OTHER)]:
            self.assertEqual(terminal_review_state(row, entry()).reason, "identity_conflict")

    def test_collisions_and_foreign_ownership_are_not_attached(self):
        for diary, collision in [
            (entry(), True), (entry(id=OTHER), False),
            (entry(from_schedule_id=OTHER), False), (entry(user_id=ID), False),
        ]:
            self.assertEqual(
                terminal_review_state(source(), diary, collision).reason, "identity_conflict",
            )

    def test_known_receipt_is_not_local_intent_confirmation(self):
        state = terminal_review_state(source(), entry())
        self.assertTrue(state.receipt_known)
        self.assertFalse(hasattr(state, "confirmed") or hasattr(state, "created"))

    def test_read_does_not_rewrite_first_receipt_for_unknown_rich_content(self):
        row = source()
        before = deepcopy(vars(row))
        state = terminal_review_state(row, entry(content={"schemaVersion": 999}))
        self.assertTrue(state.reviewable)
        self.assertEqual(vars(row), before)
