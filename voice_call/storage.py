"""Reading and writing the two things that outlive a run: the setup, and finished calls."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from . import settings
from .models import BusinessSetup, Call

__all__ = ["load_setup", "save_setup", "save_call", "recent_calls", "EXAMPLE"]

EXAMPLE = BusinessSetup(
    business_name="Bella Cucina",
    assistant_name="Aria",
    purpose="Call customers to confirm their upcoming table booking.",
    language="English",
    business_info=["Open 12:00 to 23:00, Tuesday to Sunday. Closed on Mondays.",
                   "Free parking behind the restaurant."],
    rules=["Never offer discounts, refunds or free items.",
           "Never ask for card or payment details."],
    questions=[],
)


def load_setup() -> BusinessSetup:
    """The saved setup, or an example to start from."""
    if settings.CONFIG_FILE.exists():
        return BusinessSetup.model_validate_json(settings.CONFIG_FILE.read_text(encoding="utf-8"))
    return EXAMPLE.model_copy(deep=True)


def save_setup(setup: BusinessSetup) -> Path:
    settings.CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    settings.CONFIG_FILE.write_text(setup.model_dump_json(indent=2), encoding="utf-8")
    return settings.CONFIG_FILE


def save_call(call: Call) -> Path:
    folder = settings.DATA_FOLDER / "calls"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{call.id}.json"
    path.write_text(json.dumps({
        "call": call.id,
        "business": call.setup.business_name,
        "customer": call.customer,
        "at": datetime.now().isoformat(timespec="seconds"),
        "outcome": call.outcome,
        "end_reason": call.end_reason,
        "answers": {k: a["value"] for k, a in call.answers.items()},
        "in_their_words": {k: a["said"] for k, a in call.answers.items()},
        "not_answered": [q.save_as for q in call.missing_required()],
        "not_needed": [q.save_as for q in call.not_needed()],
        "changed_during_call": call.changes,
        "seconds": round(call.seconds(), 1),
        "summary": call.summary,
        "transcript": call.transcript,
        "decisions": call.events,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def recent_calls(limit: int = 20) -> list[dict]:
    folder = settings.DATA_FOLDER / "calls"
    if not folder.exists():
        return []
    files = sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    calls = []
    for path in files:
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        calls.append({"call": saved.get("call"), "at": saved.get("at"), "outcome": saved.get("outcome"),
                      "answers": saved.get("answers", {}), "seconds": saved.get("seconds"),
                      "summary": (saved.get("summary") or {}).get("summary")})
    return calls
