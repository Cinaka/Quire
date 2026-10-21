"""Immutable conversion verification without retaining another diary-content copy."""

import hashlib
import json
from datetime import date, datetime, timezone

KEYS = {"version", "source_client_updated_at", "entry_date", "deleted", "fingerprint"}


def utc_stamp(value: datetime) -> str:
    value = (value.replace(tzinfo=timezone.utc) if value.tzinfo is None
             else value.astimezone(timezone.utc))
    return value.isoformat().replace("+00:00", "Z")


def entry_fingerprint(entry: dict) -> str:
    # Automatic local ordering/clock metadata need not match across devices.
    business = {
        "id": entry["id"], "from_schedule_id": entry["from_schedule_id"],
        "entry_date": entry["entry_date"], "title": entry["title"], "content": entry["content"],
        "deleted": entry.get("deleted_at") is not None,
    }
    encoded = json.dumps(
        business, sort_keys=True, ensure_ascii=False, allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def conversion_receipt(revision: datetime, entry: dict) -> dict:
    return {
        "version": 1, "source_client_updated_at": utc_stamp(revision),
        "entry_date": entry["entry_date"], "deleted": entry.get("deleted_at") is not None,
        "fingerprint": entry_fingerprint(entry),
    }


def valid_receipt(raw: object) -> bool:
    if not isinstance(raw, dict) or set(raw) != KEYS:
        return False
    if (not isinstance(raw["version"], int) or isinstance(raw["version"], bool)
            or raw["version"] != 1):
        return False
    if not isinstance(raw["deleted"], bool) or not isinstance(raw["entry_date"], str):
        return False
    stamp, digest = raw["source_client_updated_at"], raw["fingerprint"]
    if not isinstance(stamp, str) or not isinstance(digest, str):
        return False
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        return False
    try:
        day = date.fromisoformat(raw["entry_date"])
        instant = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        return (
            day.year >= 1000 and day.isoformat() == raw["entry_date"]
            and instant.tzinfo is not None and instant.year >= 1000
            and instant.microsecond % 1000 == 0
        )
    except ValueError:
        return False


def receipt_matches(raw: object, revision: datetime, entry: dict) -> bool | None:
    """None means missing/unknown receipt, never proof that an old intent was accepted."""
    if not valid_receipt(raw):
        return None
    instant = datetime.fromisoformat(raw["source_client_updated_at"].replace("Z", "+00:00"))
    return (utc_stamp(instant) == utc_stamp(revision)
            and raw["fingerprint"] == entry_fingerprint(entry))
