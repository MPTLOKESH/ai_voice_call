"""ElevenLabs for speaking and hearing.

Used when ELEVENLABS_API_KEY is set. The key is read from the environment by name and never printed.

Speaking streams raw 24 kHz audio, which is the format the browser already plays, and the Flash model starts
sending in well under a second. Hearing uses Scribe, which takes a finished recording like Gemini does.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
import uuid
from typing import Iterator

from . import settings

BASE = "https://api.elevenlabs.io/v1"

# Whatever the business writes as a language, Scribe wants a code. Anything not listed is left to it to detect.
LANGUAGE_CODES = {
    "english": "eng", "hindi": "hin", "tamil": "tam", "telugu": "tel", "kannada": "kan",
    "malayalam": "mal", "marathi": "mar", "bengali": "ben", "gujarati": "guj", "punjabi": "pan",
    "urdu": "urd", "spanish": "spa", "french": "fra", "german": "deu", "italian": "ita",
    "portuguese": "por", "dutch": "nld", "polish": "pol", "arabic": "ara", "japanese": "jpn",
    "korean": "kor", "chinese": "zho", "russian": "rus", "turkish": "tur", "indonesian": "ind",
}


def available() -> bool:
    return bool(os.getenv("ELEVENLABS_API_KEY", "").strip())


def _key() -> str:
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY is not set")
    return key


def _explain(exc: urllib.error.HTTPError) -> str:
    """A readable reason, without ever including the key."""
    reasons = {401: "the ElevenLabs key was rejected", 402: "the ElevenLabs account is out of credit",
               422: "ElevenLabs rejected the request", 429: "too many ElevenLabs requests at once"}
    return reasons.get(exc.code, f"ElevenLabs returned {exc.code}")


# Higher rates need a paid plan, so the first one that is allowed is remembered and reused.
FORMATS = [("pcm_24000", 24000), ("pcm_22050", 22050), ("pcm_16000", 16000)]
_format: tuple[str, int] | None = None


def _resampled(pieces: Iterator[bytes], from_rate: int, to_rate: int) -> Iterator[bytes]:
    """Stretch 16-bit audio to the rate the browser plays, carrying the last sample between pieces."""
    if from_rate == to_rate:
        yield from pieces
        return
    import array
    step = from_rate / to_rate
    carry = 0.0
    spare = b""            # a byte that arrived without the other half of its sample
    tail = None            # the previous piece's last sample, so a join is interpolated like any gap
    for piece in pieces:
        # A read can end anywhere, so a piece is not always a whole number of samples. Dropping the odd
        # byte — which is what taking only `len // 2 * 2` did — puts every sample after it one byte out,
        # and the rest of the reply comes back as noise. Hold it and start the next piece with it.
        piece = spare + piece
        usable = len(piece) // 2 * 2
        spare = piece[usable:]
        samples = array.array("h")
        samples.frombytes(piece[:usable])
        if not samples:
            continue
        # Each piece used to be interpolated alone, so its last sample was only ever a right-hand end
        # and the step across to the next piece was never filled in: a sample lost and a tiny step in
        # the waveform at every join, which is a tick every few thousand bytes. Carrying it over makes
        # the join no different from any other gap — and `carry` is already measured from it.
        if tail is not None:
            samples.insert(0, tail)
        tail = samples[-1]
        out = array.array("h")
        at = carry
        while at < len(samples) - 1:
            low = int(at)
            fraction = at - low
            out.append(int(samples[low] * (1 - fraction) + samples[low + 1] * fraction))
            at += step
        carry = at - (len(samples) - 1)
        yield out.tobytes()


def speak(text: str, voice_id: str | None = None, model: str | None = None,
          speed: float = 1.0) -> Iterator[bytes]:
    """Raw 24 kHz, 16-bit audio as it arrives, whatever rate the account is allowed to ask for."""
    global _format
    voice_id = voice_id or settings.ELEVEN_VOICE
    body = json.dumps({
        "text": text,
        "model_id": model or settings.ELEVEN_SPEAK_MODEL,
        "voice_settings": {"stability": 0.4, "similarity_boost": 0.8, "speed": max(0.7, min(1.2, speed))},
    }).encode("utf-8")

    for name, rate in ([_format] if _format else FORMATS):
        request = urllib.request.Request(
            f"{BASE}/text-to-speech/{voice_id}/stream?output_format={name}",
            data=body, method="POST",
            headers={"xi-api-key": _key(), "Content-Type": "application/json", "Accept": "audio/pcm"})
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403, 422) and not _format and (name, rate) != FORMATS[-1]:
                continue                       # this rate needs a better plan: try a lower one
            raise RuntimeError(_explain(exc)) from None

        _format = (name, rate)

        def pieces():
            with response:
                while True:
                    piece = response.read(4096)
                    if not piece:
                        break
                    yield piece

        yield from _resampled(pieces(), rate, settings.SPEAKER_RATE)
        return


_voices: list[dict] | None = None


def voices() -> list[dict]:
    """The voices this account can speak with, as {id, name, about}. Fetched once."""
    global _voices
    if _voices is None:
        request = urllib.request.Request(f"{BASE}/voices", headers={"xi-api-key": _key()})
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                found = json.loads(response.read()).get("voices") or []
        except urllib.error.HTTPError as exc:
            raise RuntimeError(_explain(exc)) from None
        _voices = sorted(({
            "id": voice.get("voice_id", ""), "name": voice.get("name", ""),
            "about": ", ".join(value for key in ("gender", "accent", "age", "description")
                               if (value := (voice.get("labels") or {}).get(key))),
        } for voice in found if voice.get("voice_id")), key=lambda voice: voice["name"].lower())
    return _voices


def transcribe(wav_bytes: bytes, language: str = "") -> str:
    """A finished recording in, the words out."""
    boundary = f"----voicecall{uuid.uuid4().hex}"
    code = LANGUAGE_CODES.get(language.strip().lower())

    parts = []
    def field(name: str, value: str):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
                     .encode("utf-8"))

    field("model_id", settings.ELEVEN_HEAR_MODEL)
    if code:
        field("language_code", code)
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"turn.wav\"\r\n"
                 f"Content-Type: audio/wav\r\n\r\n".encode("utf-8"))
    parts.append(wav_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))

    request = urllib.request.Request(
        f"{BASE}/speech-to-text", data=b"".join(parts), method="POST",
        headers={"xi-api-key": _key(), "Content-Type": f"multipart/form-data; boundary={boundary}"})

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return (json.loads(response.read()).get("text") or "").strip()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_explain(exc)) from None
