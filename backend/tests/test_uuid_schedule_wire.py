"""Actual ASGI/SQLite UUID32 schedule contracts; not MySQL lock integration."""

from copy import deepcopy

import pytest
from test_schedule_convert import client_fixture, converted, request
from test_schedule_resource_download import expected
from test_schedule_resource_review import resource_fixture
from test_schedule_tag_copies import COPY, PLAN
from test_schedule_tag_copies import request as tag_copy_request
from test_schedule_writes import ID, OTHER_USER_ID, api_client, payload, stored, success

from app.models.diary_entry import DiaryEntry
from app.models.media import Media
from app.models.schedule import Schedule

BASE = "/api/v1/schedules"


@pytest.mark.parametrize("identifier", [ID.hex, str(ID), str(ID).upper()])
def test_schedule_write_and_detail_reply_with_the_same_hex32_id(identifier):
    with api_client() as (client, db):
        body = payload(title=str(ID))
        created = success(client.put(f"{BASE}/{identifier}", json=body))
        detail = success(client.get(f"{BASE}/{identifier}"))
        assert created["id"] == detail["id"] == ID.hex
        assert detail["title"] == str(ID)
        assert detail["converted_entry_id"] is None
        assert db.session.get(Schedule, ID).id == ID and db.commits == 1


def test_pending_conflict_snapshot_is_hex32_and_does_not_overwrite():
    with api_client([stored()]) as (client, db):
        response = client.put(f"{BASE}/{ID.hex}", json=payload(title="同修订不同内容"))
        assert response.status_code == 409
        assert response.json()["data"]["current"]["id"] == ID.hex
        assert db.session.get(Schedule, ID).title == "预简" and db.commits == 0


def test_push_strict_error_echo_does_not_abort_valid_neighbors():
    bad = ["urn:uuid:" + str(ID), "{" + str(ID) + "}", " " + ID.hex]
    with api_client() as (client, db):
        data = success(client.post(f"{BASE}/sync/push", json={"schedules": [
            {"id": value, **payload()} for value in [ID.hex, *bad, str(ID)]
        ]}))
        items = data["schedules"]
        assert [item["reason"] for item in items] == [
            "applied", "invalid", "invalid", "invalid", "replayed",
        ]
        assert items[0]["id"] == items[-1]["id"] == ID.hex
        assert items[0]["current"]["id"] == ID.hex
        assert all(item["id"] is None for item in items[1:-1])
        assert db.commits == 1


def test_changes_cursor_roundtrips_hex32_without_losing_equal_revision_rows():
    with api_client([stored(), stored(id=OTHER_USER_ID)]) as (client, db):
        first = success(client.get(f"{BASE}/sync/changes", params={"limit": 1}))
        assert first["has_more"] is True and first["cursor_id"] == ID.hex
        second = success(client.get(f"{BASE}/sync/changes", params={
            "limit": 1, "since": first["server_time"], "after_id": first["cursor_id"],
            "until": first["sync_until"],
        }))
        assert [first["schedules"][0]["id"], second["schedules"][0]["id"]] == [
            ID.hex, OTHER_USER_ID.hex,
        ]
        assert second["cursor_id"] is None and db.commits == 0


def test_conversion_replays_across_uuid_spellings_without_changing_receipt():
    with client_fixture([stored()]) as (client, db):
        original = request()
        first = converted(client.post(f"{BASE}/{ID}/convert", json=original))
        receipt = deepcopy(db.session.get(Schedule, ID).converted_receipt)
        compact = deepcopy(original)
        compact["entry"].update(id=ID.hex, from_schedule_id=ID.hex)
        second = converted(client.post(f"{BASE}/{ID.hex}/convert", json=compact))
        assert first["created"] is True and second["created"] is False
        assert first["confirmed"] is True and second["confirmed"] is True
        assert second["schedule"]["id"] == second["schedule"]["converted_entry_id"] == ID.hex
        assert second["entry"]["id"] == second["entry"]["from_schedule_id"] == ID.hex
        assert db.session.get(Schedule, ID).converted_receipt == receipt and db.commits == 1
        review = success(client.get(f"{BASE}/{ID.hex}/review"))
        assert review["read_only"] and review["receipt_known"]
        assert review["schedule"]["id"] == review["entry"]["id"] == ID.hex
        assert db.commits == 1


@pytest.mark.parametrize("field", ["id", "from_schedule_id"])
def test_conversion_rejects_urn_snapshot_before_any_database_read(field):
    with client_fixture([stored()]) as (client, db):
        body = request()
        body["entry"][field] = "urn:uuid:" + str(ID)
        response = client.post(f"{BASE}/{ID.hex}/convert", json=body)
        assert response.status_code == 422
        assert not db.statements and db.commits == db.flushes == 0


@pytest.mark.parametrize("suffix", ["", "/review", "/review/resources", "/convert",
                                     "/independent-tags", "/independent-tags/review"])
def test_urn_schedule_route_id_is_422_before_database_lookup(suffix):
    with api_client() as (client, db):
        path = f"{BASE}/urn:uuid:{ID}{suffix}"
        if suffix == "/convert":
            response = client.post(path, json=request())
        elif "independent-tags" in suffix:
            response = client.post(path, json={
                "plan_id": PLAN.hex, "choice": "cloud-source-use-diary", "confirmed": True,
                "expected_resources": {}, "copies": [{
                    "from_tag_id": ID.hex, "id": COPY.hex, "name": "独立", "color": None,
                }],
            })
        else:
            response = client.get(path)
        assert response.status_code == 422
        assert not db.statements and db.commits == db.flushes == 0


@pytest.mark.parametrize("hex_filename", [False, True])
def test_resource_review_and_download_accept_hex32_reference_and_exact_path(
    tmp_path, monkeypatch, hex_filename,
):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, path):
        diary = db.session.get(DiaryEntry, ID)
        diary.content = {"schemaVersion": 1, "doc": {"type": "doc", "content": [
            {"type": "image", "attrs": {"src": f"local://media/{OTHER_USER_ID.hex}"}},
        ]}}
        if hex_filename:
            path.rename(path.with_name(OTHER_USER_ID.hex + ".png"))
            media = db.session.get(Media, OTHER_USER_ID)
            media.url = media.url.replace(str(OTHER_USER_ID), OTHER_USER_ID.hex)
        db.session.commit()
        review = success(client.get(f"{BASE}/{ID.hex}/review/resources"))
        assert review["resources_complete"] and review["media_ids"] == [OTHER_USER_ID.hex]
        assert review["tag_ids"] == [ID.hex]
        assert review["media"][0]["id"] == OTHER_USER_ID.hex
        assert review["media"][0]["entry_id"] == ID.hex
        assert review["tags"][0]["id"] == ID.hex
        image = success(client.get(
            f"{BASE}/{ID.hex}/review/resources/{OTHER_USER_ID.hex}/original", params=expected(),
        ))
        assert image["schedule_id"] == ID.hex and image["media_id"] == OTHER_USER_ID.hex
        assert db.commits == db.flushes == 0


def test_download_rejects_urn_media_id_before_database_or_file_access(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        response = client.get(
            f"{BASE}/{ID.hex}/review/resources/urn:uuid:{OTHER_USER_ID}/original",
            params=expected(),
        )
        assert response.status_code == 422
        assert not db.statements and db.commits == db.flushes == 0


def test_independent_tag_publish_and_readonly_review_use_hex32(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        body = tag_copy_request(client)
        body["plan_id"] = PLAN.hex
        body["copies"][0].update(id=COPY.hex, from_tag_id=ID.hex)
        published = success(client.post(f"{BASE}/{ID.hex}/independent-tags", json=body))
        assert published["schedule_id"] == ID.hex and published["plan_id"] == PLAN.hex
        assert published["tags"][0]["from_tag_id"] == ID.hex
        assert published["tags"][0]["id"] == COPY.hex and db.commits == 1
        reviewed = success(client.post(f"{BASE}/{ID.hex}/independent-tags/review", json=body))
        assert reviewed["tags"][0]["id"] == COPY.hex and not reviewed["tags"][0]["created"]
        assert db.commits == 1 and reviewed["diary_sync_enabled"] is False


def test_stale_resource_proof_is_not_rewritten_to_authorize_tag_publication(tmp_path, monkeypatch):
    with resource_fixture(tmp_path, monkeypatch) as (client, db, _):
        body = tag_copy_request(client)
        body["expected_resources"]["review"]["schedule"]["id"] = str(ID)
        response = client.post(f"{BASE}/{ID.hex}/independent-tags", json=body)
        assert response.status_code == 409
        assert db.commits == db.flushes == 0
