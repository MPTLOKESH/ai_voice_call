"""Talking to Gemini: typed replies, retries, and moving to the next model when one runs out."""
from __future__ import annotations

import copy
import functools
import threading
import time
from typing import Any, Callable, TypeVar

from google import genai
from google.genai import errors, types
from pydantic import BaseModel

from . import settings

T = TypeVar("T", bound=BaseModel)

_client: genai.Client | None = None

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


def client() -> genai.Client:
    """One client, with a timeout: a hung request would otherwise stall a call indefinitely."""
    global _client
    if _client is None:
        _client = genai.Client(api_key=settings.api_key(),
                               http_options=types.HttpOptions(timeout=settings.REQUEST_TIMEOUT_MS))
    return _client


def next_model(kind: str) -> bool:
    """Move to the next model of this kind. False when there are none left."""
    models, now = _lists[kind], current[kind]
    remaining = models[models.index(now) + 1:] if now in models else []
    if not remaining:
        return False
    current[kind] = remaining[0]
    note(f"{now} is out of quota for today, switching to {remaining[0]}")
    return True


def call_gemini(request: Callable[[str], Any], kind: str = "ai"):
    """One request. `request` is given the model name, so a switch takes effect straight away."""
    for attempt in range(4):
        try:
            return request(current[kind])
        except errors.APIError as exc:
            if exc.code == 429 and "PerDay" in str(exc):
                if next_model(kind):
                    continue
                raise RuntimeError("Every model has used up its free quota for today. It resets at midnight US "
                                   "Pacific time, or use a key with billing enabled.") from None
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
    try:
        response = call_gemini(
            lambda model: client().models.generate_content(model=model, contents=prompt, config=config))
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
    if not response.text:
        raise RuntimeError("Gemini returned an empty response")
    return output.model_validate_json(response.text)


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
