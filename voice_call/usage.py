"""The usage ledger: one row for every request that costs something, written by the server from what the provider
reported (tokens, characters, seconds), never from anything the browser says.

Each row says whose it is, what for, and whose key paid: "ours" (the server's) or "own" (the person's). Totals are
sums over the rows, so the ledger is also the audit trail.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

from . import accounts, scope, settings

# The services a row can be for, and the account key that pays for each.
SERVICE_KEY = {"gemini": "gemini", "speak": "elevenlabs", "hear": "elevenlabs"}
SERVICE_NAME = {"gemini": "Thinking (Gemini)", "speak": "Speaking (ElevenLabs)", "hear": "Hearing (ElevenLabs)"}
KIND_NAME = {"call": "Calls", "test": "Test calls", "summary": "After-call summaries", "studio": "Studio assistant",
             "voice": "Voice samples", "other": "Other"}

_tag: ContextVar[tuple[str, str]] = ContextVar("usage_tag", default=("other", ""))


def set_tag(kind: str, flow: str = ""):
    """What the requests that follow in this thread are for, and which flow."""
    _tag.set((kind, flow))


@contextmanager
def tagged(kind: str, flow: str = ""):
    token = _tag.set((kind, flow))
    try:
        yield
    finally:
        _tag.reset(token)


def cost_of(service: str, units_in: float, units_out: float = 0) -> float:
    price = settings.PRICES[service]
    if service == "gemini":
        return (units_in * price["in_per_million_tokens"] + units_out * price["out_per_million_tokens"]) / 1e6
    if service == "speak":
        return units_in / 1000 * price["per_1000_characters"]
    return units_in / 3600 * price["per_hour"]                 # hear: seconds of audio


def record(service: str, source: str, units_in: float, units_out: float = 0, model: str = ""):
    """Never raises: a failed note about a request is not a reason to fail the request."""
    try:
        owner = scope.owner()
        kind, flow = _tag.get()
        with accounts._db() as db:
            db.execute("INSERT INTO usage (user_id, at, service, kind, flow_id, model, units_in, units_out, cost, source) "
                       "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                       (owner, datetime.now(timezone.utc).isoformat(timespec="seconds"), service, kind, flow, model,
                        units_in, units_out, cost_of(service, units_in, units_out), source))
    except Exception as exc:
        print(f"  note: could not record usage: {type(exc).__name__}")


# ── reading it back ──────────────────────────────────────────────────────────
def month_start(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="seconds")


def next_month_start(now: datetime | None = None) -> str:
    first = datetime.fromisoformat(month_start(now))
    return (first.replace(day=28) + timedelta(days=4)).replace(day=1).isoformat(timespec="seconds")


def used_this_month(person_id: str, source: str = "ours") -> float:
    with accounts._db() as db:
        return db.execute("SELECT COALESCE(SUM(cost), 0) FROM usage WHERE user_id = ? AND source = ? AND at >= ?",
                          (person_id, source, month_start())).fetchone()[0]


def allowance_for(person: dict) -> float:
    return settings.FREE_ALLOWANCE_USD if person.get("allowance") is None else float(person["allowance"])


def plan(person: dict) -> dict:
    limit, used = allowance_for(person), used_this_month(person["id"])
    return {"allowance": limit, "used": round(used, 4), "left": round(max(limit - used, 0), 4),
            "resets": next_month_start(), "own_used": round(used_this_month(person["id"], "own"), 4)}


def summary(person_id: str, days: int = 30) -> dict:
    """Totals, a day-by-day series, and the splits by service, purpose and flow, for the last `days` days."""
    days = max(1, min(days, 365))
    since = (datetime.now(timezone.utc) - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    with accounts._db() as db:
        rows = [dict(row) for row in db.execute(
            "SELECT at, service, kind, flow_id, units_in, units_out, cost, source FROM usage "
            "WHERE user_id = ? AND at >= ? ORDER BY at", (person_id, since.isoformat(timespec="seconds"))).fetchall()]
        recent = [dict(row) for row in db.execute(
            "SELECT at, service, kind, flow_id, model, units_in, units_out, cost, source FROM usage "
            "WHERE user_id = ? ORDER BY id DESC LIMIT 40", (person_id,)).fetchall()]

    daily = {(since + timedelta(days=n)).date().isoformat(): {"day": (since + timedelta(days=n)).date().isoformat(),
                                                              "ours": 0.0, "own": 0.0} for n in range(days)}
    split: dict[str, dict] = {"service": {}, "kind": {}, "flow": {}}
    totals = {"cost": 0.0, "ours": 0.0, "own": 0.0, "requests": len(rows), "tokens": 0, "characters": 0, "seconds": 0.0}
    for row in rows:
        bucket = daily.get(row["at"][:10])
        if bucket:
            bucket[row["source"]] += row["cost"]
        totals["cost"] += row["cost"]
        totals[row["source"]] += row["cost"]
        if row["service"] == "gemini":
            totals["tokens"] += int(row["units_in"] + row["units_out"])
        elif row["service"] == "speak":
            totals["characters"] += int(row["units_in"])
        else:
            totals["seconds"] += row["units_in"]
        for name, key in (("service", row["service"]), ("kind", row["kind"]), ("flow", row["flow_id"] or "—")):
            one = split[name].setdefault(key, {"key": key, "cost": 0.0, "requests": 0})
            one["cost"] += row["cost"]
            one["requests"] += 1
    return {
        "days": days,
        "totals": {k: round(v, 4) if isinstance(v, float) else v for k, v in totals.items()},
        "daily": [{**one, "ours": round(one["ours"], 5), "own": round(one["own"], 5)} for one in daily.values()],
        "by_service": sorted(split["service"].values(), key=lambda one: -one["cost"]),
        "by_kind": sorted(split["kind"].values(), key=lambda one: -one["cost"]),
        "by_flow": sorted(split["flow"].values(), key=lambda one: -one["cost"]),
        "recent": recent,
        "names": {"service": SERVICE_NAME, "kind": KIND_NAME},
    }


def month_totals() -> dict[str, float]:
    """Each account's spend on our keys this month: for the person running the server."""
    with accounts._db() as db:
        return {row["user_id"]: row["total"] for row in db.execute(
            "SELECT user_id, SUM(cost) AS total FROM usage WHERE source = 'ours' AND at >= ? GROUP BY user_id",
            (month_start(),)).fetchall()}
