"""The browser UI: a page to set the assistant up, and a page to call it.

A turn is one request. The reply text comes back immediately, then the speech streams in the same response, so
the customer hears the first words while the rest is still being made.

Response shape for a turn:  {json line}\n followed by raw 24 kHz 16-bit audio.

Built on the standard library, so nothing extra needs installing. Run it with:  python -m voice_call
"""
from __future__ import annotations

import json
import threading
import time
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import engine, gemini, settings, storage, voices
from .models import BusinessSetup, Call
from .suggestions import suggest_questions

calls: dict[str, Call] = {}
lock = threading.Lock()

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
    if not setup.questions:
        problems.append("Add at least one question.")
    if not setup.purpose.strip():
        problems.append("Say what the call is for.")
    names = [q.save_as for q in setup.questions]
    for name in sorted({n for n in names if names.count(n) > 1}):
        problems.append(f"Two questions are saved as '{name}'.")
    for q in setup.questions:
        if not q.save_as.isidentifier():
            problems.append(f"'{q.save_as}': use letters, numbers and underscores only.")
        if q.type == "choice" and len(q.options) < 2:
            problems.append(f"'{q.save_as}': a choice needs at least two options.")
    for at, q in enumerate(setup.questions):
        if not q.only_if:
            continue
        # Only an earlier question, so no two questions can each wait for the other.
        if q.only_if not in names[:at]:
            problems.append(f"'{q.save_as}' can only depend on a question above it.")
        elif not q.only_if_is:
            problems.append(f"'{q.save_as}': say which answer to '{q.only_if}' it is asked after.")
    return problems


REMEMBER_CALLS = 20        # finished calls kept in memory, so the page can still read them


def finish(call: Call):
    """Summarise, save again with the summary, and let old calls go."""
    try:
        call.summary = engine.summarise(call).model_dump()
    except Exception as exc:                      # a summary is not worth losing the call over
        call.note(f"summary failed: {exc}")
    # Nothing is listening for these any more — the browser has had its last reply — so they go into the
    # call's own log, where the saved file will keep them.
    for notice in take_notices():
        call.note(notice)
    call.note(f"saved to {storage.save_call(call)}")

    with lock:
        finished = [c for c in calls.values() if c.outcome]
        for old in finished[:-REMEMBER_CALLS]:
            calls.pop(old.id, None)
            _turns.pop(old.id, None)


class Handler(BaseHTTPRequestHandler):
    server_version = "voice_call"
    protocol_version = "HTTP/1.1"                 # needed for a streamed reply

    def log_message(self, format, *args):         # quieter console
        pass

    # ── sending ──────────────────────────────────────────────────────────────
    def send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{kind}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # Without this the browser keeps the copy it already has, and an edited page or script never
        # reaches the person testing it — they debug yesterday's code and nothing they try makes a
        # difference. The vendored model is the one thing worth keeping, since it never changes.
        # `name` arrives already stripped of "/static/", so it reads "vendor/…" with no leading slash.
        vendored = name.replace("\\", "/").startswith("vendor/")
        self.send_header("Cache-Control", "public, max-age=86400" if vendored else "no-store")
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
    def body(self) -> dict:
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        return json.loads(raw or "{}")

    def raw_body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    # ── pages ────────────────────────────────────────────────────────────────
    def do_GET(self):
        route = urlparse(self.path).path
        try:
            if route in ("/", "/setup", "/call"):
                return self.send_file("index.html")     # one page: the tab is chosen in the browser
            if route.startswith("/static/"):
                return self.send_file(route.removeprefix("/static/"))
            if route == "/api/setup":
                return self.send_json(storage.load_setup().model_dump())
            if route == "/api/calls":
                return self.send_json({"calls": storage.recent_calls()})
            if route == "/api/models":
                return self.send_json({"models": gemini.current})
            if route == "/api/voices":
                return self.send_json({"voices": voices.choices(), "default": settings.ELEVEN_VOICE})
            return self.send_json({"error": "unknown route"}, 404)
        except Exception as exc:
            traceback.print_exc()
            return self.send_json({"error": str(exc)}, 500)

    # ── actions ──────────────────────────────────────────────────────────────
    def do_POST(self):
        route = urlparse(self.path).path
        try:
            if route == "/api/setup":
                setup = BusinessSetup(**self.body())
                storage.save_setup(setup)
                return self.send_json({"saved": True, "setup": setup.model_dump()})

            if route == "/api/suggest":
                found = suggest_questions(BusinessSetup(**self.body()))
                return self.send_json({"questions": [q.model_dump() for q in found], "notices": take_notices()})

            if route == "/api/hear":
                return self.hear_voice()

            if route == "/api/call/start":
                return self.start_call()

            if route == "/api/call/turn":
                return self.take_turn()

            return self.send_json({"error": "unknown route"}, 404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # The browser stopped listening mid-reply. That is what talking over the assistant looks
            # like from here, so it is ordinary: there is nobody left to send an error to.
            return
        except Exception as exc:
            traceback.print_exc()
            return self.send_json({"error": f"{type(exc).__name__}: {exc}"}, 500)

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
        setup = BusinessSetup(**data["setup"]) if data.get("setup") else storage.load_setup()
        problems = check_setup(setup)
        if problems:
            return self.send_json({"error": " ".join(problems)}, 400)

        call, greeting = engine.start(setup, data.get("customer") or {})
        with lock:
            calls[call.id] = call
        self.stream_reply(call, heard="", say=greeting, ended=False, think_ms=0,
                          with_audio=bool(data.get("speak", True)))

    def take_turn(self):
        call = calls.get(self.headers.get("X-Call-Id", ""))
        if call is None:
            return self.send_json({"error": "that call has finished or was never started"}, 404)
        speaking = self.headers.get("X-Speak", "1") != "0"
        interrupted = self.headers.get("X-Interrupted") == "1"     # they talked over the last reply

        # Read the body off the socket before queueing behind another turn. It is still arriving on this
        # connection, and leaving it there would stall the socket rather than just the work.
        audio = self.headers.get("Content-Type", "").startswith("audio/")
        wav = self.raw_body() if audio else b""
        typed = "" if audio else (self.body().get("message") or "")

        with turn_lock(call.id):
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

            result = engine.reply_to(call, heard, interrupted=interrupted)
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
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    address = f"http://127.0.0.1:{port}"
    print(f"Voice Call is running at {address}")
    print("  /        set up your business")
    print("  /call    make a test call")
    print("Press Ctrl+C to stop.")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(address)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()
