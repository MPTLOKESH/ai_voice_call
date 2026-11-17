"""The browser UI: a page to set the assistant up, and a page to call it.

A turn is one request. The reply text comes back immediately, then the speech streams in the same response, so
the customer hears the first words while the rest is still being made.

Response shape for a turn:  {json line}\n followed by raw 24 kHz 16-bit audio.

Built on the standard library, so nothing extra needs installing. Run it with:  python -m voice_call
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from pydantic import ValidationError

from . import accounts, contacts, credentials, engine, gemini, mailer, results, scope, settings, sources, storage, usage, voices
from .models import KEPT_VERSIONS, BusinessSetup, Call, Version
from .assist import assist, rewrite_context, suggest_next
from .suggestions import reword, suggest_questions

calls: dict[str, Call] = {}
lock = threading.Lock()
# Saving a flow reads it, changes it and writes it back. Two of those at once (an autosave and a publish) would
# each start from the same stored copy, and the second write would silently drop the first one's change.
flow_lock = threading.RLock()

# One turn of a call at a time. Nothing stopped a second turn being sent while the first was still
# thinking — talking over the reply does exactly that — and two threads then ran `reply_to` on the same
# call at once, interleaving the answers they saved and the step they moved it to.
_turns: dict[str, threading.Lock] = {}


def turn_lock(call_id: str) -> threading.Lock:
    with lock:
        return _turns.setdefault(call_id, threading.Lock())


take_notices = gemini.take_notices


def check_setup(setup: BusinessSetup) -> list[str]:
    """Plain rules, so a broken setup fails here rather than in front of a customer."""
    problems = []
    if not any(q.kind == "ask" for q in setup.questions):
        problems.append("Add at least one question.")
    if not setup.purpose.strip():
        problems.append("Say why the call is being made, in the opening step.")
    names = [q.save_as for q in setup.questions]
    for name in sorted({n for n in names if names.count(n) > 1}):
        problems.append(f"Two steps share the column name '{name}'. Give one of them another in its More options.")
    for q in setup.questions:
        if not q.save_as.isidentifier():
            problems.append(f"The column name '{q.save_as}' can only use letters, numbers and underscores.")
        if q.kind == "ask" and q.type == "choice" and len(q.options) < 2:
            problems.append(f"A choice question needs at least two options ('{q.ask or q.save_as}').")
        if q.kind == "say" and not q.ask.strip():
            problems.append("A message step is empty: write what it should say.")
        if q.kind == "loop" and not q.only_if:
            problems.append("A go-back step needs a condition, or it would go back on every call.")
    for at, q in enumerate(setup.questions):
        # Only an earlier question, so no two questions can each wait for the other.
        above = [other.save_as for other in setup.questions[:at] if other.kind == "ask"]
        if q.kind == "loop" and q.back_to not in above:
            problems.append("A go-back step needs a question above it to go back to.")
        if not q.only_if:
            continue
        if q.only_if not in above:
            problems.append(f"'{q.ask or q.save_as}' can only wait on a question above it.")
        elif not q.only_if_is:
            problems.append(f"Say which answer to the earlier question makes '{q.ask or q.save_as}' get asked.")
    return problems


SETTING_NAMES = {"speaking_speed": "Speed", "tries_per_question": "Ask again up to", "silences_before_ending": "Hang up after",
                 "wait_after_speech_ms": "Wait before replying", "max_minutes": "Call length", "tone": "Tone",
                 "reply_length": "How much it says", "formality": "Formality", "language": "Language"}


def explain(failure: ValidationError) -> str:
    """The first thing wrong with a setup, in plain words: "Speed can't be more than 1.2"."""
    first = failure.errors()[0]
    name = next((SETTING_NAMES[str(part)] for part in reversed(first["loc"]) if str(part) in SETTING_NAMES), "")
    context = first.get("ctx") or {}
    if name and "le" in context:
        return f"{name} can't be more than {context['le']}."
    if name and "ge" in context:
        return f"{name} can't be less than {context['ge']}."
    if name:
        return f"{name}: that value can't be used."
    where = ".".join(str(part) for part in first["loc"])
    return f"{where}: {first['msg']}" if where else first["msg"]


FALLBACK_LINE = "Sorry, I missed that. Could you say it again?"
ABANDONED_AFTER = 180      # seconds without a turn before a call is treated as hung up
REMEMBER_CALLS = 20        # finished calls kept in memory, so the page can still read them


def finish(call: Call):
    """Summarise, save again with the summary, and let old calls go. Done as the call's owner."""
    with scope.acting_as(call.owner), usage.tagged("summary", call.flow_id):
        _finish(call)


def _finish(call: Call):
    try:
        call.summary = engine.summarise(call).model_dump() if len(call.transcript) > 1 else None
    except Exception as exc:                      # a summary is not worth losing the call over
        call.note(f"summary failed: {exc}")
    # Nothing is listening for these any more — the browser has had its last reply — so they go into the
    # call's own log, where the saved file will keep them.
    for notice in take_notices():
        call.note(notice)
    if call.opt_out and call.customer.get("id") and not call.test:
        try:
            contacts.set_opted_out([call.customer["id"]], True)
            call.note("opted the contact out: they asked not to be called again")
        except Exception as exc:
            call.note(f"could not opt the contact out: {exc}")
    call.note(f"saved to {storage.save_call(call)}")

    with lock:
        finished = [c for c in calls.values() if c.outcome]
        for old in finished[:-REMEMBER_CALLS]:
            calls.pop(old.id, None)
            _turns.pop(old.id, None)


def whole(query: dict, key: str, default: int, low: int, high: int) -> int:
    """A number from the query string, kept in range. Anything that isn't a number is the default."""
    try:
        return min(max(int(query.get(key) or default), low), high)
    except ValueError:
        return default


def close_abandoned(call: Call, why: str):
    """A call nobody finished: mark it, save what it has, and let it go. Safe to run twice."""
    if not turn_lock(call.id).acquire(blocking=False):
        return                                        # a turn is being handled right now: it is not abandoned
    try:
        if call.outcome:
            return
        call.outcome = "incomplete" if call.missing_required() else "completed"
        call.end_reason, call.step = "hung up", "finish"
        call.note(f"call closed: {why}")
        finish(call)
    finally:
        turn_lock(call.id).release()


def sweep_forever():
    """Every half minute, close calls that have gone quiet for good (a closed laptop, a lost connection)."""
    while True:
        time.sleep(30)
        try:
            with lock:
                stale = [c for c in calls.values() if not c.outcome and time.monotonic() - c.last_active > ABANDONED_AFTER]
            for call in stale:
                close_abandoned(call, f"no word for {ABANDONED_AFTER // 60} minutes")
        except Exception:
            traceback.print_exc()


MAX_JSON = 2 * 1024 * 1024            # a setup, a contact, a message
MAX_UPLOAD = 25 * 1024 * 1024         # a contacts file, or a recording of one turn

# What a page may load and do. Everything it uses is served from here: the app, its fonts, the voice model (and
# the WebAssembly that runs it). Nothing from elsewhere runs, and nothing may put this page in a frame.
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
                               "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: data:; "
                               "media-src 'self' blob: data:; worker-src 'self' blob:; object-src 'none'; "
                               "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}


class TooLarge(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "voice_call"
    protocol_version = "HTTP/1.1"                 # needed for a streamed reply

    def end_headers(self):
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        if self.secure_cookie():
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        super().end_headers()

    def begin(self):
        """The start of every request. One handler serves every request on a connection, so nothing from the last
        one may be left over: not who it was, and not what it was for."""
        scope.set_owner("")
        usage.set_tag("other")

    def log_message(self, format, *args):         # quieter console
        pass

    # ── sending ──────────────────────────────────────────────────────────────
    def send_json(self, data, status=200, headers=None):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    # ── who is asking ────────────────────────────────────────────────────────
    def session_token(self) -> str:
        jar = SimpleCookie()
        try:
            jar.load(self.headers.get("Cookie", ""))
        except Exception:
            return ""
        return jar[accounts.COOKIE].value if accounts.COOKIE in jar else ""

    def current_user(self):
        """The signed-in person, or None. Looked up afresh each time: a connection is reused for many requests."""
        return accounts.user_for(self.session_token())

    def secure_cookie(self) -> bool:
        # Behind HTTPS (a proxy says so) the cookie is marked Secure; on http://127.0.0.1 it cannot be.
        return self.headers.get("X-Forwarded-Proto", "") == "https" or os.getenv("COOKIE_SECURE") == "1"

    def same_origin(self) -> bool:
        """A write must come from this site's own pages. SameSite cookies already stop most forgeries; this closes the rest."""
        origin = self.headers.get("Origin")
        if not origin:
            return True                                # not a browser cross-site request: scripts and tools send none
        return urlparse(origin).netloc == self.headers.get("Host", "")

    def auth_route(self, route: str) -> bool:
        """/api/auth/*: who you are, and signing in, up and out. Returns True when the route was one of these."""
        if route == "/api/auth/me":
            user = self.current_user()
            self.send_json({"user": user, "needs_code": bool(accounts.signup_code()),
                            "first": user is None and accounts.count() == 0})
            return True
        if not route.startswith("/api/auth/") or self.command != "POST":
            return False
        data = self.body()
        address = self.client_address[0]
        try:
            if route == "/api/auth/signup":
                was_empty = accounts.count() == 0
                user, token = accounts.sign_up(data.get("email"), data.get("password"), data.get("name") or "",
                                               data.get("code") or "", address)
                if was_empty:
                    scope.adopt_legacy(user["id"])    # what was made before accounts existed becomes theirs
            elif route == "/api/auth/signin":
                user, token = accounts.sign_in(data.get("email"), data.get("password"), address)
            elif route == "/api/auth/verify":
                accounts.verify_email(str(data.get("token") or ""))
                self.send_json({"ok": True})
                return True
            elif route == "/api/auth/forgot":
                accounts.request_reset(data.get("email"), address)
                self.send_json({"ok": True})                 # the same answer whether or not there is such an account
                return True
            elif route == "/api/auth/reset":
                accounts.reset_password(str(data.get("token") or ""), str(data.get("password") or ""), address)
                self.send_json({"ok": True})
                return True
            elif route == "/api/auth/signout":
                accounts.sign_out(self.session_token())
                self.send_json({"ok": True}, headers={"Set-Cookie": accounts.cookie_header("", secure=self.secure_cookie(), clear=True)})
                return True
            else:
                return False
        except accounts.Problem as problem:
            self.send_json({"error": str(problem)}, problem.status)
            return True
        self.send_json({"user": user}, headers={"Set-Cookie": accounts.cookie_header(token, secure=self.secure_cookie())})
        return True

    def own_call(self, call_id: str):
        """A call in progress, only if it is the signed-in person's: someone else's looks like no call at all."""
        call = calls.get(call_id)
        return call if call is not None and call.owner == scope.owner() else None

    def need_user(self):
        """Everything under /api/ except signing in belongs to someone. Returns the person, or sends a 401 and returns None."""
        user = self.current_user()
        if user is None:
            scope.set_owner("")
            self.send_json({"error": "Sign in to continue.", "signin": True}, 401)
        else:
            scope.set_owner(user["id"])           # everything stored from here on is this person's
        return user

    def send_file(self, name: str):
        path = (settings.WEB_FOLDER / name).resolve()
        if not path.is_file() or settings.WEB_FOLDER.resolve() not in path.parents:
            return self.send_json({"error": f"{name} not found"}, 404)
        # A wasm file served as text/plain is refused by the browser's streaming compiler, and the VAD
        # model would never load.
        kind = {"html": "text/html", "js": "text/javascript", "mjs": "text/javascript",
                "css": "text/css", "svg": "image/svg+xml", "json": "application/json",
                "wasm": "application/wasm", "onnx": "application/octet-stream"}.get(
            name.rsplit(".", 1)[-1], "text/plain")
        # A charset only means something for text. On the wasm file it made the type "application/wasm;
        # charset=utf-8", which the browser's fast streaming compile refuses as the wrong type.
        if kind.startswith("text/") or kind in ("application/json", "image/svg+xml"):
            kind += "; charset=utf-8"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        # The page itself is never cached, so a rebuilt UI reaches the person testing it on the next
        # reload. What it loads can be: the build names every file in assets/ after its contents, so an
        # edit arrives under a new name, and the vendored voice model never changes.
        # `name` has no leading slash: "assets/…", "vendor/…", "index.html".
        lasting = name.replace("\\", "/").startswith(("assets/", "vendor/"))
        self.send_header("Cache-Control", "public, max-age=86400" if lasting else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def start_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

    def write_chunk(self, data: bytes):
        self.wfile.write(f"{len(data):X}\r\n".encode())
        self.wfile.write(data)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def end_stream(self):
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    # ── receiving ────────────────────────────────────────────────────────────
    def _read(self, limit: int) -> bytes:
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = -1
        if size < 0 or size > limit:
            self.close_connection = True                 # the rest of it is not read, so the connection cannot be reused
            raise TooLarge()
        return self.rfile.read(size)

    def body(self) -> dict:
        data = json.loads(self._read(MAX_JSON) or "{}")
        if not isinstance(data, dict):
            raise ValueError("expected an object")
        return data

    def raw_body(self) -> bytes:
        return self._read(MAX_UPLOAD)

    # ── pages ────────────────────────────────────────────────────────────────
    def do_GET(self):
        url = urlparse(self.path)
        route = url.path
        self.begin()
        try:
            if route in ("/", "/drafts", "/studio", "/voices", "/call", "/history", "/contacts", "/results",
                         "/account", "/verify", "/reset"):
                return self.send_file("index.html")     # one page: the page shown is chosen in the browser
            # The built UI (frontend/, built into web/): its scripts and styles, the voice model, the icon.
            if route.startswith(("/assets/", "/vendor/")) or route == "/favicon.svg":
                return self.send_file(route.removeprefix("/"))
            if route.startswith("/api/") and not self.auth_route(route) and self.need_user() is None:
                return
            if route.startswith("/api/auth/"):
                if route != "/api/auth/me":
                    self.send_json({"error": "unknown route"}, 404)
                return
            if route.startswith(("/api/account", "/api/admin")):
                return self.account_read(route, {key: values[0] for key, values in parse_qs(url.query).items()})
            if route == "/api/flows":
                return self.send_json({"flows": [flow.model_dump() for flow in storage.list_flows()]})
            if route == "/api/calls":
                query = {key: values[0] for key, values in parse_qs(url.query).items()}
                return self.send_json(storage.recent_calls(
                    limit=whole(query, "limit", 20, 1, 100), offset=whole(query, "offset", 0, 0, 10**9),
                    flow=query.get("flow", ""), outcome=query.get("outcome", ""), contact=query.get("contact", "")))
            if route == "/api/contacts" or route.startswith("/api/contacts/"):
                return self.contacts_read(route.removeprefix("/api/contacts").strip("/"),
                                          {key: values[0] for key, values in parse_qs(url.query).items()})
            if route == "/api/stats":
                return self.send_json(results.stats(tests="tests" in parse_qs(url.query)))
            if route.startswith("/api/flows/") and route.count("/") == 4:
                return self.flow_read(route.split("/")[3], route.split("/")[4], "tests" in parse_qs(url.query))
            if route == "/api/models":
                return self.send_json({"models": gemini.current})
            if route == "/api/voices":
                return self.send_json({"voices": voices.choices(), "default": settings.ELEVEN_VOICE})
            return self.send_json({"error": "unknown route"}, 404)
        except credentials.Blocked as exc:
            return self.send_json({"error": str(exc), "blocked": True}, exc.status)
        except Exception as exc:
            traceback.print_exc()
            return self.send_json({"error": str(exc)}, 500)

    # ── actions ──────────────────────────────────────────────────────────────
    def do_POST(self):
        route = urlparse(self.path).path
        self.begin()
        try:
            if not self.same_origin():
                return self.send_json({"error": "That request did not come from this site."}, 403)
            if route.startswith("/api/auth/"):
                if self.auth_route(route):
                    return
            elif self.need_user() is None:
                return
            if route.startswith(("/api/account", "/api/admin")):
                return self.account_action(route, self.body())
            if route in ("/api/suggest", "/api/suggest/reword") or route.startswith("/api/assist"):
                usage.set_tag("studio")
            if route == "/api/hear":
                usage.set_tag("voice")
            if route == "/api/flows":
                data = self.body()
                setup = BusinessSetup(**data["setup"]) if data.get("setup") else None
                return self.send_json(storage.new_flow(data.get("name") or "Untitled flow", setup).model_dump())

            if route == "/api/flows/delete":
                with flow_lock:
                    ids = [str(i) for i in (self.body().get("ids") or [])][:500]
                    gone = []
                    for one in dict.fromkeys(ids):
                        try:
                            storage.get_flow(one)
                        except KeyError:
                            continue
                        storage.delete_flow(one)
                        gone.append(one)
                return self.send_json({"deleted": gone})

            if route == "/api/calls/delete":
                ids = [str(i) for i in (self.body().get("ids") or [])][:500]
                return self.send_json({"deleted": storage.delete_calls(ids)})

            if route.startswith("/api/flows/"):
                return self.flow_action(route.removeprefix("/api/flows/"))

            if route == "/api/contacts" or route.startswith("/api/contacts/"):
                return self.contacts_action(route.removeprefix("/api/contacts").strip("/"))

            if route == "/api/suggest":
                found = suggest_questions(BusinessSetup(**self.body()))
                return self.send_json({"questions": [q.model_dump() for q in found], "notices": take_notices()})

            if route == "/api/suggest/reword":
                data = self.body()
                options = reword(BusinessSetup(**data["setup"]), data.get("text") or "", data.get("kind") or "ask")
                return self.send_json({"options": options, "notices": take_notices()})

            if route == "/api/assist/next":
                data = self.body()
                found = suggest_next(BusinessSetup(**data["setup"]), str(data.get("after") or ""))
                return self.send_json({"options": [q.model_dump() for q in found], "notices": take_notices()})

            if route == "/api/assist/context":
                found = rewrite_context(str(self.body().get("text") or ""))
                return self.send_json({"text": found, "notices": take_notices()})

            if route == "/api/assist":
                data = self.body()
                messages = [m for m in data.get("messages") or [] if isinstance(m, dict)]
                refs = [str(r) for r in data.get("refs") or []]
                found = assist(BusinessSetup(**data["setup"]), messages, refs)
                return self.send_json({**found, "notices": take_notices()})

            if route == "/api/hear":
                return self.hear_voice()

            if route == "/api/call/start":
                return self.start_call()

            if route == "/api/call/turn":
                return self.take_turn()

            if route == "/api/call/end":
                # The page was closed mid-call. The browser sends this as it leaves, so nobody reads the answer.
                call = self.own_call(str(self.body().get("call") or ""))
                if call is not None:
                    close_abandoned(call, "the page was closed")
                return self.send_json({"ok": True})

            return self.send_json({"error": "unknown route"}, 404)
        except ValidationError as exc:
            return self.send_json({"error": explain(exc)}, 400)
        except contacts.Problem as exc:
            return self.send_json({"error": str(exc)}, 400)
        except TooLarge:
            return self.send_json({"error": "That is too big to send."}, 413)
        except credentials.Blocked as exc:
            return self.send_json({"error": str(exc), "blocked": True}, exc.status)
        except (json.JSONDecodeError, KeyError, ValueError) as exc:
            return self.send_json({"error": f"the request was not understood: {exc}"}, 400)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # The browser stopped listening mid-reply. That is what talking over the assistant looks
            # like from here, so it is ordinary: there is nobody left to send an error to.
            return
        except Exception as exc:
            traceback.print_exc()
            return self.send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def flow_action(self, rest: str):
        with flow_lock:
            return self._flow_action(rest)

    def _flow_action(self, rest: str):
        """/api/flows/<id> saves the draft; /<id>/publish, /<id>/discard and /<id>/delete do what they say."""
        flow_id, _, action = rest.partition("/")
        try:
            flow = storage.get_flow(flow_id)
        except KeyError:
            return self.send_json({"error": "that flow does not exist"}, 404)
        data = self.body()

        if action == "delete":
            storage.delete_flow(flow_id)
            return self.send_json({"deleted": flow_id})

        if action == "duplicate":
            copy = storage.new_flow(f"{flow.name} (copy)", flow.setup.model_copy(deep=True))
            copy.groups, copy.channels = list(flow.groups), list(flow.channels)
            return self.send_json(storage.save_flow(copy, touch=False).model_dump())

        if action == "restore":
            # An earlier published version becomes the draft. Nothing goes live until it is published again.
            version = next((one for one in flow.history if one.at == data.get("at")), None)
            if version is None:
                return self.send_json({"error": "That version is no longer kept."}, 404)
            flow.setup = version.setup.model_copy(deep=True)
            return self.send_json(storage.save_flow(flow).model_dump())

        if action == "unpublish":
            # Back to a draft: nothing is live or scheduled. The choices made when publishing are kept.
            flow.status, flow.published, flow.scheduled_for = "Draft", None, ""
            return self.send_json(storage.save_flow(flow).model_dump())

        if action == "discard":
            # Back to what is live: the draft's edits since the last publish are dropped.
            if flow.published is None:
                return self.send_json({"error": "It has never been published, so there is nothing to go back to."}, 400)
            flow.setup = flow.published.model_copy(deep=True)
            return self.send_json(storage.save_flow(flow).model_dump())

        if action == "publish":
            channels = [c for c in data.get("channels") or [] if c in ("Website", "WhatsApp", "Call")]
            when = "Schedule" if data.get("when") == "Schedule" else "Now"
            if not channels:
                return self.send_json({"error": "Pick at least one place for it to go."}, 400)
            at = (data.get("scheduled_for") or "").strip()
            if when == "Schedule":
                if not at:
                    return self.send_json({"error": "Pick a date and time to schedule it for."}, 400)
                try:
                    moment = datetime.fromisoformat(at)
                except ValueError:
                    return self.send_json({"error": "That date and time could not be read."}, 400)
                # A minute's grace, for a time picked just before pressing Publish.
                if moment.tzinfo is None and moment < datetime.now() - timedelta(minutes=1):
                    return self.send_json({"error": "That time has already passed. Pick one in the future."}, 400)
            problems = check_setup(flow.setup)
            if problems:
                return self.send_json({"error": " ".join(problems)}, 400)
            known = {group["id"] for group in contacts.list_groups()["groups"]}
            groups = [group for group in dict.fromkeys(data.get("groups") or []) if group in known]
            # The website widget is opened by whoever visits; calls and WhatsApp go to people, who must be named.
            if not groups and any(channel in ("WhatsApp", "Call") for channel in channels):
                return self.send_json({"error": "Pick the groups of contacts it goes to."}, 400)
            flow.channels, flow.when, flow.groups = channels, when, groups
            flow.audience = (data.get("audience") or "").strip()
            flow.scheduled_for = at if when == "Schedule" else ""
            flow.status = "Scheduled" if when == "Schedule" else "Live"
            flow.published = flow.setup.model_copy(deep=True)
            flow.published_at = datetime.now().isoformat(timespec="seconds")
            # Publishing the same thing again is not a new version.
            if not flow.history or flow.history[0].setup != flow.published:
                flow.history.insert(0, Version(at=flow.published_at, name=flow.name, setup=flow.published))
                del flow.history[KEPT_VERSIONS:]
            return self.send_json(storage.save_flow(flow).model_dump())

        if action:
            return self.send_json({"error": "unknown route"}, 404)
        # Made from an older version than the one stored: another tab saved in between. Saving anyway would
        # throw that tab's work away without anyone knowing, so say so and send what is stored now.
        if data.get("version") is not None and int(data["version"]) != flow.version:
            return self.send_json({"error": "This flow was changed somewhere else.", "conflict": True,
                                   "flow": flow.model_dump()}, 409)
        flow.name = (data.get("name") or flow.name).strip() or flow.name
        if data.get("setup"):
            flow.setup = BusinessSetup(**data["setup"])
        return self.send_json(storage.save_flow(flow).model_dump())

    def flow_read(self, flow_id: str, what: str, tests: bool = False):
        """GET /api/flows/<id>/results, and /<id>/export.csv: one flow's answers, summed up or one row a call."""
        try:
            flow = storage.get_flow(flow_id)
        except KeyError:
            return self.send_json({"error": "that flow does not exist"}, 404)
        if what == "results":
            groups = flow.groups
            return self.send_json(results.flow_results(
                flow, contacts.audience(groups, results.called_contacts(flow_id)) if groups else {}, tests=tests))
        if what == "export.csv":
            body = ("\ufeff" + results.flow_csv(flow, tests=tests)).encode("utf-8")      # the mark makes Excel read it as UTF-8
            name = "".join(ch if ch.isalnum() else "-" for ch in flow.name).strip("-").lower() or "flow"
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{name}-results.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return self.send_json({"error": "unknown route"}, 404)

    # ── the account ──────────────────────────────────────────────────────────
    def need_admin(self):
        if not self.current_user()["is_admin"]:
            self.send_json({"error": "Only the person running this server can do that."}, 403)
            return False
        return True

    def account_read(self, route: str, query: dict):
        user = self.current_user()
        if route == "/api/account":
            me = accounts.get(user["id"])
            return self.send_json({"user": me, "plan": usage.plan(me), "keys": credentials.status(me["id"]),
                                   "mail": mailer.configured(), "default_allowance": settings.FREE_ALLOWANCE_USD,
                                   "prices": settings.PRICES})
        if route == "/api/account/usage":
            return self.send_json(usage.summary(user["id"], whole(query, "days", 30, 1, 365)))
        if route == "/api/account/activity":
            return self.send_json({"events": accounts.history(user["id"])})
        if route == "/api/admin/users":
            if not self.need_admin():
                return
            spent = usage.month_totals()
            return self.send_json({"default_allowance": settings.FREE_ALLOWANCE_USD, "users": [
                {**one, "spent": round(spent.get(one["id"], 0.0), 4)} for one in accounts.everyone()]})
        return self.send_json({"error": "unknown route"}, 404)

    def account_action(self, route: str, data: dict):
        user, address = self.current_user(), self.client_address[0]
        try:
            if route == "/api/account/profile":
                return self.send_json({"user": accounts.update_profile(user["id"], str(data.get("name") or ""))})
            if route == "/api/account/password":
                accounts.change_password(user["id"], str(data.get("current") or ""), str(data.get("new") or ""),
                                         keep_token=self.session_token(), address=address)
                return self.send_json({"ok": True})
            if route == "/api/account/signout-everywhere":
                accounts.sign_out_everywhere(user["id"])
                accounts.log(user["id"], "Signed out everywhere", address=address)
                return self.send_json({"ok": True}, headers={"Set-Cookie": accounts.cookie_header(
                    "", secure=self.secure_cookie(), clear=True)})
            if route == "/api/account/resend":
                accounts.throttle("reset", user["id"])
                accounts.send_verification(user["id"])
                return self.send_json({"ok": True})
            if route == "/api/account/keys":
                note = credentials.save(user["id"], str(data.get("service") or ""), str(data.get("key") or ""), address)
                return self.send_json({"note": note, "keys": credentials.status(user["id"])})
            if route == "/api/account/keys/mode":
                credentials.set_mode(user["id"], str(data.get("service") or ""), str(data.get("mode") or ""), address)
                return self.send_json({"keys": credentials.status(user["id"])})
            if route == "/api/account/keys/remove":
                credentials.remove(user["id"], str(data.get("service") or ""), address)
                return self.send_json({"keys": credentials.status(user["id"])})
            if route == "/api/account/delete":
                accounts.check_own_password(user["id"], str(data.get("password") or ""), address)
                with lock:
                    for one in [c.id for c in calls.values() if c.owner == user["id"]]:
                        calls.pop(one, None)
                accounts.delete_account(user["id"])
                scope.erase(user["id"])
                return self.send_json({"ok": True}, headers={"Set-Cookie": accounts.cookie_header(
                    "", secure=self.secure_cookie(), clear=True)})
            if route.startswith("/api/admin/users/"):
                if not self.need_admin():
                    return
                target = route.removeprefix("/api/admin/users/")
                if target == user["id"] and data.get("disabled"):
                    return self.send_json({"error": "You cannot turn off your own account."}, 400)
                allowance = "keep"
                if "allowance" in data:
                    raw = data["allowance"]
                    allowance = None if raw in (None, "") else max(0.0, float(raw))
                accounts.administer(target, allowance=allowance,
                                    disabled=bool(data["disabled"]) if "disabled" in data else None)
                return self.send_json({"ok": True})
        except accounts.Problem as problem:
            return self.send_json({"error": str(problem)}, problem.status)
        return self.send_json({"error": "unknown route"}, 404)

    # ── contacts ─────────────────────────────────────────────────────────────
    def contacts_read(self, rest: str, query: dict):
        """GET /api/contacts (a page of them), /groups, /sources, and /<id> (one, with its calls)."""
        if rest == "":
            return self.send_json(contacts.list_contacts(
                group=query.get("group", ""), search=query.get("search", ""), status=query.get("status", ""),
                offset=whole(query, "offset", 0, 0, 10**9), limit=whole(query, "limit", 50, 1, 200)))
        if rest == "groups":
            return self.send_json(contacts.list_groups())
        if rest == "sources":
            return self.send_json({"drivers": sources.drivers(), "connections": sources.list_connections(),
                                   "country": contacts.DEFAULT_COUNTRY})
        if "/" not in rest:
            try:
                found = contacts.get_contact(rest)
            except KeyError:
                return self.send_json({"error": "That contact no longer exists."}, 404)
            return self.send_json({**found, "calls": storage.recent_calls(limit=20, contact=rest)["calls"]})
        return self.send_json({"error": "unknown route"}, 404)

    def contacts_action(self, rest: str):
        """POST under /api/contacts: adding and changing contacts and groups, imports, and databases."""
        if rest == "file":
            return self.send_json(sources.read_file(unquote(self.headers.get("X-Filename", "")), self.raw_body()))
        data = self.body()
        parts = rest.split("/")
        country = data.get("country") or contacts.DEFAULT_COUNTRY
        try:
            if rest == "":
                return self.send_json(contacts.save_contact(data, country=country))
            if rest == "delete":
                return self.send_json({"deleted": contacts.delete_contacts(list(data.get("ids") or []))})
            if rest == "opt-out":
                return self.send_json({"changed": contacts.set_opted_out(list(data.get("ids") or []),
                                                                          bool(data.get("opted_out")))})
            if rest == "reach":
                return self.send_json(contacts.reach(list(data.get("groups") or [])))
            if rest == "import":
                return self.send_json(contacts.bring_in(
                    list(data.get("columns") or []), list(data.get("rows") or []), dict(data.get("mapping") or {}),
                    country=country, group_id=data.get("group_id") or "", new_group=data.get("new_group") or "",
                    dry_run=bool(data.get("dry_run"))))
            if rest == "groups":
                return self.send_json(contacts.create_group(data.get("name") or "", data.get("description") or ""))
            if parts[0] == "groups" and len(parts) == 2:
                return self.send_json(contacts.update_group(parts[1], data.get("name"), data.get("description")))
            if parts[0] == "groups" and len(parts) == 3:
                return self.group_action(parts[1], parts[2], data)
            if rest == "connections":
                return self.send_json(sources.save_connection(data.get("name") or "", data.get("kind") or "",
                                                              data.get("address") or ""))
            if parts[0] == "connections" and len(parts) == 3 and parts[2] == "delete":
                sources.delete_connection(parts[1])
                return self.send_json({"deleted": parts[1]})
            if parts[0] == "connections" and len(parts) == 3 and parts[2] == "tables":
                return self.send_json({"tables": sources.list_tables(sources._find(parts[1]))})
            if rest == "query":
                return self.send_json(sources.read_rows(data.get("connection") or "", data.get("table") or "",
                                                        data.get("query") or ""))
            if rest == "database-group":
                return self.database_group(data, country)
            if len(parts) == 1:
                return self.send_json(contacts.save_contact(data, contact_id=parts[0], country=country))
        except KeyError:
            return self.send_json({"error": "That contact or group no longer exists."}, 404)
        return self.send_json({"error": "unknown route"}, 404)

    def group_action(self, group_id: str, action: str, data: dict):
        if action == "delete":
            using = [flow.name for flow in storage.list_flows() if flow.status != "Draft" and group_id in flow.groups]
            if using and not data.get("force"):
                verb = "is" if len(using) == 1 else "are"
                return self.send_json({"error": f"{', '.join(using)} {verb} sent to this group.", "flows": using}, 409)
            return self.send_json({"removed": contacts.delete_group(group_id, bool(data.get("with_contacts")))})
        if action == "sync":
            return self.send_json(sources.sync_group(group_id))
        if action == "members":
            return self.send_json({"changed": contacts.change_members(group_id, list(data.get("ids") or []),
                                                                       bool(data.get("add", True)))})
        return self.send_json({"error": "unknown route"}, 404)

    def database_group(self, data: dict, country: str):
        """A new group read from a database. Everything is read first, so a query that fails leaves no empty group."""
        config = {"connection": data.get("connection") or "", "table": data.get("table") or "",
                  "query": data.get("query") or "", "mapping": dict(data.get("mapping") or {}), "country": country}
        found = sources.read_rows(config["connection"], config["table"], config["query"], limit=contacts.MAX_IMPORT)
        if found["more"]:
            raise contacts.Problem(f"The query gives more than {contacts.MAX_IMPORT:,} rows. Narrow it with a WHERE.")
        return self.send_json(contacts.bring_in(found["columns"], found["rows"], config["mapping"], country=country,
                                                new_group=data.get("name") or "", source="database", config=config))

    def hear_voice(self):
        """A sample line in the voice as set up, so the voice and speed can be tried before a call."""
        data = self.body()
        setup = BusinessSetup(**data["setup"])
        text = (data.get("text") or "").strip()[:300]
        if not text:
            return self.send_json({"error": "nothing to say"}, 400)
        if not voices.ready():
            return self.send_json({"error": voices.NO_KEY}, 400)
        # Like a turn, the text goes first and the audio behind it, so a problem while speaking can't travel
        # with it. The page notices the missing audio; the reason goes to the console.
        self.start_stream()
        self.write_chunk(json.dumps({"say": text}).encode("utf-8") + b"\n")
        for piece in voices.speak(text, setup, on_problem=lambda problem: print(f"  voice sample: {problem}")):
            self.write_chunk(piece)
        self.end_stream()

    # ── a call ───────────────────────────────────────────────────────────────
    def start_call(self):
        data = self.body()
        if not data.get("setup"):
            return self.send_json({"error": "no setup was sent with the call"}, 400)
        setup = BusinessSetup(**data["setup"])
        problems = check_setup(setup)
        if problems:
            return self.send_json({"error": " ".join(problems)}, 400)

        flow_id = str(data.get("flow_id") or "")
        flow_id = flow_id if flow_id.isalnum() and len(flow_id) <= 32 else ""
        test = bool(data.get("test", True))           # this page is a test bench: only a real dialler says otherwise
        # Not begun at all if it could not be paid for, so the person is told now rather than mid-sentence.
        credentials.resolve("gemini")
        if data.get("speak", True) and voices.ready():
            credentials.resolve("elevenlabs")
        usage.set_tag("test" if test else "call", flow_id)

        call, greeting = engine.start(setup, data.get("customer") or {})
        call.owner = scope.owner()
        call.flow_id, call.test = flow_id, test
        with lock:
            calls[call.id] = call
        self.stream_reply(call, heard="", say=greeting, ended=False, think_ms=0,
                          with_audio=bool(data.get("speak", True)))

    def take_turn(self):
        call = self.own_call(self.headers.get("X-Call-Id", ""))
        if call is None:
            return self.send_json({"error": "that call has finished or was never started"}, 404)
        usage.set_tag("test" if call.test else "call", call.flow_id)
        speaking = self.headers.get("X-Speak", "1") != "0"
        interrupted = self.headers.get("X-Interrupted") == "1"     # they talked over the last reply

        # Read the body off the socket before queueing behind another turn. It is still arriving on this
        # connection, and leaving it there would stall the socket rather than just the work.
        audio = self.headers.get("Content-Type", "").startswith("audio/")
        wav = self.raw_body() if audio else b""
        typed = "" if audio else (self.body().get("message") or "")

        with turn_lock(call.id):
            if call.outcome:                       # closed meanwhile (the line went quiet): nothing more to say
                return self.send_json({"error": "that call has finished or was never started"}, 404)
            call.last_active = time.monotonic()
            heard_ms = 0
            if audio:
                began = time.monotonic()
                heard = voices.transcribe(wav, voices.listening_for(call.setup), call.last_asked()) if wav else ""
                heard_ms = int((time.monotonic() - began) * 1000)
            else:
                heard = typed

            # The voice detector fires on a loud room as well as on a voice. A recording with no words in it
            # was the room: it is not an answer, and not a silence either, so the call carries on as if it
            # never happened — and whatever the assistant is still saying is left to finish.
            if audio and not voices.has_words(heard):
                call.note("only noise heard: ignored")
                return self.stream_reply(call, heard="", say="", ended=False, think_ms=0, heard_ms=heard_ms,
                                         with_audio=False, ignored=True)

            try:
                result = engine.reply_to(call, heard, interrupted=interrupted)
            except credentials.Blocked as exc:
                # Not the AI failing: the account cannot pay for the next turn. Say why, rather than a fake "sorry".
                return self.send_json({"error": str(exc), "blocked": True}, exc.status)
            except Exception as exc:
                # The AI failed or timed out. Silence is the worst thing to give a customer: say so and carry on.
                traceback.print_exc()
                call.note(f"the AI failed on this turn: {exc}")
                result = {"say": FALLBACK_LINE, "ended": False, "think_ms": 0}
                call.add("assistant", FALLBACK_LINE)
            call.last_active = time.monotonic()
            if result["ended"]:
                storage.save_call(call)        # written before the goodbye, so "all confirmed" is true
            self.stream_reply(call, heard=heard, say=result["say"], ended=result["ended"],
                              think_ms=result["think_ms"], heard_ms=heard_ms, with_audio=speaking)
        if result["ended"]:
            finish(call)                       # the summary is another AI request: do it after they hang up

    def stream_reply(self, call: Call, *, heard: str, say: str, ended: bool, think_ms: int,
                     heard_ms: int = 0, with_audio: bool, ignored: bool = False):
        """The reply text first, then its speech as it is made."""
        self.start_stream()
        self.write_chunk(json.dumps({
            "heard": heard, "say": say, "ended": ended, "think_ms": think_ms, "heard_ms": heard_ms,
            "ignored": ignored,
            "speech_model": settings.ELEVEN_SPEAK_MODEL,
            "listen_model": settings.ELEVEN_HEAR_MODEL,
            "state": call.snapshot(), "notices": take_notices(),
        }).encode("utf-8") + b"\n")

        if with_audio and say:
            try:
                for piece in voices.speak(say, call.setup, on_problem=call.note):
                    self.write_chunk(piece)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                call.note("stopped speaking: the customer talked over it")
                return                            # the connection is gone; there is no stream to end
            except Exception as exc:              # losing the voice shouldn't lose the call
                traceback.print_exc()
                call.note(f"speech failed: {exc}")
        self.end_stream()


class OnePortServer(ThreadingHTTPServer):
    # The standard server lets the address be reused. On Windows that lets a second copy start on a port the
    # first still holds, and requests keep reaching the first, running whatever code it started with.
    allow_reuse_address = sys.platform != "win32"


def serve(port: int = 8000, open_browser: bool = True):
    settings.DATA_FOLDER.mkdir(parents=True, exist_ok=True)
    # Build the Gemini client now rather than inside the first request, so the greeting isn't the thing
    # that pays for it. It opens no connection — that still happens on the first real request — but it
    # does read the key, which turns a missing one into a line here rather than a failed call later.
    # Not a reason to refuse to start: the setup page is worth serving either way.
    try:
        gemini.client()
    except Exception as exc:
        print(f"  note: {exc}")
    # There is always an account to sign in with. Made on a fresh install, it takes over what was there before accounts.
    made, note = accounts.ensure_default()
    if made and accounts.count() == 1:
        scope.adopt_legacy(made["id"])
    if note:
        print(f"  {note}")
    try:
        server = OnePortServer(("127.0.0.1", port), Handler)
    except OSError:
        raise SystemExit(f"Port {port} is already in use, most likely by Voice Call started earlier. Stop that one "
                         f"first, or run this one on another port: python -m voice_call --port {port + 1}")
    threading.Thread(target=sweep_forever, daemon=True).start()
    address = f"http://127.0.0.1:{port}"
    print(f"Voice Call is running at {address}")
    print("  /        set up your business")
    print("  /call    make a test call")
    print("  /history past calls")
    print("Press Ctrl+C to stop.")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(address)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()
