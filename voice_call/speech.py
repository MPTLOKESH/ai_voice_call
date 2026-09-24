"""Shaping text for the voice.

Speaking itself belongs to `elevenlabs`; this module only decides where a reply is broken up, so the first
piece can start playing while the rest is still being made.
"""
from __future__ import annotations

FIRST_PIECE_UP_TO = 40          # characters: a short opening clip is what the customer waits for


def sentences(text: str) -> list[str]:
    """Split into pieces, so the first can start playing while the rest is still being made."""
    pieces, current = [], ""
    for character in text:
        current += character
        if character in ".!?" and len(current.strip()) > 12:
            pieces.append(current.strip())
            current = ""
    if current.strip():
        pieces.append(current.strip())
    if not pieces:
        return [text]

    opening = pieces[0]
    if len(opening) > FIRST_PIECE_UP_TO:
        pieces = _shorten(opening) + pieces[1:]
    return pieces


def _shorten(opening: str) -> list[str]:
    """Break a long opening sentence, so the customer waits for a short clip rather than the whole thing.

    A comma before the target length is best. Failing that, the last word boundary before it: the read-back
    ("So that is a table for four this Friday at half seven, correct?") has its only comma near the end, and
    speaking all of that before any sound comes out is exactly the wait we are trying to remove.
    """
    room = range(12, FIRST_PIECE_UP_TO + 1)
    commas = [at + 1 for at, character in enumerate(opening) if character == "," and at + 1 in room]
    at = max(commas) if commas else opening.rfind(" ", 12, FIRST_PIECE_UP_TO)
    if at <= 12 or len(opening) - at < 8:
        return [opening]
    return [opening[:at].strip(), opening[at:].strip()]
