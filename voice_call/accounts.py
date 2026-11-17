"""Accounts and sign-in: who is using this, kept in SQLite beside the rest of the data.

Passwords are never stored, only a salted scrypt hash. A sign-in gives a random session token; only its hash is
kept here, so a copy of the database cannot be used to sign in as anyone. The token travels in an HttpOnly cookie
that scripts on the page cannot read. Emailed links (verify, reset) work the same way: only their hash is kept.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

from . import mailer, settings

DB_FILE = settings.DATA_FOLDER / "accounts.db"
COOKIE = "vc_session"
SESSION_DAYS = 30
MIN_PASSWORD = 10
# Scrypt cost: about 50 ms on an ordinary machine, which is nothing to one person and a lot to a guessing script.
_N, _R, _P = 2**14, 8, 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    verified INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    allowance REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created TEXT NOT NULL,
    expires REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    sealed TEXT NOT NULL,
    last4 TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created TEXT NOT NULL,
    PRIMARY KEY (user_id, service)
);
CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    at TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_user ON audit(user_id, id);
CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    at TEXT NOT NULL,
    service TEXT NOT NULL,
    kind TEXT NOT NULL,
    flow_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    units_in REAL NOT NULL DEFAULT 0,
    units_out REAL NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_user_at ON usage(user_id, at);
"""
# Columns added after the first release: an older database gets them when it is next opened.
ADDED = {"users": [("verified", "INTEGER NOT NULL DEFAULT 0"), ("is_admin", "INTEGER NOT NULL DEFAULT 0"),
                   ("allowance", "REAL")]}

_write = threading.RLock()
_ready: str | None = None


class Problem(Exception):
    """Something the person can fix: shown to them as it is written."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@contextmanager
def _db():
    global _ready
    settings.DATA_FOLDER.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_FILE, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    try:
        if _ready != str(DB_FILE):
            connection.executescript(SCHEMA)
            for table, columns in ADDED.items():
                have = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
                for name, kind in columns:
                    if name not in have:
                        connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")
            _ready = str(DB_FILE)
        yield connection
        connection.commit()
    finally:
        connection.close()


# ── passwords ────────────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, bytes.fromhex(digest))
    except (ValueError, TypeError):
        return False


# A hash to compare against when the email is unknown, so "no such account" takes as long as "wrong password".
_DECOY = hash_password(secrets.token_hex(8))


def _check_new_password(password: str):
    if len(password or "") < MIN_PASSWORD:
        raise Problem(f"Use a password of at least {MIN_PASSWORD} characters.")
    if len(password) > 200:
        raise Problem("That password is too long.")


# ── guessing limits ──────────────────────────────────────────────────────────
_attempts: dict[str, list[float]] = {}
_attempts_lock = threading.Lock()
WINDOW = 15 * 60
LIMITS = {"signin": 8, "signup": 6, "reset": 5, "password": 8}


def throttle(kind: str, *keys: str):
    """Refuses after too many tries from one address or on one email in a quarter of an hour."""
    now = time.monotonic()
    with _attempts_lock:
        for key in keys:
            tries = [t for t in _attempts.get(f"{kind}:{key}", []) if now - t < WINDOW]
            if len(tries) >= LIMITS[kind]:
                raise Problem("Too many tries. Wait a few minutes and try again.", 429)
            tries.append(now)
            _attempts[f"{kind}:{key}"] = tries
        if len(_attempts) > 5000:                      # forget the old ones rather than grow for ever
            for stale in [k for k, v in _attempts.items() if not v or now - v[-1] > WINDOW]:
                _attempts.pop(stale, None)


def _forgive(kind: str, key: str):
    with _attempts_lock:
        _attempts.pop(f"{kind}:{key}", None)


# ── people ───────────────────────────────────────────────────────────────────
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s]{2,}$")


def _public(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "email": row["email"], "name": row["name"], "created": row["created"],
            "verified": bool(row["verified"]), "is_admin": bool(row["is_admin"]), "allowance": row["allowance"]}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def signup_code() -> str:
    """While testing, SIGNUP_CODE in .env keeps strangers from making accounts on your server."""
    return (os.getenv("SIGNUP_CODE") or "").strip()


def count() -> int:
    with _db() as db:
        return db.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def get(person_id: str) -> dict | None:
    with _db() as db:
        row = db.execute("SELECT * FROM users WHERE id = ?", (person_id,)).fetchone()
        return _public(row) if row else None


def log(person_id: str, event: str, detail: str = "", address: str = ""):
    """The account's own history: sign-ins, key changes and the like, shown to them on the Account page."""
    try:
        with _db() as db:
            db.execute("INSERT INTO audit (user_id, at, event, detail, address) VALUES (?, ?, ?, ?, ?)",
                       (person_id, _now(), event, detail[:200], address[:64]))
    except Exception:
        pass                                           # a note about what happened is never worth failing it


def history(person_id: str, limit: int = 40) -> list[dict]:
    with _db() as db:
        rows = db.execute("SELECT at, event, detail, address FROM audit WHERE user_id = ? ORDER BY id DESC LIMIT ?",
                          (person_id, limit)).fetchall()
        return [dict(row) for row in rows]


def sign_up(email: str, password: str, name: str = "", code: str = "", address: str = "") -> tuple[dict, str]:
    """A new account, signed in. Returns (the person, a session token)."""
    email = (email or "").strip().lower()
    throttle("signup", address or "-")
    if not _EMAIL.match(email):
        raise Problem("That email address does not look right.")
    _check_new_password(password)
    needed = signup_code()
    if needed and not hmac.compare_digest(needed.encode(), (code or "").strip().encode()):
        raise Problem("Sign-up needs an invite code, and that one is not right.", 403)
    person_id = secrets.token_hex(8)
    with _write, _db() as db:
        first = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        # With no way to send email, nobody can be asked to confirm theirs, so it is taken as it is. The first
        # account is the owner's own.
        verified = 1 if first or not mailer.configured() else 0
        try:
            db.execute("INSERT INTO users (id, email, name, password_hash, created, verified, is_admin) "
                       "VALUES (?, ?, ?, ?, ?, ?, ?)",
                       (person_id, email, (name or "").strip()[:80], hash_password(password), _now(), verified, int(first)))
        except sqlite3.IntegrityError:
            raise Problem("There is already an account with that email. Sign in instead.", 409) from None
        row = db.execute("SELECT * FROM users WHERE id = ?", (person_id,)).fetchone()
        token = _open_session(db, person_id)
    log(person_id, "Account made", address=address)
    if not verified:
        send_verification(person_id)
    return _public(row), token


def sign_in(email: str, password: str, address: str = "") -> tuple[dict, str]:
    email = (email or "").strip().lower()
    throttle("signin", address or "-", email or "-")
    with _write, _db() as db:
        row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        good = check_password(password or "", row["password_hash"] if row else _DECOY)
        if not row or not good:
            if row:
                log(row["id"], "Failed sign-in", address=address)
            raise Problem("That email and password do not match an account.", 401)
        if row["disabled"]:
            raise Problem("This account has been turned off.", 403)
        _forgive("signin", email)
        token = _open_session(db, row["id"])
        result = _public(row)
    log(result["id"], "Signed in", address=address)
    return result, token


def _open_session(db: sqlite3.Connection, person_id: str) -> str:
    token = secrets.token_urlsafe(32)
    db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
    db.execute("INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)",
               (_digest(token), person_id, _now(), time.time() + SESSION_DAYS * 86400))
    return token


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def user_for(token: str) -> dict | None:
    """Who a session token belongs to, or None if it is unknown, expired, or the account is off."""
    if not token:
        return None
    with _db() as db:
        row = db.execute("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
                         "WHERE s.token_hash = ? AND s.expires > ? AND u.disabled = 0",
                         (_digest(token), time.time())).fetchone()
        return _public(row) if row else None


def sign_out(token: str):
    if token:
        with _write, _db() as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (_digest(token),))


def sign_out_everywhere(person_id: str, keep_token: str = ""):
    with _write, _db() as db:
        db.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (person_id, _digest(keep_token) if keep_token else ""))


def cookie_header(token: str, *, secure: bool, clear: bool = False) -> str:
    age = 0 if clear else SESSION_DAYS * 86400
    parts = [f"{COOKIE}={'' if clear else token}", "Path=/", f"Max-Age={age}", "HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


# ── the account itself ───────────────────────────────────────────────────────
def update_profile(person_id: str, name: str) -> dict:
    with _write, _db() as db:
        db.execute("UPDATE users SET name = ? WHERE id = ?", ((name or "").strip()[:80], person_id))
        return _public(db.execute("SELECT * FROM users WHERE id = ?", (person_id,)).fetchone())


def _confirm(db: sqlite3.Connection, person_id: str, password: str, address: str) -> sqlite3.Row:
    throttle("password", person_id, address or "-")
    row = db.execute("SELECT * FROM users WHERE id = ?", (person_id,)).fetchone()
    if not row or not check_password(password or "", row["password_hash"]):
        raise Problem("That password is not right.", 403)
    return row


def change_password(person_id: str, current: str, new: str, keep_token: str = "", address: str = ""):
    """Needs the current password, and signs every other device out."""
    _check_new_password(new)
    with _write, _db() as db:
        _confirm(db, person_id, current, address)
        db.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new), person_id))
    sign_out_everywhere(person_id, keep_token)
    log(person_id, "Password changed", "other devices were signed out", address)


def check_own_password(person_id: str, password: str, address: str = ""):
    """For actions that need the password again (deleting the account)."""
    with _db() as db:
        _confirm(db, person_id, password, address)


def delete_account(person_id: str):
    """The account and everything of it kept here. The files in its folder are removed by the caller."""
    with _write, _db() as db:
        for table in ("usage", "audit"):
            db.execute(f"DELETE FROM {table} WHERE user_id = ?", (person_id,))
        db.execute("DELETE FROM users WHERE id = ?", (person_id,))      # sessions, tokens and keys go with it


# ── emailed links: confirm an address, reset a password ─────────────────────
def _issue(db: sqlite3.Connection, person_id: str, kind: str, hours: int) -> str:
    token = secrets.token_urlsafe(32)
    db.execute("DELETE FROM tokens WHERE user_id = ? AND kind = ?", (person_id, kind))     # only the latest link works
    db.execute("DELETE FROM tokens WHERE expires < ?", (time.time(),))
    db.execute("INSERT INTO tokens (hash, user_id, kind, expires) VALUES (?, ?, ?, ?)",
               (_digest(token), person_id, kind, time.time() + hours * 3600))
    return token


def _take(db: sqlite3.Connection, token: str, kind: str) -> str:
    """The person a link is for. A link works once."""
    row = db.execute("SELECT user_id FROM tokens WHERE hash = ? AND kind = ? AND expires > ?",
                     (_digest(token or ""), kind, time.time())).fetchone()
    if not row:
        raise Problem("That link has expired or was already used. Ask for a new one.", 400)
    db.execute("DELETE FROM tokens WHERE hash = ?", (_digest(token),))
    return row["user_id"]


def send_verification(person_id: str):
    with _write, _db() as db:
        row = db.execute("SELECT email, name, verified FROM users WHERE id = ?", (person_id,)).fetchone()
        if not row or row["verified"]:
            return
        token = _issue(db, person_id, "verify", 48)
    mailer.send(row["email"], "Confirm your email",
                f"Hello {row['name'] or ''},\n\nConfirm your email to start using Voice Call:\n\n"
                f"{mailer.link('/verify', token)}\n\nThe link works for 48 hours. If you did not make an account, ignore this.")


def verify_email(token: str) -> dict:
    with _write, _db() as db:
        person_id = _take(db, token, "verify")
        db.execute("UPDATE users SET verified = 1 WHERE id = ?", (person_id,))
    log(person_id, "Email confirmed")
    return get(person_id)


def request_reset(email: str, address: str = ""):
    """Always looks the same to the caller, so it cannot be used to find out who has an account."""
    email = (email or "").strip().lower()
    throttle("reset", address or "-", email or "-")
    with _write, _db() as db:
        row = db.execute("SELECT id, name FROM users WHERE email = ? AND disabled = 0", (email,)).fetchone()
        token = _issue(db, row["id"], "reset", 1) if row else None
    if row:
        log(row["id"], "Password reset asked for", address=address)
        mailer.send(email, "Reset your password",
                    f"Hello {row['name'] or ''},\n\nSomeone asked to reset the password on this account. "
                    f"If it was you, choose a new one here:\n\n{mailer.link('/reset', token)}\n\n"
                    "The link works once, for an hour. If it was not you, ignore this and nothing changes.")


def reset_password(token: str, new: str, address: str = ""):
    _check_new_password(new)
    throttle("reset", address or "-")
    with _write, _db() as db:
        person_id = _take(db, token, "reset")
        db.execute("UPDATE users SET password_hash = ?, verified = 1 WHERE id = ?", (hash_password(new), person_id))
    sign_out_everywhere(person_id)
    log(person_id, "Password reset", "every device was signed out", address)


# ── the default account ──────────────────────────────────────────────────────
DEFAULT_EMAIL = "admin@voicecall.local"
DEFAULT_PASSWORD = "voicecall-admin"          # known to anyone who reads this file: for one's own machine only


def default_credentials() -> tuple[str, str]:
    return ((os.getenv("DEFAULT_ADMIN_EMAIL") or DEFAULT_EMAIL).strip().lower(),
            os.getenv("DEFAULT_ADMIN_PASSWORD") or DEFAULT_PASSWORD)


def _looks_public() -> bool:
    url = (os.getenv("PUBLIC_URL") or "").lower()
    return os.getenv("COOKIE_SECURE") == "1" or (url.startswith("http") and not any(
        host in url for host in ("127.0.0.1", "localhost", "[::1]")))


def ensure_default() -> tuple[dict | None, str]:
    """Makes sure the default account exists, so there is always one to sign in with. Returns (the account if it was
    made just now, else None; a note for the console). An account that exists is left exactly as it is, so a password
    changed since is never put back.

    The built-in password is public (it is in this file), so on a server that looks public it is not used:
    set DEFAULT_ADMIN_PASSWORD in .env, or no default account is made.
    """
    email, password = default_credentials()
    if (os.getenv("DISABLE_DEFAULT_ADMIN") or "") == "1":
        return None, ""
    if password == DEFAULT_PASSWORD and _looks_public():
        return None, "No default account: this looks like a public server and the built-in password is public. Set DEFAULT_ADMIN_PASSWORD in .env."
    if len(password) < MIN_PASSWORD or not _EMAIL.match(email):
        return None, "No default account: DEFAULT_ADMIN_EMAIL or DEFAULT_ADMIN_PASSWORD is not valid (the password needs 10 or more characters)."
    person_id = secrets.token_hex(8)
    with _write, _db() as db:
        if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            return None, ""
        first = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        db.execute("INSERT INTO users (id, email, name, password_hash, created, verified, is_admin) VALUES (?, ?, 'Admin', ?, ?, 1, ?)",
                   (person_id, email, hash_password(password), _now(), int(first)))
        row = db.execute("SELECT * FROM users WHERE id = ?", (person_id,)).fetchone()
    log(person_id, "Default account made")
    return _public(row), f"Default account: {email}" + (f" / {password}" if password == DEFAULT_PASSWORD else " (password from .env)")


# ── for the person running the server ───────────────────────────────────────
def everyone() -> list[dict]:
    with _db() as db:
        return [_public(row) | {"disabled": bool(row["disabled"])}
                for row in db.execute("SELECT * FROM users ORDER BY created").fetchall()]


def administer(person_id: str, *, allowance: float | None | str = "keep", disabled: bool | None = None):
    """Change one account's monthly allowance (None = the default) or turn it off or on."""
    with _write, _db() as db:
        if not db.execute("SELECT 1 FROM users WHERE id = ?", (person_id,)).fetchone():
            raise Problem("There is no such account.", 404)
        if allowance != "keep":
            db.execute("UPDATE users SET allowance = ? WHERE id = ?", (allowance, person_id))
        if disabled is not None:
            db.execute("UPDATE users SET disabled = ? WHERE id = ?", (int(disabled), person_id))
            if disabled:
                db.execute("DELETE FROM sessions WHERE user_id = ?", (person_id,))
    log(person_id, "Changed by the administrator", f"allowance={allowance} disabled={disabled}")
