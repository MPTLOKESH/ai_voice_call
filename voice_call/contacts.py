"""The people a flow is sent to: contacts, and the groups they are put in.

Kept in data/contacts.db (SQLite, part of Python). A contact is one phone number: importing the same number
again updates that contact rather than adding a second one, so nobody is called twice for one flow.
A contact can be in any number of groups; a flow is sent to one or more groups.
"""
from __future__ import annotations

import json
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime

from . import scope

MAX_IMPORT = 50_000            # rows in one import or sync
DEFAULT_COUNTRY = "+91"        # put in front of numbers written without one

SCHEMA = """
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '{}',
    opted_out INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',          -- manual, file or database
    source_config TEXT NOT NULL DEFAULT '{}',       -- for a database: where it reads from, and how
    created TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT '',
    sync_problem TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS members (
    group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, contact_id)
);
CREATE INDEX IF NOT EXISTS members_by_contact ON members(contact_id);
"""


class Problem(ValueError):
    """Something the person can fix, said so they can fix it."""


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _id() -> str:
    return uuid.uuid4().hex[:10]


@contextmanager
def _db():
    path = scope.contacts_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA foreign_keys = ON")
        con.executescript(SCHEMA)
        with con:                                   # one transaction: all of it happens, or none
            yield con
    finally:
        con.close()


# ── phone numbers ────────────────────────────────────────────────────────────

def phone_number(raw, country: str = DEFAULT_COUNTRY) -> str:
    """A phone number in one form, "+919876543210", or "" when it can't be one.

    Spaces, dashes, dots and brackets go. "00" in front means "+". A number with no country code gets
    `country`, after dropping a leading 0 (the trunk prefix: 09876543210 is 9876543210).
    """
    text = str(raw if raw is not None else "").strip()
    if re.fullmatch(r"\d+\.0", text):               # a spreadsheet's number, read as a float
        text = text[:-2]
    if not text:
        return ""
    international = text.startswith(("+", "00"))
    digits = re.sub(r"\D", "", text)
    if text.startswith("00"):
        digits = digits[2:]
    if not international:
        code = re.sub(r"\D", "", country or "")
        digits = digits.lstrip("0")
        # Already starts with the country code and is too long to be a local number: written without the +.
        if code and not (digits.startswith(code) and len(digits) > 10):
            digits = code + digits
    return f"+{digits}" if 8 <= len(digits) <= 15 else ""


EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def _email(raw) -> str:
    text = str(raw or "").strip()
    return text if EMAIL.fullmatch(text) else ""


# ── groups ───────────────────────────────────────────────────────────────────

def _group(row: sqlite3.Row) -> dict:
    config = json.loads(row["source_config"] or "{}")
    return {
        "id": row["id"], "name": row["name"], "description": row["description"], "source": row["source"],
        "created": row["created"], "synced_at": row["synced_at"], "sync_problem": row["sync_problem"],
        "count": row["count"], "opted_out": row["opted_out"],
        # What it reads, for a database group: never the connection's address or password.
        "query": config.get("query", ""), "table": config.get("table", ""),
        "connection": config.get("connection", ""), "mapping": config.get("mapping", {}),
        "country": config.get("country", DEFAULT_COUNTRY),
    }


GROUP_SELECT = """
    SELECT g.*, COUNT(c.id) AS count, COALESCE(SUM(c.opted_out), 0) AS opted_out
    FROM contact_groups g
    LEFT JOIN members m ON m.group_id = g.id
    LEFT JOIN contacts c ON c.id = m.contact_id
"""


def list_groups() -> dict:
    """Every group, newest first, with how many are in it; and how many contacts there are in all."""
    with _db() as con:
        groups = [_group(row) for row in con.execute(GROUP_SELECT + " GROUP BY g.id ORDER BY g.created DESC")]
        everyone = con.execute("SELECT COUNT(*), COALESCE(SUM(opted_out), 0) FROM contacts").fetchone()
    return {"groups": groups, "all": {"count": everyone[0], "opted_out": everyone[1]}}


def get_group(group_id: str) -> dict:
    with _db() as con:
        row = con.execute(GROUP_SELECT + " WHERE g.id = ? GROUP BY g.id", (group_id,)).fetchone()
    if row is None:
        raise KeyError(group_id)
    return _group(row)


def _unique_name(con, name: str, but: str = "") -> str:
    name = name.strip()[:80]
    if not name:
        raise Problem("Give the group a name.")
    taken = con.execute("SELECT 1 FROM contact_groups WHERE lower(name) = lower(?) AND id != ?", (name, but)).fetchone()
    if taken:
        raise Problem(f"There is already a group called “{name}”.")
    return name


def create_group(name: str, description: str = "", source: str = "manual", config: dict | None = None) -> dict:
    with _db() as con:
        group_id = _id()
        con.execute("INSERT INTO contact_groups (id, name, description, source, source_config, created) VALUES (?, ?, ?, ?, ?, ?)",
                    (group_id, _unique_name(con, name), description.strip()[:300], source, json.dumps(config or {}), _now()))
    return get_group(group_id)


def update_group(group_id: str, name: str | None = None, description: str | None = None,
                 config: dict | None = None) -> dict:
    get_group(group_id)
    with _db() as con:
        if name is not None:
            con.execute("UPDATE contact_groups SET name = ? WHERE id = ?", (_unique_name(con, name, group_id), group_id))
        if description is not None:
            con.execute("UPDATE contact_groups SET description = ? WHERE id = ?", (description.strip()[:300], group_id))
        if config is not None:
            con.execute("UPDATE contact_groups SET source_config = ? WHERE id = ?", (json.dumps(config), group_id))
    return get_group(group_id)


def delete_group(group_id: str, with_contacts: bool = False) -> int:
    """Deletes a group. Its contacts stay, unless `with_contacts`: then those in no other group go too."""
    with _db() as con:
        removed = 0
        if with_contacts:
            removed = con.execute("""
                DELETE FROM contacts WHERE id IN (SELECT contact_id FROM members WHERE group_id = ?)
                AND id NOT IN (SELECT contact_id FROM members WHERE group_id != ?)""", (group_id, group_id)).rowcount
        con.execute("DELETE FROM contact_groups WHERE id = ?", (group_id,))
    return removed


def _mark_synced(group_id: str, problem: str = ""):
    with _db() as con:
        if problem:
            con.execute("UPDATE contact_groups SET sync_problem = ? WHERE id = ?", (problem, group_id))
        else:
            con.execute("UPDATE contact_groups SET synced_at = ?, sync_problem = '' WHERE id = ?", (_now(), group_id))


# ── contacts ─────────────────────────────────────────────────────────────────

def _contact(row: sqlite3.Row, groups: list[str]) -> dict:
    return {"id": row["id"], "name": row["name"], "phone": row["phone"], "email": row["email"],
            "fields": json.loads(row["fields"] or "{}"), "opted_out": bool(row["opted_out"]),
            "created": row["created"], "updated": row["updated"], "groups": groups}


def _groups_of(con, ids: list[str]) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {contact_id: [] for contact_id in ids}
    for at in range(0, len(ids), 500):                   # SQLite allows only so many ? in one statement
        part = ids[at:at + 500]
        for row in con.execute(f"SELECT contact_id, group_id FROM members WHERE contact_id IN ({','.join('?' * len(part))})", part):
            found[row[0]].append(row[1])
    return found


def list_contacts(group: str = "", search: str = "", status: str = "", offset: int = 0, limit: int = 50) -> dict:
    """A page of contacts, by name: {"contacts": [...], "total": how many match}.

    `group` keeps one group's; `search` matches name, phone or email; `status` is "opted_out" or "reachable".
    """
    where, args = [], []
    if group:
        where.append("c.id IN (SELECT contact_id FROM members WHERE group_id = ?)")
        args.append(group)
    if search.strip():
        term = f"%{search.strip().lower()}%"
        digits = re.sub(r"\D", "", search)
        where.append("(lower(c.name) LIKE ? OR lower(c.email) LIKE ?" + (" OR c.phone LIKE ?" if digits else "") + ")")
        args += [term, term] + ([f"%{digits}%"] if digits else [])
    if status == "opted_out":
        where.append("c.opted_out = 1")
    elif status == "reachable":
        where.append("c.opted_out = 0")
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    with _db() as con:
        total = con.execute(f"SELECT COUNT(*) FROM contacts c {clause}", args).fetchone()[0]
        rows = con.execute(f"SELECT c.* FROM contacts c {clause} ORDER BY CASE WHEN c.name = '' THEN 1 ELSE 0 END, "
                           f"lower(c.name), c.phone LIMIT ? OFFSET ?", [*args, limit, offset]).fetchall()
        groups = _groups_of(con, [row["id"] for row in rows])
    return {"contacts": [_contact(row, groups[row["id"]]) for row in rows], "total": total}


def get_contact(contact_id: str) -> dict:
    with _db() as con:
        row = con.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
        if row is None:
            raise KeyError(contact_id)
        return _contact(row, _groups_of(con, [contact_id])[contact_id])


def _clean(data: dict, country: str) -> dict:
    phone = phone_number(data.get("phone"), country)
    if not phone:
        raise Problem("That phone number doesn't look right. Use digits, with the country code if it isn't "
                      f"{country}.")
    email = str(data.get("email") or "").strip()
    if email and not _email(email):
        raise Problem("That email address doesn't look right.")
    fields = {str(k).strip()[:60]: str(v).strip()[:500] for k, v in (data.get("fields") or {}).items() if str(k).strip()}
    return {"name": str(data.get("name") or "").strip()[:120], "phone": phone, "email": email, "fields": fields}


def save_contact(data: dict, contact_id: str = "", country: str = DEFAULT_COUNTRY) -> dict:
    """Adds a contact, or changes one when `contact_id` is given. `groups` (ids), if sent, is the whole list."""
    clean = _clean(data, country)
    with _db() as con:
        same = con.execute("SELECT id, name FROM contacts WHERE phone = ? AND id != ?", (clean["phone"], contact_id)).fetchone()
        if same:
            raise Problem(f"{clean['phone']} is already saved, as {same['name'] or 'a contact with no name'}.")
        now = _now()
        if contact_id:
            changed = con.execute("UPDATE contacts SET name = ?, phone = ?, email = ?, fields = ?, opted_out = ?, updated = ? WHERE id = ?",
                                  (clean["name"], clean["phone"], clean["email"], json.dumps(clean["fields"]),
                                   int(bool(data.get("opted_out"))), now, contact_id)).rowcount
            if not changed:
                raise KeyError(contact_id)
        else:
            contact_id = _id()
            con.execute("INSERT INTO contacts (id, name, phone, email, fields, opted_out, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (contact_id, clean["name"], clean["phone"], clean["email"], json.dumps(clean["fields"]),
                         int(bool(data.get("opted_out"))), now, now))
        if "groups" in data:
            con.execute("DELETE FROM members WHERE contact_id = ?", (contact_id,))
            known = {row[0] for row in con.execute("SELECT id FROM contact_groups")}
            con.executemany("INSERT INTO members (group_id, contact_id) VALUES (?, ?)",
                            [(group, contact_id) for group in dict.fromkeys(data["groups"]) if group in known])
    return get_contact(contact_id)


def delete_contacts(ids: list[str]) -> int:
    with _db() as con:
        return sum(con.execute("DELETE FROM contacts WHERE id = ?", (one,)).rowcount for one in ids)


def set_opted_out(ids: list[str], opted_out: bool) -> int:
    with _db() as con:
        return sum(con.execute("UPDATE contacts SET opted_out = ?, updated = ? WHERE id = ?",
                               (int(opted_out), _now(), one)).rowcount for one in ids)


def change_members(group_id: str, ids: list[str], add: bool) -> int:
    get_group(group_id)
    with _db() as con:
        if add:
            return sum(con.execute("INSERT OR IGNORE INTO members (group_id, contact_id) SELECT ?, id FROM contacts WHERE id = ?",
                                   (group_id, one)).rowcount for one in ids)
        return sum(con.execute("DELETE FROM members WHERE group_id = ? AND contact_id = ?", (group_id, one)).rowcount
                   for one in ids)


def reach(group_ids: list[str]) -> dict:
    """Who a flow sent to these groups would reach: each number once, and nobody who opted out."""
    if not group_ids:
        return {"people": 0, "opted_out": 0, "in_several": 0}
    marks = ",".join("?" * len(group_ids))
    with _db() as con:
        people, opted_out = con.execute(f"""
            SELECT COUNT(*) - COALESCE(SUM(opted_out), 0), COALESCE(SUM(opted_out), 0) FROM contacts
            WHERE id IN (SELECT contact_id FROM members WHERE group_id IN ({marks}))""", group_ids).fetchone()
        memberships = con.execute(f"SELECT COUNT(*) FROM members WHERE group_id IN ({marks})", group_ids).fetchone()[0]
    return {"people": people, "opted_out": opted_out, "in_several": memberships - people - opted_out}


def audience(group_ids: list[str], called: set[str]) -> dict:
    """For a flow's groups: how many people it reaches, how many of them were called, how many are still waiting."""
    if not group_ids:
        return {"people": 0, "called": 0, "waiting": 0}
    marks = ",".join("?" * len(group_ids))
    with _db() as con:
        ids = [row[0] for row in con.execute(
            f"SELECT DISTINCT c.id FROM contacts c JOIN members m ON m.contact_id = c.id "
            f"WHERE c.opted_out = 0 AND m.group_id IN ({marks})", group_ids)]
    done = sum(1 for one in ids if one in called)
    return {"people": len(ids), "called": done, "waiting": len(ids) - done}


# ── bringing many in at once ─────────────────────────────────────────────────

def _pick(row: list, columns: list[str], wanted) -> str:
    """The value of one mapped field: a column name, or a list of them joined (first name + last name)."""
    names = wanted if isinstance(wanted, list) else [wanted] if wanted else []
    parts = []
    for name in names:
        if name in columns:
            at = columns.index(name)
            value = row[at] if at < len(row) else ""
            text = "" if value is None else str(value).strip()
            if re.fullmatch(r"\d+\.0", text):
                text = text[:-2]
            if text:
                parts.append(text)
    return " ".join(parts)


def bring_in(columns: list[str], rows: list[list], mapping: dict, *, country: str = DEFAULT_COUNTRY,
             group_id: str = "", new_group: str = "", source: str = "file", config: dict | None = None,
             replace_members: bool = False, dry_run: bool = False) -> dict:
    """Adds many contacts at once, from a file or a database, into a group.

    `mapping` says which column is which: {"name": col or [cols], "phone": col, "email": col, "extra": [cols]}.
    A number already saved updates that contact, filling in what the rows have and keeping what they don't.
    `replace_members` (a database sync) also takes out of the group anyone no longer in the rows.
    `dry_run` checks everything and changes nothing, for the review step.
    """
    if not mapping.get("phone"):
        raise Problem("Say which column has the phone number.")
    if len(rows) > MAX_IMPORT:
        raise Problem(f"That is {len(rows):,} rows. Up to {MAX_IMPORT:,} can come in at once: split it into parts.")

    seen: dict[str, int] = {}
    ready, skipped = [], []
    duplicates = 0
    for number, row in enumerate(rows, start=1):
        raw = _pick(row, columns, mapping.get("phone"))
        phone = phone_number(raw, country)
        if not phone:
            skipped.append({"row": number, "value": raw, "reason": "No phone number" if not raw else "Not a phone number"})
            continue
        if phone in seen:
            duplicates += 1
            continue
        seen[phone] = number
        email = _pick(row, columns, mapping.get("email"))
        extra = {name: _pick(row, columns, name) for name in mapping.get("extra") or [] if name in columns}
        ready.append({"phone": phone, "name": _pick(row, columns, mapping.get("name"))[:120],
                      "email": email if _email(email) else "",
                      "fields": {k: v[:500] for k, v in extra.items() if v}})

    with _db() as con:
        existing = {}
        phones = [one["phone"] for one in ready]
        for at in range(0, len(phones), 500):
            part = phones[at:at + 500]
            existing.update({row["phone"]: row for row in con.execute(
                f"SELECT * FROM contacts WHERE phone IN ({','.join('?' * len(part))})", part)})
        summary = {"rows": len(rows), "added": sum(1 for one in ready if one["phone"] not in existing),
                   "updated": sum(1 for one in ready if one["phone"] in existing), "duplicates": duplicates,
                   "skipped": len(skipped), "problems": skipped[:100],
                   "opted_out": sum(1 for one in ready if one["phone"] in existing and existing[one["phone"]]["opted_out"])}
        if dry_run:
            return summary

        if not group_id:
            group_id = _id()
            con.execute("INSERT INTO contact_groups (id, name, source, source_config, created) VALUES (?, ?, ?, ?, ?)",
                        (group_id, _unique_name(con, new_group or "Imported contacts"), source,
                         json.dumps(config or {}), _now()))
        elif not con.execute("SELECT 1 FROM contact_groups WHERE id = ?", (group_id,)).fetchone():
            raise KeyError(group_id)

        now = _now()
        ids = []
        for one in ready:
            old = existing.get(one["phone"])
            if old:
                fields = {**json.loads(old["fields"] or "{}"), **one["fields"]}
                con.execute("UPDATE contacts SET name = ?, email = ?, fields = ?, updated = ? WHERE id = ?",
                            (one["name"] or old["name"], one["email"] or old["email"], json.dumps(fields), now, old["id"]))
                ids.append(old["id"])
            else:
                contact_id = _id()
                con.execute("INSERT INTO contacts (id, name, phone, email, fields, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (contact_id, one["name"], one["phone"], one["email"], json.dumps(one["fields"]), now, now))
                ids.append(contact_id)
        if replace_members:
            con.execute("DELETE FROM members WHERE group_id = ?", (group_id,))
        con.executemany("INSERT OR IGNORE INTO members (group_id, contact_id) VALUES (?, ?)", [(group_id, one) for one in ids])
        if source == "database":
            con.execute("UPDATE contact_groups SET synced_at = ?, sync_problem = '' WHERE id = ?", (now, group_id))
    return {**summary, "group": get_group(group_id)}
