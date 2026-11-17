"""What the finished calls say: how many a flow has had, and what people answered, question by question.

Everything is worked out from the saved calls in data/calls/ each time it is asked for. There is no second copy
of the numbers to fall out of step with the calls.
"""
from __future__ import annotations

import csv
import io
import json
import statistics
from collections import Counter
from datetime import datetime, timedelta

from . import scope
from .models import Flow

TEXT_SAMPLE = 25            # free-text answers listed per question
WEEK = timedelta(days=7)


def _saved_calls(tests: bool = False):
    """Every saved call. Calls made from the studio's test bench are left out unless `tests`."""
    for call in _all_saved():
        if tests or not call.get("test"):
            yield call


def _safe(value):
    """A cell a spreadsheet will show as text. One that starts with = + - @ is read as a formula, and an
    answer is only whatever the customer was heard to say."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") and not text.lstrip("+").isdigit() else text


def _all_saved():
    folder = scope.calls_folder()
    if not folder.exists():
        return
    for path in folder.glob("*.json"):
        try:
            yield json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue                         # a half-written or hand-edited file is skipped, not fatal


def _when(call: dict) -> datetime | None:
    try:
        return datetime.fromisoformat(call.get("at") or "")
    except ValueError:
        return None


def _days(count: int) -> list[str]:
    """The last `count` calendar days as ISO dates, oldest first, ending today."""
    today = datetime.now().date()
    return [(today - timedelta(days=back)).isoformat() for back in range(count - 1, -1, -1)]


def _daily(calls, count: int) -> list[dict]:
    """Calls and completed calls for each of the last `count` days (a day with no calls is a zero, not a gap)."""
    days = {day: {"day": day, "calls": 0, "completed": 0} for day in _days(count)}
    for call in calls:
        at = _when(call)
        one = days.get(at.date().isoformat()) if at else None
        if one:
            one["calls"] += 1
            one["completed"] += call.get("outcome") == "completed"
    return list(days.values())


def stats(tests: bool = False) -> dict:
    """Per flow: calls, completed, average length. And the same for the last seven days across all flows."""
    flows: dict[str, dict] = {}
    week = {"calls": 0, "completed": 0, "seconds": 0.0}
    since = datetime.now() - WEEK
    saved = list(_saved_calls(tests))
    for call in saved:
        done = call.get("outcome") == "completed"
        seconds = float(call.get("seconds") or 0)
        if call.get("flow"):
            one = flows.setdefault(call["flow"], {"calls": 0, "completed": 0, "seconds": 0.0, "last": ""})
            one["calls"] += 1
            one["completed"] += done
            one["seconds"] += seconds
            one["last"] = max(one["last"], call.get("at") or "")
        at = _when(call)
        if at and at >= since:
            week["calls"] += 1
            week["completed"] += done
            week["seconds"] += seconds
    for flow_id, one in flows.items():
        one["average_seconds"] = round(one.pop("seconds") / one["calls"], 1) if one["calls"] else 0
        one["daily"] = [day["calls"] for day in _daily((c for c in saved if c.get("flow") == flow_id), 7)]
    return {"flows": flows, "week": {
        "calls": week["calls"], "completed": week["completed"],
        "average_seconds": round(week["seconds"] / week["calls"], 1) if week["calls"] else 0},
        "daily": _daily(saved, 7)}


def _numbers(values: list[str]) -> list[float]:
    found = []
    for value in values:
        try:
            found.append(float(str(value).replace(",", "").strip()))
        except ValueError:
            continue
    return found


def _question_results(question: dict, values: list[str], calls: int) -> dict:
    kind = question.get("type", "text")
    out = {"save_as": question["save_as"], "ask": question.get("ask", ""), "type": kind,
           "answered": len(values), "calls": calls}
    if kind in ("yes_no", "choice"):
        counted = Counter(value.strip().lower() for value in values)
        order = ["yes", "no"] if kind == "yes_no" else [option.lower() for option in question.get("options", [])]
        keys = order + sorted(key for key in counted if key not in order)
        out["counts"] = [{"value": key, "count": counted.get(key, 0)} for key in keys if counted.get(key) or key in order]
    elif kind == "number":
        numbers = _numbers(values)
        if numbers:
            whole = all(n == int(n) for n in numbers)
            out.update({"average": round(statistics.fmean(numbers), 2), "low": min(numbers), "high": max(numbers),
                        "median": statistics.median(numbers)})
            if whole and max(numbers) - min(numbers) <= 10:
                spread = Counter(int(n) for n in numbers)
                out["counts"] = [{"value": str(n), "count": spread.get(n, 0)}
                                 for n in range(int(min(numbers)), int(max(numbers)) + 1)]
    else:
        out["values"] = values[:TEXT_SAMPLE]
    return out


def flow_results(flow: Flow, waiting: dict | None = None, tests: bool = False) -> dict:
    """Everything the results page shows for one flow."""
    mine = sorted((call for call in _saved_calls(tests) if call.get("flow") == flow.id), key=lambda c: c.get("at") or "",
                  reverse=True)
    done = [call for call in mine if call.get("outcome") == "completed"]
    seconds = [float(call.get("seconds") or 0) for call in mine]

    # The questions as they are now, then any a past call had that have since been removed or renamed.
    now = [q for q in (flow.published or flow.setup).questions if q.kind == "ask"]
    questions = {q.save_as: q.model_dump() for q in now}
    for call in mine:
        for question in call.get("questions") or []:
            questions.setdefault(question["save_as"], question)
        for name in call.get("answers", {}):
            questions.setdefault(name, {"save_as": name, "ask": "", "type": "text"})

    per_question = []
    for name, question in questions.items():
        values = [str(call["answers"][name]) for call in mine if str(call.get("answers", {}).get(name, "")).strip()]
        entry = _question_results(question, values, len(mine))
        entry["removed"] = name not in {q.save_as for q in now}
        per_question.append(entry)

    return {
        "calls": len(mine), "completed": len(done),
        "average_seconds": round(sum(seconds) / len(seconds), 1) if seconds else 0,
        "last_call": mine[0].get("at", "") if mine else "",
        "daily": _daily(mine, 14),
        "questions": per_question,
        "recent": [{"call": call.get("call"), "at": call.get("at"), "outcome": call.get("outcome"),
                    "seconds": call.get("seconds"), "customer": call.get("customer") or {},
                    "summary": (call.get("summary") or {}).get("summary")} for call in mine[:10]],
        "audience": waiting or {},
    }


def flow_csv(flow: Flow, tests: bool = False) -> str:
    """One row per call: when, who, how it ended, and a column for each question's answer."""
    mine = sorted((call for call in _saved_calls(tests) if call.get("flow") == flow.id), key=lambda c: c.get("at") or "")
    names = [q.save_as for q in (flow.published or flow.setup).questions if q.kind == "ask"]
    for call in mine:
        for name in call.get("answers", {}):
            if name not in names:
                names.append(name)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["call", "when", "name", "phone", "outcome", "seconds", *names, "summary"])
    for call in mine:
        who = call.get("customer") or {}
        writer.writerow([_safe(cell) for cell in (
            call.get("call"), call.get("at"), who.get("name", ""), who.get("phone", ""),
            call.get("outcome", ""), call.get("seconds", ""),
            *[call.get("answers", {}).get(name, "") for name in names],
            (call.get("summary") or {}).get("summary", ""))])
    return out.getvalue()


def called_contacts(flow_id: str) -> set[str]:
    """The ids of the saved contacts a flow's calls were made to."""
    return {(call.get("customer") or {}).get("id") for call in _saved_calls()
            if call.get("flow") == flow_id and (call.get("customer") or {}).get("id")}
