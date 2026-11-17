"""Reading and writing what outlives a run: the flows (each a setup), and finished calls."""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path

from . import scope
from .models import BusinessSetup, Call, Flow

__all__ = ["list_flows", "get_flow", "new_flow", "save_flow", "delete_flow", "save_call", "recent_calls", "delete_calls", "EXAMPLE",
           "write_atomic"]

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


def _first_setup() -> BusinessSetup:
    """What the first flow starts from: the single setup of earlier versions, or the example."""
    if scope.setup_file().exists():
        return BusinessSetup.model_validate_json(scope.setup_file().read_text(encoding="utf-8"))
    return EXAMPLE.model_copy(deep=True)


def _path(flow_id: str) -> Path:
    # The id arrives from the browser and becomes part of a file name.
    if not re.fullmatch(r"[a-z0-9]{1,32}", flow_id):
        raise KeyError(flow_id)
    return scope.flows_folder() / f"{flow_id}.json"


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def write_atomic(path: Path, text: str):
    """Write a whole file or nothing. A crash part-way through a plain write leaves half a file, which then
    fails to load, and a flow that fails to load drops out of the list as if it had been deleted."""
    path.parent.mkdir(parents=True, exist_ok=True)
    spare = path.with_name(f".{path.name}.{uuid.uuid4().hex[:6]}.tmp")
    try:
        spare.write_text(text, encoding="utf-8")
        os.replace(spare, path)
    finally:
        spare.unlink(missing_ok=True)


def new_flow(name: str = "Untitled flow", setup: BusinessSetup | None = None) -> Flow:
    now = _now()
    flow = Flow(id=uuid.uuid4().hex[:8], name=name.strip() or "Untitled flow", created=now, edited=now,
                setup=setup or BusinessSetup())
    return save_flow(flow, touch=False)


def save_flow(flow: Flow, touch: bool = True) -> Flow:
    if touch:
        flow.edited = _now()
        flow.version += 1
    write_atomic(_path(flow.id), flow.model_dump_json(indent=2, exclude={"unpublished_changes"}))
    return flow


def get_flow(flow_id: str) -> Flow:
    path = _path(flow_id)
    if not path.is_file():
        raise KeyError(flow_id)
    return Flow.model_validate_json(path.read_text(encoding="utf-8"))


def delete_flow(flow_id: str):
    _path(flow_id).unlink(missing_ok=True)


def list_flows() -> list[Flow]:
    """Every flow, most recently edited first. The first time, the earlier single setup becomes one."""
    # The starting flow is made once. Without the marker, deleting the last flow made the example appear again.
    folder = scope.flows_folder()
    marker = folder / ".seeded"
    if not marker.exists():
        if not any(folder.glob("*.json")) if folder.exists() else True:
            setup = _first_setup()
            new_flow(f"{setup.business_name} feedback" if setup.business_name else "First flow", setup)
        write_atomic(marker, "")
    flows = []
    for path in folder.glob("*.json"):
        try:
            flows.append(Flow.model_validate_json(path.read_text(encoding="utf-8")))
        except ValueError:
            continue                                  # a half-written or hand-edited file is skipped, not fatal
    return sorted(flows, key=lambda flow: flow.edited, reverse=True)


def save_call(call: Call) -> Path:
    path = scope.calls_folder() / f"{call.id}.json"
    write_atomic(path, json.dumps({
        "call": call.id,
        "flow": call.flow_id,
        "business": call.setup.business_name,
        "customer": call.customer,
        "at": datetime.now().isoformat(timespec="seconds"),
        "outcome": call.outcome,
        "end_reason": call.end_reason,
        "handoff": call.handoff,
        "test": call.test,
        "opted_out": call.opt_out,
        "answers": {k: a["value"] for k, a in call.answers.items()},
        "in_their_words": {k: a["said"] for k, a in call.answers.items()},
        "not_answered": [q.save_as for q in call.missing_required()],
        "not_needed": [q.save_as for q in call.not_needed()],
        "changed_during_call": call.changes,
        "seconds": round(call.seconds(), 1),
        "summary": call.summary,
        "transcript": call.transcript,
        "decisions": call.events,
        # The questions as they were on this call, so its answers still read right after the flow changes.
        "questions": [q.model_dump() for q in call.setup.questions],
    }, indent=2, ensure_ascii=False))
    return path


def delete_calls(ids: list[str]) -> int:
    """Remove finished calls by id. Only plain ids count, since each becomes part of a file name. Returns how many went."""
    folder, gone = scope.calls_folder(), 0
    for one in dict.fromkeys(str(i) for i in ids):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", one):
            continue
        path = folder / f"{one}.json"
        if path.is_file():
            path.unlink(missing_ok=True)
            gone += 1
    return gone


def recent_calls(limit: int = 20, offset: int = 0, flow: str = "", outcome: str = "", contact: str = "") -> dict:
    """Finished calls, newest first, a page at a time: {"calls": [...], "total": how many match}.

    `flow` keeps only one flow's calls, `contact` one contact's, `outcome` only "completed" or only "incomplete" ones.
    """
    folder = scope.calls_folder()
    if not folder.exists():
        return {"calls": [], "total": 0}
    files = sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    matching = []
    for path in files:
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if flow and saved.get("flow") != flow:
            continue
        if contact and (saved.get("customer") or {}).get("id") != contact:
            continue
        done = saved.get("outcome") == "completed"
        if (outcome == "completed" and not done) or (outcome == "incomplete" and done):
            continue
        matching.append(saved)
    calls = [{"call": saved.get("call"), "flow": saved.get("flow", ""), "at": saved.get("at"),
              "outcome": saved.get("outcome"), "answers": saved.get("answers", {}), "seconds": saved.get("seconds"),
              "summary": (saved.get("summary") or {}).get("summary"), "customer": saved.get("customer") or {},
              "test": bool(saved.get("test")), "end_reason": saved.get("end_reason")}
             for saved in matching[offset:offset + limit]]
    return {"calls": calls, "total": len(matching)}
