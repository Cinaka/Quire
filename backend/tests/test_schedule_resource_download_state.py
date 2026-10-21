"""Bounded file tests and actual-handler simulation; Pydantic, but no HTTP/SQL runner."""

import ast
import asyncio
import base64
import hashlib
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Literal
from unittest.mock import patch

from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.schedule_resource_review import (  # noqa: E402
    MAX_IMAGE_BYTES,
    current_resource_ids,
    read_expected_image,
    stored_relative_path,
)

ID = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000001")
MEDIA_ID = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000099")
OWNER = uuid.UUID("0198f2a1-4b3c-7000-8000-abcdef123456")
PNG = b"\x89PNG\r\n\x1a\n" + b"safe image test bytes"
DIGEST = hashlib.sha256(PNG).hexdigest()


class ImageDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.relative = Path(MEDIA_ID.hex[:4]) / f"{MEDIA_ID}.png"
        self.path = self.root / self.relative
        self.path.parent.mkdir()
        self.path.write_bytes(PNG)

    def tearDown(self):
        self.temp.cleanup()

    def read(self, **changes):
        values = dict(root=self.root, relative=self.relative, expected_mime="image/png",
                      expected_size=len(PNG), expected_sha256=DIGEST)
        values.update(changes)
        return read_expected_image(**values)

    def denied(self, **changes):
        result = self.read(**changes)
        self.assertNotEqual(result.proof.state, "verified")
        self.assertIsNone(result.data)
        return result

    def test_bytes_and_proof_come_from_one_descriptor_read(self):
        original = os.open
        opened = []

        def track(*args, **kwargs):
            opened.append(args[0])
            return original(*args, **kwargs)

        with patch("app.services.schedule_resource_review.os.open", side_effect=track):
            result = self.read()
        self.assertEqual(result.data, PNG)
        self.assertEqual(result.proof.sha256, DIGEST)
        self.assertEqual(result.proof.size, len(PNG))
        self.assertEqual(opened.count(self.relative.name), 1)

    def test_mismatch_never_returns_bytes_or_a_new_authorizing_digest(self):
        result = self.denied(expected_sha256="0" * 64)
        self.assertIsNone(result.proof.sha256)

    def test_invalid_request_limits_reject_before_opening_any_file(self):
        for values in [{"expected_size": 0}, {"expected_size": True},
                       {"expected_size": MAX_IMAGE_BYTES + 1},
                       {"expected_sha256": DIGEST.upper()}, {"expected_sha256": "bad"}]:
            with self.subTest(values=values):
                with patch("app.services.schedule_resource_review.os.open") as opened:
                    self.denied(**values)
                    opened.assert_not_called()

    def test_short_and_long_claimed_sizes_cannot_authorize_partial_content(self):
        self.denied(expected_size=len(PNG) - 1)
        self.denied(expected_size=len(PNG) + 1)

    def test_missing_file_has_no_bytes(self):
        self.path.unlink()
        self.assertEqual(self.denied().proof.state, "missing")

    def test_empty_file_has_no_bytes(self):
        self.path.write_bytes(b"")
        self.denied()

    def test_mime_mismatch_has_no_bytes(self):
        self.denied(expected_mime="image/jpeg")

    def test_fake_signature_has_no_bytes_even_with_matching_hash(self):
        self.path.write_bytes(b"x" * len(PNG))
        self.denied(expected_sha256=hashlib.sha256(self.path.read_bytes()).hexdigest())

    def test_absolute_and_traversal_paths_are_never_opened(self):
        for relative in [self.path, Path("../private.png")]:
            with self.subTest(relative=relative):
                self.denied(relative=relative)

    def test_file_symlink_is_not_followed(self):
        private = self.root / "private.png"
        private.write_bytes(PNG)
        self.path.unlink()
        self.path.symlink_to(private)
        self.denied()

    def test_parent_symlink_is_not_followed(self):
        target = self.root / "other"
        self.path.parent.rename(target)
        self.path.parent.symlink_to(target, target_is_directory=True)
        self.denied()

    def test_fifo_is_rejected_without_blocking(self):
        self.path.unlink()
        os.mkfifo(self.path)
        self.denied()

    def test_directory_is_not_an_image(self):
        self.path.unlink()
        self.path.mkdir()
        self.denied()

    def test_growth_during_read_discards_every_captured_byte(self):
        self.race(lambda: self.path.write_bytes(PNG + b"extra"))

    def test_truncation_during_read_discards_every_captured_byte(self):
        self.race(lambda: self.path.write_bytes(PNG[:9]))

    def test_same_size_mutation_discards_every_captured_byte(self):
        def change():
            before = self.path.stat()
            self.path.write_bytes(PNG[:-1] + b"!")
            os.utime(self.path, ns=(before.st_atime_ns, before.st_mtime_ns + 1000000))
        self.race(change)

    def test_replacement_after_read_discards_every_captured_byte(self):
        def replace():
            other = self.path.with_suffix(".new")
            other.write_bytes(PNG)
            other.replace(self.path)
        self.race(replace)

    def race(self, change):
        original = os.read
        changed = False

        def read(fd, size):
            nonlocal changed
            block = original(fd, size)
            if block and not changed:
                changed = True
                change()
            return block
        with patch("app.services.schedule_resource_review.os.read", side_effect=read):
            self.denied()
        self.assertTrue(changed)

    def test_all_opened_descriptors_close_on_success_and_failure(self):
        original_open, original_close = os.open, os.close
        for digest in [DIGEST, "0" * 64]:
            opened, closed = [], []

            def opening(*args, target=opened, **kwargs):
                fd = original_open(*args, **kwargs)
                target.append(fd)
                return fd

            def closing(fd, target=closed):
                target.append(fd)
                return original_close(fd)
            with patch("app.services.schedule_resource_review.os.open", side_effect=opening), \
                    patch("app.services.schedule_resource_review.os.close", side_effect=closing):
                self.read(expected_sha256=digest)
            self.assertEqual(closed, list(reversed(opened)))

    def test_large_multiblock_read_returns_exact_bytes(self):
        data = PNG + b"x" * (1024 * 1024)
        self.path.write_bytes(data)
        result = self.read(
            expected_size=len(data), expected_sha256=hashlib.sha256(data).hexdigest(),
        )
        self.assertEqual(result.data, data)

    def test_oversized_disk_file_rejected_before_read(self):
        with self.path.open("wb") as file:
            file.truncate(MAX_IMAGE_BYTES + 1)
        with patch("app.services.schedule_resource_review.os.read") as read:
            self.denied()
            read.assert_not_called()


class SimulatedHTTPError(Exception):
    def __init__(self, status_code, detail, headers=None):
        super().__init__(detail)
        self.status_code, self.headers = status_code, headers


class SimulatedOperationalError(Exception):
    def __init__(self, code):
        self.orig = SimpleNamespace(args=(code,))


class Column:
    def __init__(self, name):
        self.name = name

    def __eq__(self, value):
        return self.name, value


class Select:
    def __init__(self):
        self.conditions = []
        self.locked = False

    def where(self, *conditions):
        self.conditions.extend(conditions)
        return self

    def with_for_update(self):
        self.locked = True
        return self


def actual_handler(root):
    """Compile the unchanged endpoint/model AST; stubs replace only unavailable framework/SQL."""
    path = Path(__file__).resolve().parents[1] / "app/api/v1/schedule_resource_download.py"
    tree = ast.parse(path.read_text())
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef,
                                                           ast.ClassDef))]
    for node in nodes:
        node.decorator_list = []
        if isinstance(node, ast.AsyncFunctionDef):
            node.args.defaults = []
            for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]:
                arg.annotation = None
            node.returns = None
    db = SimpleNamespace(rollbacks=0, commits=0, flushes=0, queries=[], source=object(),
                         readable=True, missing_entry=False, collision=False, fail_lock=None)
    entry = SimpleNamespace(content={"schemaVersion": 1, "doc": {"type": "doc", "content": [
        {"type": "image", "attrs": {"src": f"local://media/{MEDIA_ID}"}},
    ]}})
    db.source = SimpleNamespace(status=1)
    db.entry = entry
    db.media = SimpleNamespace(id=MEDIA_ID, user_id=OWNER, entry_id=ID, size=len(PNG),
                               url=f"/media/{MEDIA_ID.hex[:4]}/{MEDIA_ID}.png", thumb_url=None)

    async def scalar(query):
        db.queries.append(query)
        return db.media if all(getattr(db.media, key) == value
                               for key, value in query.conditions) else None

    async def rollback():
        db.rollbacks += 1

    async def owner_lock(*_args):
        if db.fail_lock:
            raise SimulatedOperationalError(db.fail_lock)

    async def source(*_args):
        return db.source

    async def linked(*_args):
        return None if db.missing_entry else db.entry, db.collision

    async def thread(function, *args):
        db.disk_calls += 1
        return function(*args)

    db.scalar, db.rollback, db.disk_calls = scalar, rollback, 0
    env = dict(base64=base64, uuid=uuid, Literal=Literal, BaseModel=BaseModel,
               ImageVariant=Literal["original", "thumbnail"],
               ImageMime=Literal["image/png", "image/jpeg", "image/webp", "image/gif"],
               HTTPException=SimulatedHTTPError, OperationalError=SimulatedOperationalError,
               PRIVATE_HEADERS={"Cache-Control": "no-store", "Pragma": "no-cache"},
               ScheduleWriteOwner=lambda value: SimpleNamespace(id=value),
               lock_schedule_owner=owner_lock, locked_schedule=source, linked_diary=linked,
               terminal_review_state=lambda *_args: SimpleNamespace(
                   reviewable=db.readable and not db.collision, receipt_known=db.readable),
               current_resource_ids=current_resource_ids, stored_relative_path=stored_relative_path,
               read_expected_image=read_expected_image, run_in_threadpool=thread,
               settings=SimpleNamespace(MEDIA_ROOT=root, MEDIA_PUBLIC_PREFIX="/media"),
               select=lambda _model: Select(), Media=SimpleNamespace(
                   id=Column("id"), user_id=Column("user_id"), entry_id=Column("entry_id")),
               ok=lambda value: value.model_dump(mode="json"))
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), env)
    return db, env["download_current_resource_image"]


class DownloadHandlerSimulationTests(unittest.TestCase):
    def invoke(self, **changes):
        values = dict(schedule_id=ID, media_id=MEDIA_ID, variant="original",
                      response=SimpleNamespace(headers={}), expected_size=len(PNG),
                      expected_mime="image/png", expected_sha256=DIGEST,
                      user=SimpleNamespace(id=OWNER), db=self.db)
        values.update(changes)
        self.response = values["response"]
        return asyncio.run(self.handler(**values))

    def setUp(self):
        ImageDownloadTests.setUp(self)
        self.db, self.handler = actual_handler(self.root)

    def tearDown(self):
        ImageDownloadTests.tearDown(self)

    def expect_error(self, status, **changes):
        with self.assertRaises(SimulatedHTTPError) as caught:
            self.invoke(**changes)
        self.assertEqual(caught.exception.status_code, status)
        self.assertEqual(caught.exception.headers["Cache-Control"], "no-store")
        self.assertEqual((self.db.commits, self.db.flushes), (0, 0))

    def test_handler_success_is_scoped_locked_read_with_private_response(self):
        payload = self.invoke()
        self.assertEqual(base64.b64decode(payload["data_base64"]), PNG)
        self.assertFalse(payload["resolution_enabled"])
        self.assertEqual(payload["proof_scope"], "current_entry_image_bytes")
        self.assertEqual(self.response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.db.rollbacks, 1)
        self.assertTrue(self.db.queries[0].locked)
        self.assertEqual(self.db.queries[0].conditions,
                         [("id", MEDIA_ID), ("user_id", OWNER), ("entry_id", ID)])

    def test_handler_foreign_media_never_reaches_disk(self):
        self.db.media.user_id = uuid.uuid4()
        self.expect_error(404)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_wrong_entry_binding_never_reaches_disk(self):
        self.db.media.entry_id = uuid.uuid4()
        self.expect_error(404)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_unreferenced_media_never_reaches_disk(self):
        self.db.entry.content = None
        self.expect_error(404)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_unknown_receipt_never_reaches_disk(self):
        self.db.readable = False
        self.expect_error(409)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_purged_entry_never_reaches_disk(self):
        self.db.missing_entry = True
        self.expect_error(409)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_collision_never_reaches_disk(self):
        self.db.collision = True
        self.expect_error(409)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_missing_source_never_reaches_disk(self):
        self.db.source = None
        self.expect_error(404)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_missing_thumb_never_reaches_disk(self):
        self.expect_error(404, variant="thumbnail")
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_unsafe_stored_url_never_reaches_disk(self):
        self.db.media.url = "https://private.example/x?token=secret"
        self.expect_error(409)
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_stale_size_or_mime_never_reaches_disk(self):
        self.expect_error(409, expected_size=len(PNG) + 1)
        self.expect_error(409, expected_mime="image/jpeg")
        self.assertEqual(self.db.disk_calls, 0)

    def test_handler_stale_digest_returns_no_data(self):
        self.expect_error(409, expected_sha256="0" * 64)
        self.assertEqual(self.db.disk_calls, 1)

    def test_handler_lock_conflict_rolls_back_without_private_sql(self):
        self.db.fail_lock = 1213
        self.expect_error(409)
        self.assertEqual(self.db.rollbacks, 1)
        self.assertEqual(self.db.disk_calls, 0)

