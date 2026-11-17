"""Whose data this is. Everything a person owns lives in their own folder, and every storage function finds
that folder through here, so there is no query to forget a filter on: with no owner set, storage refuses to
run rather than fall back to something shared.

The server sets the owner from the signed-in session at the start of every request. A call that outlives its
request (it is closed later by a timer) carries its owner with it and sets it again.
"""
from __future__ import annotations

import re
import shutil
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from . import settings

_owner: ContextVar[str] = ContextVar("owner", default="")
_SAFE = re.compile(r"[a-f0-9]{16}")                  # what accounts.py makes: never a path from outside


class NoOwner(RuntimeError):
    """Storage was used with nobody signed in. A bug in the caller, never something to paper over."""


def set_owner(owner_id: str):
    if owner_id and not _SAFE.fullmatch(owner_id):
        raise ValueError("not an account id")
    _owner.set(owner_id)


@contextmanager
def acting_as(owner_id: str):
    """Run a block as this person: for work that happens outside any request."""
    if owner_id and not _SAFE.fullmatch(owner_id):
        raise ValueError("not an account id")
    token = _owner.set(owner_id)
    try:
        yield
    finally:
        _owner.reset(token)


def owner() -> str:
    found = _owner.get()
    if not found:
        raise NoOwner("no account is set for this work")
    return found


def folder() -> Path:
    return settings.DATA_FOLDER / "users" / owner()


def flows_folder() -> Path:
    return folder() / "flows"


def calls_folder() -> Path:
    return folder() / "calls"


def contacts_file() -> Path:
    return folder() / "contacts.db"


def connections_file() -> Path:
    return folder() / "connections.json"


def setup_file() -> Path:
    return folder() / "business.json"


# What earlier, single-user versions kept in shared places. The first account to be made takes it over.
def _legacy() -> list[tuple[Path, str]]:
    return [(settings.FLOWS_FOLDER, "flows"), (settings.DATA_FOLDER / "calls", "calls"),
            (settings.DATA_FOLDER / "contacts.db", "contacts.db"),
            (settings.PROJECT / "config" / "connections.json", "connections.json"),
            (settings.CONFIG_FILE, "business.json")]


def adopt_legacy(owner_id: str) -> list[str]:
    """Move the shared data of the single-user days into this person's folder. Returns what was moved."""
    moved = []
    target = settings.DATA_FOLDER / "users" / owner_id
    for source, name in _legacy():
        if source.exists() and not (target / name).exists():
            target.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target / name))
            moved.append(name)
    return moved


def erase(owner_id: str):
    """Everything a person had, gone: for when they delete their account."""
    if not _SAFE.fullmatch(owner_id):
        raise ValueError("not an account id")
    shutil.rmtree(settings.DATA_FOLDER / "users" / owner_id, ignore_errors=True)
