"""Pure UUID32 resource references, exact paths and immutable v1 receipt regressions."""

import unittest
import uuid
from copy import deepcopy
from datetime import datetime
from pathlib import Path

from app.services.schedule_receipts import conversion_receipt, entry_fingerprint, receipt_matches
from app.services.schedule_resource_review import current_resource_ids, stored_relative_path

ID = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000001")
OTHER = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000002")
AT = datetime(2026, 10, 8, 10, 0, 0, 123000)
# Frozen using the pre-UUID32 version 1 implementation, not the current helper.
LEGACY_DIGEST = "f85cbcf0fcad19648c9db22ee5cfab71decea5b61a9111e6e7db69e3b424bdd2"


def snapshot(**changes):
    return {"id": str(ID), "from_schedule_id": str(ID), "entry_date": "2026-10-08",
            "title": f"原文含 {ID}", "content": None, "deleted_at": None, **changes}


def document(*identifiers):
    return {"schemaVersion": 1, "doc": {"type": "doc", "content": [
        {"type": "image", "attrs": {"src": "local://media/" + value}}
        for value in identifiers
    ]}}


class UUIDScheduleResourceTests(unittest.TestCase):
    def test_exact_hex32_and_legacy_references_are_the_same_identity(self):
        body = document(ID.hex, str(ID), ID.hex.upper(), str(ID).upper())
        before = deepcopy(body)
        self.assertEqual(current_resource_ids(body, [ID.hex, str(ID), ID]), ([ID], [ID]))
        self.assertEqual(body, before)

    def test_bad_image_identity_is_not_guessed_or_decoded(self):
        for value in ["urn:uuid:" + str(ID), "{" + str(ID) + "}", " " + ID.hex,
                      ID.hex + "/original", ID.hex + "?token=secret", "%30" + ID.hex[1:],
                      str(uuid.uuid4()), ID.hex + "\n"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                current_resource_ids(document(value), [])

    def test_tags_use_the_same_strict_uuid_boundary(self):
        for value in ["urn:uuid:" + str(ID), "{" + str(ID) + "}", " " + ID.hex]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                current_resource_ids(None, [value])

    def test_resource_aliases_do_not_expand_id_budget_or_change_sort(self):
        media, tags = current_resource_ids(
            document(OTHER.hex, str(ID), ID.hex, str(OTHER)), [OTHER.hex, str(ID), ID.hex],
        )
        self.assertEqual(media, [ID, OTHER])
        self.assertEqual(tags, [ID, OTHER])

    def test_exact_hex32_and_legacy_disk_paths_are_both_scoped(self):
        for spelling in [ID.hex, str(ID)]:
            for thumbnail in [False, True]:
                stem = spelling + ("_thumb" if thumbnail else "")
                url = f"/media/{ID.hex[:4]}/{stem}.png"
                self.assertEqual(stored_relative_path(url, "/media", ID, thumbnail=thumbnail),
                                 (Path(ID.hex[:4]) / (stem + ".png"), "image/png"))

    def test_path_matching_does_not_relax_prefix_shard_identity_or_suffix(self):
        good = f"/media/{ID.hex[:4]}/{ID.hex}.png"
        bad = [good + "?token=secret", good + "#fragment", good.replace(ID.hex, OTHER.hex),
               good.replace("/0198/", "/ffff/"), good.replace("/media/", "/other/"),
               good.replace(".png", ".svg"), good.replace("/0198/", "/../"),
               "https://outside" + good, good.replace(ID.hex, ID.hex.upper())]
        for value in bad:
            with self.subTest(url=value):
                self.assertIsNone(stored_relative_path(value, "/media", ID))
        self.assertIsNone(stored_relative_path(good, "/media", "bad"))
        self.assertIsNone(stored_relative_path(good, "/media", ID, thumbnail=True))

    def test_v1_receipt_digest_keeps_the_frozen_legacy_hash(self):
        self.assertEqual(entry_fingerprint(snapshot()), LEGACY_DIGEST)
        for spelling in [ID.hex, ID.hex.upper(), str(ID).upper(), ID]:
            self.assertEqual(entry_fingerprint(snapshot(id=spelling, from_schedule_id=spelling)),
                             LEGACY_DIGEST)

    def test_conversion_replay_does_not_conflict_only_because_uuid_spelling_changed(self):
        receipt = conversion_receipt(AT, snapshot())
        before = deepcopy(receipt)
        self.assertEqual(receipt["version"], 1)
        self.assertTrue(receipt_matches(receipt, AT, snapshot(id=ID.hex, from_schedule_id=ID.hex)))
        self.assertEqual(receipt, before)

    def test_real_identity_and_ordinary_text_changes_are_still_conflicts(self):
        receipt = conversion_receipt(AT, snapshot())
        for body in [snapshot(id=OTHER.hex), snapshot(from_schedule_id=OTHER.hex),
                     snapshot(title=f"原文含 {ID.hex}"),
                     snapshot(content={"text": ID.hex})]:
            self.assertFalse(receipt_matches(receipt, AT, body))

    def test_receipt_hash_does_not_normalize_media_references_in_user_content(self):
        receipt = conversion_receipt(AT, snapshot(content=document(str(ID))))
        self.assertFalse(receipt_matches(receipt, AT, snapshot(content=document(ID.hex))))


if __name__ == "__main__":
    unittest.main()
