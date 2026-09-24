"""Models, limits and paths. Change these rather than hunting through the code."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import find_dotenv, load_dotenv

# Read .env once, here, so every module sees the keys. Anything that checks for a key by name
# (which service speaks, which hears) runs long before the first Gemini request, so waiting until
# then to read the file would leave those checks looking at an empty environment.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)   # this project's own
load_dotenv(find_dotenv(usecwd=True), override=False)                          # then any nearby one

# Gemini does the thinking only. The free tier allows 500 requests per model per day, so when one runs
# out the next is used.
AI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview"]

# How hard the model may think before it starts writing. Thinking tokens are produced *before* the first
# word of the answer, so on a live call they are not cleverness, they are silence: the customer sits
# through every one of them. A turn is one classification and one short sentence against a system prompt
# that already spells out how to judge an answer — it is not a puzzle — so it gets the smallest level.
# Work that happens once the customer has hung up, or while a business is filling in a form, has nobody
# waiting on it and can afford to think.
THINKING_ON_A_TURN = "MINIMAL"
THINKING_OFF_CALL = "LOW"
# Where to retreat to if a model refuses a level. Kept separate so the two above stay free to change.
THINKING_ALWAYS_ALLOWED = "LOW"

# ElevenLabs does all the speaking and hearing. ELEVENLABS_API_KEY must be set.
ELEVEN_VOICE = "21m00Tcm4TlvDq8ikWAM"       # any voice id from your ElevenLabs library
ELEVEN_SPEAK_MODEL = "eleven_flash_v2_5"    # the low-latency one: first audio in well under a second
ELEVEN_HEAR_MODEL = "scribe_v1"

REQUEST_TIMEOUT_MS = 20_000                 # a call cannot wait forever on one request

# How a call behaves. The first two are only the starting values: each business sets its own.
TRIES_PER_QUESTION = 3          # unclear answers before a question is dropped
SILENCES_BEFORE_ENDING = 2      # silent turns before the call is given up
RECENT_TURNS = 6                # how much conversation is sent to the model
MAX_REPLIES = 20                # a safety net, in case a call never reaches an end

# Keeping to a business's time limit. Near the end the assistant hurries: optional questions and the
# read-back are dropped so what matters still fits. With less than one exchange left, it says goodbye
# instead of asking anything more, so the call ends on time rather than just after it.
HURRY_SHARE = 1 / 3             # hurry for the last third of the limit...
HURRY_SECONDS = 30              # ...or the last 30 seconds, whichever is longer
SECONDS_PER_EXCHANGE = 10       # roughly one question, its answer and the reply

# Audio.
MIC_RATE = 16_000               # what the browser sends us
SPEAKER_RATE = 24_000           # what ElevenLabs speaks at, and what the browser plays

PROJECT = Path(__file__).resolve().parent.parent
DATA_FOLDER = PROJECT / "data"
CONFIG_FILE = PROJECT / "config" / "business.json"
WEB_FOLDER = PROJECT / "web"


def api_key() -> str:
    key = (os.getenv("GEMINI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set. Put it in a .env file beside this project.")
    return key
