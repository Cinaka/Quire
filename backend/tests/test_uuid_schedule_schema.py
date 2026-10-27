"""Isolated actual schedule DTO definitions; not HTTP, SQL, locks or browser tests."""

import ast
import json
import unicodedata
import unittest
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from app.core.time import as_utc_naive
from app.core.uuid_hex import parse_uuid
from app.schemas.uuid_hex import UUIDHex
from app.services.schedule_content import schedule_content_text, trim_text
from app.services.schedule_review import ReviewReason

APP = Path(__file__).resolve().parents[1] / "app"
ID = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000001")
MEDIA = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000099")
COPY = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000098")
PLAN = uuid.UUID("0198f2a1-4b3c-7000-8000-000000000097")
AT = datetime(2026, 10, 8, 10, 0, 0, 123000)


def actual_schedule_dtos():
    """Keep original validators/type aliases; do not import application/ORM modules."""
    namespace = dict(
        __name__=__name__, ast=ast, json=json, unicodedata=unicodedata, uuid=uuid,
        date=date, datetime=datetime, Literal=Literal, BaseModel=BaseModel,
        ConfigDict=ConfigDict, Field=Field, ValidationError=ValidationError,
        field_validator=field_validator, model_validator=model_validator,
        as_utc_naive=as_utc_naive, parse_uuid=parse_uuid, UUIDHex=UUIDHex,
        schedule_content_text=schedule_content_text, trim_text=trim_text, ReviewReason=ReviewReason,
    )
    selected = [
        ("services/schedules.py", {"PendingScheduleRequest"}),
        ("services/schedule_deletion.py", {"TerminalScheduleDeletionRequest"}),
        ("services/schedule_conversion.py", {"ConversionEntrySnapshot", "ScheduleConvertRequest"}),
        ("services/schedule_tag_copies.py", {"IndependentTagCopy", "IndependentTagCopiesRequest",
                                           "name_key", "proof_key"}),
        ("api/v1/entries.py", {"EntryRequest", "EntryResponse"}),
        ("api/v1/schedules.py", {"ScheduleStatus", "ScheduleResponse"}),
        ("api/v1/schedule_sync.py", {"PendingPushItem", "TerminalDeletionPushItem", "item_id",
                                   "SchedulePushResult", "ScheduleChangesResponse"}),
        ("api/v1/schedule_conversion.py", {"ScheduleConvertResponse"}),
        ("api/v1/schedule_review.py", {"ScheduleTerminalReviewResponse"}),
        ("api/v1/schedule_resource_review.py", {
            "ResourceImageProof", "ResourceMediaProof", "ResourceTagProof",
            "ScheduleResourceReviewResponse",
        }),
        ("api/v1/schedule_resource_download.py", {"ImageVariant", "ImageMime",
                                                 "ScheduleResourceImageResponse"}),
        ("api/v1/schedule_tag_copies.py", {
            "IndependentTagPresence", "IndependentTagCopiesResponse",
        }),
    ]
    for relative, names in selected:
        path = APP / relative
        nodes, found = [], set()
        for node in ast.parse(path.read_text()).body:
            name = node.name if isinstance(node, (ast.ClassDef, ast.FunctionDef)) else None
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                name = node.targets[0].id if isinstance(node.targets[0], ast.Name) else None
            if name in names:
                nodes.append(node)
                found.add(name)
        if found != names:
            raise AssertionError(f"missing definitions in {relative}: {names - found}")
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)
    return namespace


class UUIDScheduleSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = actual_schedule_dtos()

    def schedule(self):
        return self.models["ScheduleResponse"](
            id=ID, remind_date=AT.date(), title=str(ID), content=None, content_text=str(ID),
            status="converted", converted_entry_id=ID, converted_at=AT,
            client_updated_at=AT, deleted_at=None, created_at=AT, updated_at=AT,
        )

    def review(self):
        return self.models["ScheduleTerminalReviewResponse"](
            reviewable=True, reason="terminal_review", schedule=self.schedule(), entry=None,
            entry_state="purged", receipt_known=True,
            first_entry_date=AT.date(), first_entry_deleted=False,
        )

    def snapshot(self, **changes):
        return {"id": ID.hex, "from_schedule_id": str(ID), "entry_date": AT.date(),
                "title": "首次转换", "content": None,
                "client_updated_at": "2026-10-08T10:00:00.124Z", **changes}

    def test_schedule_response_normalizes_identity_only(self):
        dto = self.schedule()
        self.assertEqual(dto.id, ID)
        data = dto.model_dump(mode="json")
        self.assertEqual((data["id"], data["converted_entry_id"]), (ID.hex, ID.hex))
        self.assertEqual((data["title"], data["content_text"]), (str(ID), str(ID)))

    def test_changes_cursor_and_nested_schedules_are_hex32(self):
        dto = self.models["ScheduleChangesResponse"](
            server_time=AT, sync_until=AT, cursor_id=ID,
            has_more=True, schedules=[self.schedule()],
        )
        data = dto.model_dump(mode="json")
        self.assertEqual(data["cursor_id"], data["schedules"][0]["id"])
        self.assertEqual(data["cursor_id"], ID.hex)

    def test_push_result_null_and_nested_conflict_snapshot(self):
        dto = self.models["SchedulePushResult"](
            index=0, id=ID, status="error", reason="conflict", message="不覆盖",
            current=self.schedule(),
        )
        self.assertEqual(dto.model_dump(mode="json")["current"]["id"], ID.hex)
        dto.id, dto.current = None, None
        self.assertIsNone(dto.model_dump(mode="json")["id"])

    def test_push_item_id_uses_strict_parser_even_for_error_echo(self):
        for value in [ID.hex, str(ID).upper(), ID]:
            self.assertEqual(self.models["item_id"]({"id": value}), ID)
        for value in ["urn:uuid:" + str(ID), "{" + str(ID) + "}", " " + ID.hex, 7]:
            self.assertIsNone(self.models["item_id"]({"id": value}))

    def test_pending_and_terminal_push_ids_keep_v7_guard(self):
        pending = {"remind_date": AT.date(), "title": "预简", "content": None,
                   "client_updated_at": AT}
        terminal = {"status": "converted", "expected_schedule_client_updated_at": AT,
                    "client_updated_at": "2026-10-08T10:00:00.124Z", "deleted_at": None}
        for name, body in [("PendingPushItem", pending), ("TerminalDeletionPushItem", terminal)]:
            dto = self.models[name](id=str(ID).upper(), **body)
            self.assertEqual(dto.model_dump(mode="json")["id"], ID.hex)
            for value in [uuid.uuid4(), "urn:uuid:" + str(ID), "bad"]:
                with self.subTest(model=name, value=value), self.assertRaises(ValidationError):
                    self.models[name](id=value, **body)

    def test_conversion_snapshot_normalizes_both_ids(self):
        dto = self.models["ConversionEntrySnapshot"](**self.snapshot())
        self.assertEqual(dto.id, dto.from_schedule_id)
        self.assertEqual(dto.model_dump(mode="json")["id"], ID.hex)
        self.assertEqual(dto.model_dump(mode="json")["from_schedule_id"], ID.hex)
        self.assertEqual(dto.model_dump()["id"], ID)

    def test_conversion_rejects_v4_and_extra_tags(self):
        for change in [{"id": uuid.uuid4()}, {"from_schedule_id": "urn:uuid:" + str(ID)},
                       {"tag_ids": [MEDIA.hex]}, {"user_id": ID.hex}]:
            with self.subTest(change=change), self.assertRaises(ValidationError):
                self.models["ConversionEntrySnapshot"](**self.snapshot(**change))

    def test_resource_proof_serializes_all_identity_lists_and_nested_fields(self):
        image = {"state": "verified", "size": 8, "mime": "image/png", "sha256": "a" * 64}
        dto = self.models["ScheduleResourceReviewResponse"](
            resource_state="verified", resources_complete=True, review=self.review(),
            media_ids=[MEDIA], tag_ids=[ID], missing_media_ids=[COPY], missing_tag_ids=[PLAN],
            media=[{"id": MEDIA, "entry_id": ID, "sort_order": 0, "width": 1, "height": 1,
                    "size": 8, "created_at": AT, "original": image, "thumbnail": image}],
            tags=[{"id": ID, "name": str(ID), "color": None, "created_at": AT}],
        )
        data = dto.model_dump(mode="json")
        self.assertEqual(data["media_ids"], [MEDIA.hex])
        self.assertEqual(data["tag_ids"], [ID.hex])
        self.assertEqual(data["missing_media_ids"], [COPY.hex])
        self.assertEqual(data["missing_tag_ids"], [PLAN.hex])
        self.assertEqual(data["media"][0]["entry_id"], ID.hex)
        self.assertEqual(data["media"][0]["id"], MEDIA.hex)
        self.assertEqual(data["tags"][0]["id"], ID.hex)
        self.assertEqual(data["tags"][0]["name"], str(ID))
        self.assertNotIn("url", data["media"][0])

    def test_download_response_ids_hex32_and_proof_flags_unchanged(self):
        dto = self.models["ScheduleResourceImageResponse"](
            schedule_id=ID, media_id=MEDIA, variant="original", size=1,
            mime="image/png", sha256="b" * 64, data_base64="YQ==",
        )
        data = dto.model_dump(mode="json")
        self.assertEqual((data["schedule_id"], data["media_id"]), (ID.hex, MEDIA.hex))
        self.assertTrue(data["read_only"])
        self.assertFalse(data["resolution_enabled"])

    def test_independent_copy_request_preserves_expected_proof_without_rewriting(self):
        proof = {"opaque": str(ID)}
        dto = self.models["IndependentTagCopiesRequest"](
            plan_id=PLAN.hex, choice="cloud-source-use-diary", confirmed=True,
            expected_resources=proof,
            copies=[{"from_tag_id": str(ID), "id": COPY.hex, "name": "独立", "color": None}],
        )
        data = dto.model_dump(mode="json")
        self.assertEqual(data["plan_id"], PLAN.hex)
        self.assertEqual(data["copies"][0]["from_tag_id"], ID.hex)
        self.assertEqual(data["copies"][0]["id"], COPY.hex)
        self.assertEqual(data["expected_resources"], proof)
        with self.assertRaises(ValidationError):
            self.models["IndependentTagCopiesRequest"](**{
                **data, "copies": data["copies"] + [{**data["copies"][0], "id": PLAN.hex}],
            })

    def test_independent_tag_presence_response_is_hex32(self):
        dto = self.models["IndependentTagCopiesResponse"](
            schedule_id=ID, plan_id=PLAN, tags=[{
                "from_tag_id": ID, "id": COPY, "name": "独立", "color": None,
                "created_at": AT, "created": True,
            }],
        )
        data = dto.model_dump(mode="json")
        self.assertEqual((data["schedule_id"], data["plan_id"]), (ID.hex, PLAN.hex))
        self.assertEqual(data["tags"][0]["from_tag_id"], ID.hex)
        self.assertEqual(data["tags"][0]["id"], COPY.hex)
        self.assertFalse(data["diary_sync_enabled"])

    def test_schedule_routes_use_explicit_uuid_wire_parameters(self):
        examined = 0
        for path in (APP / "api/v1").glob("schedule*.py"):
            for node in ast.walk(ast.parse(path.read_text())):
                if not isinstance(node, ast.AsyncFunctionDef) or not node.decorator_list:
                    continue
                for parameter in node.args.args:
                    if parameter.arg in {"schedule_id", "media_id", "after_id"}:
                        self.assertIn("UUIDHex", ast.unparse(parameter.annotation), str(path))
                        examined += 1
        self.assertEqual(examined, 10)


if __name__ == "__main__":
    unittest.main()
