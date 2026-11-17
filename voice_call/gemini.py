"""Talking to Gemini: typed replies, retries, and moving to the next model when one runs out."""
from __future__ import annotations

import copy
import functools
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, TypeVar

from google import genai
from google.genai import errors, types
from pydantic import BaseModel

from . import credentials, settings, usage

T = TypeVar("T", bound=BaseModel)

_clients: dict[str, genai.Client] = {}
_clients_lock = threading.Lock()

# The model doing the thinking. It changes when one runs out of its daily quota.
current = {"ai": settings.AI_MODELS[0]}
_lists = {"ai": settings.AI_MODELS}

# Anything worth telling the user about, e.g. a model switch. The server shows these in the call log.
#
# Per thread, not per process. One thread serves one request from start to finish, so this keeps each
# call's notices to itself: with a single shared list, two calls running at once drained each other's
# and the switch that happened on one turned up in the other's log.
_local = threading.local()


def _mine() -> list[str]:
    if not hasattr(_local, "notices"):
        _local.notices = []
    return _local.notices


def note(text: str):
    _mine().append(text)


def take_notices() -> list[str]:
    """Everything noticed while answering this request. Reading clears them."""
    found = list(_mine())
    _mine().clear()
    return found

# Thinking levels a model has turned down. Not every model in AI_MODELS need accept every level, and a
# rejected one must not take the call down with it: it is noted here once and never asked for again.
_refused: set[str] = set()


def client(key: str | None = None) -> genai.Client:
    """A client for this key, with a timeout: a hung request would otherwise stall a call indefinitely.

    One per key, made once. With no key given it is the server's own, which is what start-up checks for.
    """
    key = key or settings.api_key()
    with _clients_lock:
        if key not in _clients:
            if len(_clients) > 200:                     # people come and go: do not keep every key ever seen
                _clients.clear()
            _clients[key] = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=settings.REQUEST_TIMEOUT_MS))
        return _clients[key]


_day = ""


def _quota_day() -> str:
    """The free quota resets at midnight US Pacific; a fixed UTC-8 is close enough to know a new day has begun."""
    return (datetime.now(timezone.utc) - timedelta(hours=8)).date().isoformat()


def _new_day():
    """A model that ran out yesterday has its quota back: start again from the first, not wherever it ended."""
    global _day
    today = _quota_day()
    if today != _day:
        _day = today
        for kind, models in _lists.items():
            if current[kind] != models[0]:
                note(f"a new day: back to {models[0]}")
            current[kind] = models[0]


def next_model(kind: str) -> bool:
    """Move to the next model of this kind. False when there are none left."""
    models, now = _lists[kind], current[kind]
    remaining = models[models.index(now) + 1:] if now in models else []
    if not remaining:
        return False
    current[kind] = remaining[0]
    note(f"{now} is out of quota for today, switching to {remaining[0]}")
    return True


def call_gemini(request: Callable[[str], Any], kind: str = "ai", source: str = "ours"):
    """One request. `request` is given the model name, so a switch takes effect straight away.

    Moving to the next model when one runs out is about OUR free quota, which everyone shares. A person's own key has
    its own limits, so it never moves anyone else's model: it fails, with the reason.
    """
    _new_day()
    for attempt in range(4):
        try:
            return request(current[kind])
        except errors.APIError as exc:
            if source == "own" and (exc.code or 0) in (400, 401, 403):
                raise credentials.Blocked("Google rejected your own Gemini key. Check it in Account, API keys, or switch "
                                          "to ours.", 400) from None
            if exc.code == 429 and "PerDay" in str(exc):
                if source == "ours" and next_model(kind):
                    continue
                raise RuntimeError("Every model has used up its quota for today. It resets at midnight US Pacific time"
                                   + (", or use a key with billing enabled." if source == "ours" else ".")) from None
            if (exc.code != 429 and (exc.code or 0) < 500) or attempt == 3:
                raise
            time.sleep(2)


def ask_ai(output: type[T], prompt: str, *, system: str | None = None, temperature: float = 0.3,
           thinking: str = settings.THINKING_OFF_CALL) -> T:
    """Ask Gemini and get back a filled-in `output` object rather than loose text.

    `thinking` is how long the model may spend before it writes anything. On a call that time is dead
    air, so a turn asks for the least; see settings.
    """
    level = settings.THINKING_ALWAYS_ALLOWED if thinking in _refused else thinking
    config = types.GenerateContentConfig(
        system_instruction=system, temperature=temperature, response_mime_type="application/json",
        response_json_schema=plain_schema(output),
        thinking_config=types.ThinkingConfig(thinking_level=level))
    key, source = credentials.resolve("gemini")
    try:
        response = call_gemini(
            lambda model: client(key).models.generate_content(model=model, contents=prompt, config=config), source=source)
    except errors.APIError as exc:
        # A model that won't think at this level says so with a 400. Losing the turn over it would be
        # far worse than thinking a little longer, so fall back once and remember.
        if level != settings.THINKING_ALWAYS_ALLOWED and (exc.code or 0) == 400 and "thinking" in str(exc).lower():
            _refused.add(thinking)
            note(f"this model will not think at {thinking.lower()}; "
                 f"using {settings.THINKING_ALWAYS_ALLOWED.lower()} instead")
            return ask_ai(output, prompt, system=system, temperature=temperature,
                          thinking=settings.THINKING_ALWAYS_ALLOWED)
        raise
    _record(response, source)
    if not response.text:
        raise RuntimeError("Gemini returned an empty response")
    return output.model_validate_json(response.text)


def _record(response, source: str):
    """What Gemini says this request used, written to the ledger. Thinking is billed as output."""
    used = getattr(response, "usage_metadata", None)
    if used is None:
        return
    usage.record("gemini", source, getattr(used, "prompt_token_count", 0) or 0,
                 (getattr(used, "candidates_token_count", 0) or 0) + (getattr(used, "thoughts_token_count", 0) or 0),
                 model=getattr(response, "model_version", "") or current["ai"])


def plain_schema(model: type[BaseModel]) -> dict:
    """The shape of `output`, the way Gemini expects it: references inlined, titles and defaults dropped.

    A fresh copy of one worked out once. There are four shapes in the project and none of them changes,
    so rebuilding one on every turn was work done for nothing; the copy is because the caller hands this
    straight to the SDK, and a cache something else may edit is worse than no cache.
    """
    return copy.deepcopy(_schema(model))


@functools.lru_cache(maxsize=None)
def _schema(model: type[BaseModel]) -> dict:
    schema = model.model_json_schema()
    definitions = schema.pop("$defs", {})

    def clean(node, keys_are_names=False):
        if isinstance(node, list):
            return [clean(item) for item in node]
        if not isinstance(node, dict):
            return node
        result = clean(definitions[node["$ref"].split("/")[-1]]) if "$ref" in node else {}
        for key, value in node.items():
            if key == "$ref" or (not keys_are_names and key in ("title", "default")):
                continue
            result[key] = clean(value, keys_are_names=(key == "properties"))
        return result

    return clean(schema)
