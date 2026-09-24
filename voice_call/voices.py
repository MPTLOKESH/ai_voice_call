"""Speaking and hearing, both through ElevenLabs.

Everything else in the project calls `speak` and `transcribe` and doesn't touch the service directly.
"""
from __future__ import annotations

import re
from typing import Callable, Iterator

from . import elevenlabs, settings, speech
from .models import BusinessSetup

# Lines repeated within a call are made once and replayed.
_remembered: dict[tuple[str, str, float], bytes] = {}
_REMEMBER_UP_TO = 40

NO_KEY = ("ELEVENLABS_API_KEY is not set, so there is no voice. Put it in the .env file beside this project.")


def ready() -> bool:
    return elevenlabs.available()


def choices() -> list[dict]:
    """The voices to pick from on the setup page. Empty rather than an error: a voice id can be typed in."""
    if not ready():
        return []
    try:
        return elevenlabs.voices()
    except Exception as exc:
        print(f"  note: could not list voices: {exc}")
        return []


def voice_of(setup: BusinessSetup) -> str:
    return setup.voice_id.strip() or settings.ELEVEN_VOICE


def listening_for(setup: BusinessSetup) -> str:
    """The language to hear in. None named when the customer may switch, so Scribe works it out itself."""
    return "" if any(language.strip() for language in setup.other_languages) else setup.language


def pronounced(text: str, setup: BusinessSetup) -> str:
    """The reply as the voice should say it: each "word = how to say it" swapped in.

    Only the audio changes. The transcript keeps the word as it is written.
    """
    for line in setup.pronunciations:
        word, _, say = line.partition("=")
        word, say = word.strip(), say.strip()
        if word and say:
            text = re.sub(rf"(?<!\w){re.escape(word)}(?!\w)", lambda _: say, text, flags=re.IGNORECASE)
    return text


def transcribe(wav_bytes: bytes, language: str, expecting: str = "") -> str:
    """A finished recording in, the words out. `expecting` is unused: Scribe takes no context."""
    if not ready():
        raise RuntimeError(NO_KEY)
    return elevenlabs.transcribe(wav_bytes, language)


def speak(text: str, setup: BusinessSetup,
          on_problem: Callable[[str], None] = lambda message: None) -> Iterator[bytes]:
    """Raw 24 kHz audio as it becomes available, a piece at a time.

    A problem here arrives after the reply text has already gone to the browser, so it cannot travel
    with it. `on_problem` is the caller's way of putting it somewhere that outlives this request — the
    call's own log — rather than a global the next request may or may not read.
    """
    if not ready():
        on_problem(NO_KEY)
        return

    voice = voice_of(setup)
    for sentence in speech.sentences(pronounced(text, setup)):
        key = (voice, sentence, setup.speaking_speed)
        if key in _remembered:
            yield _remembered[key]
            continue

        collected = bytearray()
        try:
            for piece in elevenlabs.speak(sentence, voice, speed=setup.speaking_speed):
                collected.extend(piece)
                yield piece
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            raise                    # they hung up or talked over it: not a problem with the voice
        except Exception as exc:
            # Losing the voice shouldn't lose the call: the reply is already on screen.
            on_problem(f"{exc}: carrying on without a voice")
            return

        if collected and len(_remembered) < _REMEMBER_UP_TO:
            _remembered[key] = bytes(collected)
