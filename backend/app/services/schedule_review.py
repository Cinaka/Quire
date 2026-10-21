"""Read-only terminal identity classification; never confirms a local first intent."""

from dataclasses import dataclass
from typing import Literal

from app.services.schedule_receipts import valid_receipt

ReviewReason = Literal[
    "terminal_review", "not_terminal", "invalid_state", "identity_conflict", "receipt_unknown",
]


@dataclass(frozen=True)
class TerminalReviewState:
    reviewable: bool
    reason: ReviewReason
    entry_state: Literal["active", "deleted", "purged", "unknown"] = "unknown"
    receipt_known: bool = False
    first_entry_date: str | None = None
    first_entry_deleted: bool | None = None


def terminal_review_state(row, entry, collision: bool = False) -> TerminalReviewState:
    """Receipt validity is distinct from matching the user's first conversion snapshot."""
    if row.status == 0:
        reason = "not_terminal" if (
            row.converted_entry_id is None and row.converted_at is None
            and row.converted_receipt is None
        ) else "invalid_state"
        return TerminalReviewState(False, reason)
    if row.status != 1:
        return TerminalReviewState(False, "invalid_state")
    if row.converted_entry_id != row.id or row.converted_at is None or collision:
        return TerminalReviewState(False, "identity_conflict")
    if entry is not None and (
        entry.id != row.id or entry.from_schedule_id != row.id or entry.user_id != row.user_id
    ):
        return TerminalReviewState(False, "identity_conflict")
    state = "purged" if entry is None else "deleted" if entry.deleted_at is not None else "active"
    receipt = row.converted_receipt
    if not valid_receipt(receipt):
        return TerminalReviewState(False, "receipt_unknown", state)
    return TerminalReviewState(
        True, "terminal_review", state, True, receipt["entry_date"], receipt["deleted"],
    )
