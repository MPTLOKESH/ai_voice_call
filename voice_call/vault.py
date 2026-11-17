"""Keeping secrets: people's own API keys and database passwords are encrypted before they are written down.

AES-256-GCM, with the master key kept apart from the data. Put VC_MASTER_KEY in the environment (or a secret
manager) for a real deployment: 32 random bytes, URL-safe base64 — `python -m voice_call.vault` prints one. With
none set, a key is made once and kept in data/master.key, which is fine on one's own machine but means a copy of
the data folder is a copy of the key too.

Each secret is bound to what it belongs to (`context`, e.g. the account and the service), so a ciphertext copied
into another person's row will not decrypt there.
"""
from __future__ import annotations

import base64
import os
import secrets
import threading

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import settings

PREFIX = "v1:"
_lock = threading.Lock()
_key: bytes | None = None


class Unreadable(Exception):
    """A secret that cannot be decrypted: the wrong master key, or a copied or damaged value."""


def _master() -> bytes:
    global _key
    with _lock:
        if _key is not None:
            return _key
        given = (os.getenv("VC_MASTER_KEY") or "").strip()
        if given:
            raw = base64.urlsafe_b64decode(given + "=" * (-len(given) % 4))
            if len(raw) != 32:
                raise RuntimeError("VC_MASTER_KEY must be 32 bytes, URL-safe base64. Make one with: python -m voice_call.vault")
            _key = raw
            return _key
        path = settings.DATA_FOLDER / "master.key"
        if path.exists():
            _key = base64.urlsafe_b64decode(path.read_text().strip())
            return _key
        path.parent.mkdir(parents=True, exist_ok=True)
        fresh = secrets.token_bytes(32)
        # Created so that nobody else can read it, not even for an instant: opened with 0600 rather than chmod-ed after.
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(base64.urlsafe_b64encode(fresh).decode())
        _key = fresh
        return _key


def seal(text: str, context: str) -> str:
    nonce = secrets.token_bytes(12)
    box = AESGCM(_master()).encrypt(nonce, text.encode("utf-8"), context.encode("utf-8"))
    return PREFIX + base64.urlsafe_b64encode(nonce + box).decode()


def unseal(sealed: str, context: str) -> str:
    if not sealed.startswith(PREFIX):
        raise Unreadable("not a sealed value")
    try:
        raw = base64.urlsafe_b64decode(sealed[len(PREFIX):])
        return AESGCM(_master()).decrypt(raw[:12], raw[12:], context.encode("utf-8")).decode("utf-8")
    except (InvalidTag, ValueError):
        raise Unreadable("could not be decrypted") from None


def is_sealed(value: str) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def reset_for_tests():
    global _key
    _key = None


if __name__ == "__main__":
    print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())
