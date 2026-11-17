"""Which key pays for a request: the person's own, or ours.

Our keys come from the server's environment and never leave it. A person's own keys are checked once with the
provider, then stored encrypted (see vault.py), tied to their account. They are write-only: nothing sends a key
back to the browser, only its last four characters. A key is decrypted for the one request that uses it.

If a person has switched to their own key and it stops working, the request fails and says so. It never quietly
falls back to ours, which would spend credit they did not agree to.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

from . import accounts, scope, usage, vault

SERVICES = {
    "gemini": {"label": "Gemini", "does": "Thinking: reads what the customer said and decides what to say next.",
               "env": "GEMINI_API_KEY", "where": "https://aistudio.google.com/apikey"},
    "elevenlabs": {"label": "ElevenLabs", "does": "Speaking and hearing: the voice on the call.",
                   "env": "ELEVENLABS_API_KEY", "where": "https://elevenlabs.io/app/settings/api-keys"},
}
_SHAPE = re.compile(r"[A-Za-z0-9_\-.]{16,200}")          # also keeps anything odd out of the header it is sent in


class Blocked(Exception):
    """A request that cannot go ahead because of the account, not the system: shown to the person as written."""

    def __init__(self, message: str, status: int = 402):
        super().__init__(message)
        self.status = status


def ours(service: str) -> str:
    return (os.getenv(SERVICES[service]["env"]) or "").strip()


def _context(person_id: str, service: str) -> str:
    return f"api-key:{person_id}:{service}"


def _own(person_id: str, service: str, only_active: bool = True) -> str | None:
    with accounts._db() as db:
        row = db.execute("SELECT sealed, active FROM api_keys WHERE user_id = ? AND service = ?",
                         (person_id, service)).fetchone()
    if not row or (only_active and not row["active"]):
        return None
    try:
        return vault.unseal(row["sealed"], _context(person_id, service))
    except vault.Unreadable:
        raise Blocked(f"Your saved {SERVICES[service]['label']} key can no longer be read. "
                      "Add it again in Account, API keys.", 400) from None


def available(service: str) -> bool:
    """Whether something could pay for this service for the current person (nothing is spent, nothing is decrypted)."""
    person = scope.owner()
    with accounts._db() as db:
        active = db.execute("SELECT 1 FROM api_keys WHERE user_id = ? AND service = ? AND active = 1",
                            (person, service)).fetchone()
    return bool(active or ours(service))


def resolve(service: str) -> tuple[str, str]:
    """The key to use for the current person's next request, and whose it is: (key, "own" | "ours").

    On our key, this also checks the person is allowed: email confirmed, and this month's allowance not used up.
    """
    person = scope.owner()
    mine = _own(person, service)
    if mine:
        return mine, "own"
    label = SERVICES[service]["label"]
    key = ours(service)
    if not key:
        raise Blocked(f"There is no {label} key to use. Add your own in Account, API keys.")
    who = accounts.get(person)
    if not who or not who["verified"]:
        raise Blocked("Confirm your email first (we sent you a link), or add your own keys in Account, API keys.", 403)
    used, limit = usage.used_this_month(person), usage.allowance_for(who)
    if used >= limit:
        raise Blocked(f"You have used this month's free allowance (about ${limit:.2f}). Add your own {label} key in "
                      "Account, API keys to carry on, or wait for it to reset next month.")
    return key, "ours"


def refuse_if_over_allowance():
    """Checked before a call starts, so a call is not begun that cannot be paid for."""
    for service in SERVICES:
        resolve(service)


# ── what the Account page shows ──────────────────────────────────────────────
def status(person_id: str) -> dict:
    with accounts._db() as db:
        rows = {row["service"]: dict(row) for row in db.execute(
            "SELECT service, last4, active, created FROM api_keys WHERE user_id = ?", (person_id,)).fetchall()}
    found = {}
    for service, info in SERVICES.items():
        row = rows.get(service)
        found[service] = {"label": info["label"], "does": info["does"], "where": info["where"],
                          "ours_available": bool(ours(service)),
                          "has_own": bool(row), "last4": row["last4"] if row else "", "added": row["created"] if row else "",
                          "mode": "own" if row and row["active"] else "ours"}
    return found


# ── saving, switching and removing ───────────────────────────────────────────
def check(service: str, key: str) -> str:
    """Asks the provider whether this key works, with the smallest request there is. Returns a note for the person
    (or "") when it works, and raises Blocked with the reason when it does not."""
    label = SERVICES[service]["label"]
    if service == "gemini":
        from google import genai
        from google.genai import errors, types
        try:
            genai.Client(api_key=key, http_options=types.HttpOptions(timeout=15_000)).models.generate_content(
                model="gemini-3.1-flash-lite", contents="Reply with the word ok.",
                config=types.GenerateContentConfig(max_output_tokens=8))
            return ""
        except errors.APIError as exc:
            if exc.code == 429:
                return "The key works, but Google says it is out of quota right now."
            if exc.code in (400, 401, 403):
                raise Blocked("Google did not accept that key. Check you copied all of it.", 400) from None
            raise Blocked(f"Google could not check the key just now (it answered {exc.code}). Try again in a moment.", 502) from None
        except Exception:
            raise Blocked("Could not reach Google to check the key. Try again in a moment.", 502) from None
    request = urllib.request.Request("https://api.elevenlabs.io/v1/models", headers={"xi-api-key": key})
    try:
        with urllib.request.urlopen(request, timeout=15):
            return ""
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            try:
                status = (json.loads(exc.read()).get("detail") or {}).get("status", "")
            except Exception:
                status = ""
            if status == "missing_permissions":      # a key limited to certain things: valid, just not for this check
                return "The key was accepted, but it is limited. Speaking and hearing need those permissions switched on."
            raise Blocked(f"{label} did not accept that key. Check you copied all of it.", 400) from None
        raise Blocked(f"{label} could not check the key just now (it answered {exc.code}). Try again in a moment.", 502) from None
    except Exception:
        raise Blocked(f"Could not reach {label} to check the key. Try again in a moment.", 502) from None


def save(person_id: str, service: str, key: str, address: str = "") -> str:
    if service not in SERVICES:
        raise Blocked("That is not a service we use.", 400)
    key = (key or "").strip()
    if not _SHAPE.fullmatch(key):
        raise Blocked("That does not look like a key. Paste the whole thing, with no spaces.", 400)
    accounts.throttle("password", person_id, address or "-")        # each check is a real request: no hammering it
    note = check(service, key)
    with accounts._write, accounts._db() as db:
        db.execute("INSERT INTO api_keys (user_id, service, sealed, last4, active, created) VALUES (?, ?, ?, ?, 1, ?) "
                   "ON CONFLICT(user_id, service) DO UPDATE SET sealed = excluded.sealed, last4 = excluded.last4, "
                   "active = 1, created = excluded.created",
                   (person_id, service, vault.seal(key, _context(person_id, service)), key[-4:], accounts._now()))
    accounts.log(person_id, f"{SERVICES[service]['label']} key added", f"ending {key[-4:]}", address)
    return note


def set_mode(person_id: str, service: str, mode: str, address: str = ""):
    if service not in SERVICES or mode not in ("ours", "own"):
        raise Blocked("That is not something that can be changed.", 400)
    with accounts._write, accounts._db() as db:
        if mode == "own":
            if db.execute("UPDATE api_keys SET active = 1 WHERE user_id = ? AND service = ?", (person_id, service)).rowcount == 0:
                raise Blocked(f"Add your {SERVICES[service]['label']} key first.", 400)
        else:
            db.execute("UPDATE api_keys SET active = 0 WHERE user_id = ? AND service = ?", (person_id, service))
    accounts.log(person_id, f"{SERVICES[service]['label']} now uses " + ("your own key" if mode == "own" else "our key"),
                 address=address)


def remove(person_id: str, service: str, address: str = ""):
    if service not in SERVICES:
        raise Blocked("That is not a service we use.", 400)
    with accounts._write, accounts._db() as db:
        db.execute("DELETE FROM api_keys WHERE user_id = ? AND service = ?", (person_id, service))
    accounts.log(person_id, f"{SERVICES[service]['label']} key removed", address=address)
