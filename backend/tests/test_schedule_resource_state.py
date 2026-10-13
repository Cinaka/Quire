"""Dependency-free bounded image proof and reference tests; not HTTP/MySQL acceptance."""

import hashlib
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.schedule_resource_review import (  # noqa: E402
    MAX_IMAGE_BYTES,
    current_resource_ids,
    probe_image,
    stored_relative_path,
)

ID = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000099")
PNG = b"\x89PNG\r\n\x1a\n" + b"test image bytes"


class ResourceProofTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.relative = Path(ID.hex[:4]) / f"{ID}.png"
        self.path = self.root / self.relative
        self.path.parent.mkdir()
        self.path.write_bytes(PNG)

    def tearDown(self):
        self.temp.cleanup()

    def test_original_bytes_hash_and_count(self):
        proof = probe_image(self.root, self.relative, "image/png")
        self.assertEqual(proof.state, "verified")
        self.assertEqual(proof.sha256, hashlib.sha256(PNG).hexdigest())
        self.assertEqual(proof.size, len(PNG))

    def test_no_resource_url_or_path_in_proof(self):
        proof = probe_image(self.root, self.relative, "image/png")
        self.assertNotIn(str(self.root), repr(proof))
        self.assertNotIn(str(ID), repr(proof))

    def test_supported_signatures_are_not_guessed_from_extension(self):
        for data, mime in [(b"\xff\xd8\xffx", "image/jpeg"), (b"GIF89ax", "image/gif"),
                           (b"RIFFxxxxWEBPx", "image/webp")]:
            with self.subTest(mime=mime):
                self.path.write_bytes(data)
                self.assertEqual(probe_image(self.root, self.relative, mime).state, "verified")
        self.path.write_bytes(b"not an image")
        self.assertEqual(probe_image(self.root, self.relative, "image/png").state, "unavailable")

    def test_mime_mismatch_is_not_a_digest_proof(self):
        self.assertEqual(probe_image(self.root, self.relative, "image/jpeg").state, "unavailable")

    def test_invalid_bytes_still_count_against_the_read_budget(self):
        self.path.write_bytes(b"invalid content")
        proof = probe_image(self.root, self.relative, "image/png")
        self.assertEqual(proof.state, "unavailable")
        self.assertEqual(proof.read_bytes, len(b"invalid content"))

    def test_valid_proof_reports_internal_bytes_without_increasing_public_size(self):
        proof = probe_image(self.root, self.relative, "image/png")
        self.assertEqual(proof.read_bytes, len(PNG))
        self.assertEqual(proof.size, len(PNG))

    def test_empty_file_is_not_complete(self):
        self.path.write_bytes(b"")
        self.assertEqual(probe_image(self.root, self.relative, "image/png").state, "unavailable")

    def test_missing_file_is_distinct_from_unverified(self):
        self.path.unlink()
        self.assertEqual(probe_image(self.root, self.relative, "image/png").state, "missing")

    def test_budget_stops_reads_before_large_file(self):
        self.assertEqual(probe_image(self.root, self.relative, "image/png", 1).state, "unavailable")
        with self.path.open("wb") as file:
            file.truncate(MAX_IMAGE_BYTES + 1)
        self.assertEqual(probe_image(self.root, self.relative, "image/png").state, "unavailable")

    def test_absolute_and_traversal_paths_rejected(self):
        for path in [self.path, Path("../private.png")]:
            with self.subTest(path=str(path)):
                self.assertEqual(probe_image(self.root, path, "image/png").state, "unavailable")

    def test_file_symlink_is_never_followed(self):
        target = self.root / "private.png"
        target.write_bytes(PNG)
        self.path.unlink()
        self.path.symlink_to(target)
        self.assertEqual(probe_image(self.root, self.relative, "image/png").state, "unavailable")

    def test_directory_symlink_is_never_followed(self):
        outside = self.root / "elsewhere"
        outside.mkdir()
        self.path.unlink()
        self.path.parent.rmdir()
        self.path.parent.symlink_to(outside, target_is_directory=True)
        (outside / self.path.name).write_bytes(PNG)
        self.assertEqual(probe_image(self.root, self.relative, "image/png").state, "unavailable")

    def test_nonregular_file_never_blocks_reader(self):
        self.path.unlink()
        os.mkfifo(self.path)
        self.assertEqual(probe_image(self.root, self.relative, "image/png").state, "unavailable")

    def test_permission_error_has_no_private_diagnostics(self):
        with patch("os.open", side_effect=PermissionError("private server path")):
            proof = probe_image(self.root, self.relative, "image/png")
        self.assertEqual(proof.state, "unavailable")
        self.assertNotIn("private", repr(proof))

    def test_same_length_mutation_is_not_accepted(self):
        original = os.read
        changed = False

        def changing_read(fd, size):
            nonlocal changed
            data = original(fd, size)
            if not changed:
                changed = True
                self.path.write_bytes(PNG[:-1] + b"X")
            return data

        with patch("os.read", side_effect=changing_read):
            self.assertEqual(
                probe_image(self.root, self.relative, "image/png").state, "unavailable",
            )

    def test_public_path_matches_only_original_upload_identity(self):
        url = f"/media/{ID.hex[:4]}/{ID}.png"
        self.assertEqual(stored_relative_path(url, "/media", ID)[0], self.relative)
        for bad in [url + "?token=private", "/media/../private.png", "https://outside/image"]:
            with self.subTest(url=bad):
                self.assertIsNone(stored_relative_path(bad, "/media", ID))
        self.assertIsNone(stored_relative_path(url, "/media", ID, thumbnail=True))

    def test_current_reference_collection_is_sorted_and_deduplicated(self):
        node = {"type": "image", "attrs": {"src": f"local://media/{ID}"}}
        body = {"schemaVersion": 1, "doc": {"type": "doc", "content": [node, node]}}
        self.assertEqual(current_resource_ids(body, [ID, ID]), ([ID], [ID]))
        self.assertEqual(current_resource_ids(None, []), ([], []))

    def test_future_and_external_content_not_downgraded(self):
        for body in [
            {"schemaVersion": 999, "doc": {"type": "doc"}},
            {"schemaVersion": 1, "doc": {"type": "doc", "content": [
                {"type": "image", "attrs": {"src": "https://private/image"}},
            ]}},
        ]:
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    current_resource_ids(body, [])

    def test_invalid_and_non_v7_tags_fail_closed(self):
        for value in ["bad", uuid.uuid4()]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    current_resource_ids(None, [value])

    def test_resource_and_depth_limits(self):
        ids = [uuid.UUID(f"0198f2a1-4b3c-7000-8000-{i:012x}") for i in range(65)]
        with self.assertRaises(ValueError):
            current_resource_ids(None, ids)
        deep = {"type": "doc"}
        for _ in range(70):
            deep = {"type": "doc", "child": deep}
        with self.assertRaises(ValueError):
            current_resource_ids({"schemaVersion": 1, "doc": deep}, [])


if __name__ == "__main__":
    unittest.main()
