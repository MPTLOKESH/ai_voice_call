"""Where contacts come from besides typing them in: a file (CSV, or Excel), or a database.

Databases are only ever read. A query must be a single SELECT, it runs in a read-only session, and only so
many rows come back. Connection details (addresses and passwords) stay in config/connections.json and are
never sent to the browser: it sees a name and an address with the password hidden.

SQLite needs nothing extra. PostgreSQL needs `pip install "psycopg[binary]"`, MySQL `pip install pymysql`,
and Excel files `pip install openpyxl`.
"""
from __future__ import annotations

import csv
import importlib.util
import io
import ipaddress
import json
import os
import re
import socket
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import accounts, scope, settings, vault
from . import contacts
from .contacts import MAX_IMPORT, Problem
from .storage import write_atomic

PREVIEW_ROWS = 20
MAX_FILE_BYTES = 15 * 1024 * 1024

KINDS = {
    "postgres": {"label": "PostgreSQL", "module": "psycopg", "install": 'pip install "psycopg[binary]"',
                 "example": "postgresql://user:password@host:5432/database"},
    "mysql": {"label": "MySQL", "module": "pymysql", "install": "pip install pymysql",
              "example": "mysql://user:password@host:3306/database"},
    "sqlite": {"label": "SQLite", "module": "sqlite3", "install": "",
               "example": "C:/data/customers.db"},
}


def drivers() -> list[dict]:
    """Each kind of database, and whether it can be used here, or what to install first."""
    return [{"kind": kind, "label": info["label"], "ready": importlib.util.find_spec(info["module"]) is not None,
             "install": info["install"], "example": info["example"]} for kind, info in KINDS.items()]


# ── files ────────────────────────────────────────────────────────────────────

def _columns(header: list) -> list[str]:
    """Column names that are all there and all different: a blank one is "Column 3", a repeat "Phone (2)"."""
    names: list[str] = []
    for at, raw in enumerate(header, start=1):
        name = str(raw if raw is not None else "").strip() or f"Column {at}"
        base, n = name, 2
        while name in names:
            name, n = f"{base} ({n})", n + 1
        names.append(name)
    return names


def read_file(filename: str, data: bytes) -> dict:
    """A CSV or Excel file as {"columns": [...], "rows": [[...]], "total": n}. The first row is the header."""
    if not data:
        raise Problem("That file is empty.")
    if len(data) > MAX_FILE_BYTES:
        raise Problem("That file is over 15 MB. Split it, or keep only the columns you need.")
    suffix = Path(filename or "").suffix.lower()
    if suffix in (".xlsx", ".xlsm"):
        table = _read_excel(data)
    elif suffix == ".xls":
        raise Problem("Old .xls files can't be read. Save it as .xlsx or .csv and try again.")
    else:
        table = _read_text(data)
    table = [row for row in table if any(str(cell or "").strip() for cell in row)]
    if len(table) < 2:
        raise Problem("No rows found. The first row should name the columns, with a contact on each row after it.")
    columns = _columns(table[0])
    rows = [[("" if cell is None else str(cell).strip()) for cell in row[:len(columns)]] for row in table[1:]]
    if len(rows) > MAX_IMPORT:
        raise Problem(f"That file has {len(rows):,} rows. Up to {MAX_IMPORT:,} can come in at once: split it into parts.")
    return {"columns": columns, "rows": rows, "total": len(rows)}


def _read_text(data: bytes) -> list[list]:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:20_000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return list(csv.reader(io.StringIO(text), dialect))


def _read_excel(data: bytes) -> list[list]:
    if importlib.util.find_spec("openpyxl") is None:
        raise Problem("Excel files need one more part: run `pip install openpyxl` and restart, or save the sheet as CSV.")
    import openpyxl
    try:
        book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as exc:
        raise Problem(f"That Excel file could not be opened: {exc}") from exc
    sheet = book.worksheets[0]
    return [list(row) for row in sheet.iter_rows(values_only=True)]


# ── saved connections ────────────────────────────────────────────────────────

def _context(connection_id: str) -> str:
    return f"connection:{scope.owner()}:{connection_id}"


def _load() -> list[dict]:
    """The person's saved connections, addresses decrypted. An address saved before encryption existed is read as it is
    and sealed the next time the list is written."""
    path = scope.connections_file()
    if not path.exists():
        return []
    try:
        found = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return []
    for one in found:
        if vault.is_sealed(one.get("address", "")):
            try:
                one["address"] = vault.unseal(one["address"], _context(one["id"]))
            except vault.Unreadable:
                one["address"] = ""
    return found


def _save(found: list[dict]):
    """Addresses carry passwords, so they are written encrypted."""
    write_atomic(scope.connections_file(), json.dumps(
        [{**one, "address": vault.seal(one["address"], _context(one["id"]))} for one in found], indent=2))


def _mask(address: str) -> str:
    """The address with its password hidden: postgresql://ana:••••@db.example.com/shop."""
    return re.sub(r"(//[^:/@]+:)[^@]*@", r"\1••••@", address)


def _public(one: dict) -> dict:
    return {"id": one["id"], "name": one["name"], "kind": one["kind"], "address": _mask(one["address"]),
            "label": KINDS[one["kind"]]["label"], "created": one.get("created", "")}


def list_connections() -> list[dict]:
    return [_public(one) for one in _load()]


def _find(connection_id: str) -> dict:
    found = next((one for one in _load() if one["id"] == connection_id), None)
    if found is None:
        raise Problem("That database connection is no longer saved. Connect it again.")
    return found


def save_connection(name: str, kind: str, address: str) -> dict:
    """Checks a connection works, then keeps it. Returns it, with the tables it can see."""
    if kind not in KINDS:
        raise Problem("Pick PostgreSQL, MySQL or SQLite.")
    address = address.strip()
    tables = list_tables({"kind": kind, "address": address})
    one = {"id": uuid.uuid4().hex[:8], "name": name.strip()[:80] or KINDS[kind]["label"], "kind": kind,
           "address": address, "created": datetime.now().isoformat(timespec="seconds")}
    _save([*_load(), one])
    return {**_public(one), "tables": tables}


def delete_connection(connection_id: str):
    _save([one for one in _load() if one["id"] != connection_id])


# ── reading a database ───────────────────────────────────────────────────────

def _server_owner() -> bool:
    """The person running this server may point at its own machine and network. Nobody else may."""
    who = accounts.get(scope.owner())
    return bool(who and who["is_admin"])


def _host_of(address: str) -> str:
    if "://" in address:
        return urlparse(address).hostname or ""
    found = re.search(r"(?:^|\s)host=([^\s]+)", address)
    return found.group(1) if found else ""


def _check_where(kind: str, address: str):
    """A database a person names is reached FROM this server, so on a shared server it must not be this server's own files
    or a machine on its private network."""
    if kind == "sqlite":
        path = Path(address.removeprefix("sqlite:///").removeprefix("sqlite://")).resolve()
        if not _server_owner():
            raise Problem("SQLite files can only be read by the person running this server. Use PostgreSQL or MySQL.")
        data = settings.DATA_FOLDER.resolve()
        if path == data or data in path.parents:
            raise Problem("That file is part of this app's own data and can't be read as a database.")
        return
    host = _host_of(address)
    if _server_owner() or (os.getenv("ALLOW_PRIVATE_DB") or "") == "1":
        return
    if not host:
        raise Problem("Say which host the database is on.")
    try:
        found = {item[4][0] for item in socket.getaddrinfo(host, None)}
    except OSError:
        raise Problem(f"Could not find a server called {host}.") from None
    if not found or any(not ipaddress.ip_address(one.split("%")[0]).is_global for one in found):
        raise Problem("That address is on a private network, which this server will not connect to. "
                      "Use a database that can be reached over the internet.")


def _open(connection: dict):
    """A read-only connection, and the way it marks a query's parameters."""
    kind, address = connection["kind"], connection["address"].strip()
    if not address:
        raise Problem("Fill in where the database is.")
    _check_where(kind, address)
    info = KINDS[kind]
    if importlib.util.find_spec(info["module"]) is None:
        raise Problem(f"Connecting to {info['label']} needs one more part: run `{info['install']}` and restart the app.")
    try:
        if kind == "sqlite":
            import sqlite3
            path = Path(address.removeprefix("sqlite:///").removeprefix("sqlite://"))
            if not path.is_file():
                raise Problem(f"No database file at {path}.")
            return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=10)
        if kind == "postgres":
            import psycopg
            con = psycopg.connect(address, connect_timeout=10, options="-c statement_timeout=20000")
            con.read_only = True
            return con
        import pymysql
        url = urlparse(address)
        if url.scheme not in ("mysql", "mysql+pymysql") or not url.hostname:
            raise Problem("Write it as mysql://user:password@host:3306/database")
        con = pymysql.connect(host=url.hostname, port=url.port or 3306, user=unquote(url.username or ""),
                              password=unquote(url.password or ""), database=url.path.lstrip("/") or None,
                              connect_timeout=10, read_timeout=30)
        with con.cursor() as cursor:
            cursor.execute("SET SESSION TRANSACTION READ ONLY")
        return con
    except Problem:
        raise
    except Exception as exc:
        raise Problem(f"Could not connect: {_short(exc)}") from exc


def _short(exc: Exception) -> str:
    # Driver messages can repeat the address, password and all.
    return _mask(str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__)[:300]


TABLE_QUERIES = {
    "sqlite": "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    "postgres": "SELECT table_schema || '.' || table_name FROM information_schema.tables "
                "WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1",
    "mysql": "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1",
}


def list_tables(connection: dict) -> list[str]:
    con = _open(connection)
    try:
        cursor = con.cursor()
        cursor.execute(TABLE_QUERIES[connection["kind"]])
        return [row[0] for row in cursor.fetchall()][:500]
    except Exception as exc:
        raise Problem(f"Connected, but could not list the tables: {_short(exc)}") from exc
    finally:
        con.close()


# Words that only a statement that changes something starts with. The session is read-only as well, so this is
# for a clear message up front; it leaves out words like REPLACE that are also everyday functions in a SELECT.
WRITES = re.compile(r"\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|attach|detach|"
                    r"pragma|vacuum|exec|execute|copy)\b", re.I)


def _statement(table: str, query: str) -> str:
    """The one SELECT to run: the whole of a table, or the query as written, checked to only read."""
    if table:
        if not re.fullmatch(r"[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?", table):
            raise Problem("That table name can't be used.")
        return f"SELECT * FROM {table}"
    text = re.sub(r"--[^\n]*|/\*.*?\*/", " ", query or "", flags=re.S).strip().rstrip(";").strip()
    if not text:
        raise Problem("Pick a table, or write a query.")
    if ";" in text:
        raise Problem("Only one query, please.")
    if not re.match(r"(select|with)\b", text, re.I):
        raise Problem("The query has to start with SELECT. Contacts are only ever read from your database.")
    # Strings can hold any word: only look outside them.
    bare = re.sub(r"'(?:[^']|'')*'", "''", text)
    if WRITES.search(bare):
        raise Problem(f"The query can only read. Remove “{WRITES.search(bare).group(0)}” and try again.")
    return text


def read_rows(connection_id: str, table: str = "", query: str = "", limit: int = PREVIEW_ROWS) -> dict:
    """The rows a table or query gives: {"columns": [...], "rows": [[...]], "more": whether it stopped short}."""
    connection = _find(connection_id)
    statement = _statement(table, query)
    con = _open(connection)
    try:
        cursor = con.cursor()
        cursor.execute(statement)
        columns = _columns([part[0] for part in cursor.description or []])
        found = cursor.fetchmany(limit + 1)
    except Exception as exc:
        raise Problem(f"The query didn't run: {_short(exc)}") from exc
    finally:
        con.close()
    rows = [["" if cell is None else str(cell) for cell in row] for row in found[:limit]]
    return {"columns": columns, "rows": rows, "more": len(found) > limit}


def sync_group(group_id: str) -> dict:
    """Reads a database group's rows again: new people come in, and anyone no longer there leaves the group."""
    group = contacts.get_group(group_id)
    if group["source"] != "database":
        raise Problem("Only a group read from a database can be synced.")
    try:
        found = read_rows(group["connection"], group["table"], group["query"], limit=MAX_IMPORT)
        if found["more"]:
            raise Problem(f"The query gives more than {MAX_IMPORT:,} rows. Narrow it with a WHERE.")
        return contacts.bring_in(found["columns"], found["rows"], group["mapping"], country=group["country"],
                                 group_id=group_id, source="database", replace_members=True)
    except Problem as problem:
        contacts._mark_synced(group_id, str(problem))
        raise
