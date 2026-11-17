# Voice Call

A voice assistant that calls customers, asks a business's questions, and saves the answers.

Same engine as `live_call.ipynb`, but as a project with a browser UI: a page to set your assistant up, and a
page to hold a real conversation with it.

## Run it

```bash
cd voice_call
python -m voice_call
```

It opens `http://127.0.0.1:8000`. Your `GEMINI_API_KEY` is read from a `.env` file in this folder or the one
above it. Nothing needs installing beyond `requirements.txt`: the server uses Python's own standard library,
and the browser UI is already built into `web/`.

## Accounts, keys and usage

Everyone signs in. The first account made is the administrator and takes over any flows, calls and contacts from
before accounts existed; after that each person's data is kept in `data/users/<id>/`, apart from everyone else's.

A **default account** is made at every start if it is missing, so there is always one to sign in with:
`admin@voicecall.local` / `voicecall-admin`, printed in the console. Change its password under Account, Security
(it is never put back), or set `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` in `.env`. On a server that looks
public (`PUBLIC_URL` not local, or `COOKIE_SECURE=1`) the built-in password is not used: set your own, or none is made.
`DISABLE_DEFAULT_ADMIN=1` turns it off.

Each person can use **our keys** (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY` in `.env`, within a free monthly allowance)
or **their own**, set under Account, API keys. Own keys are checked with the provider, stored encrypted, and never
shown again. Usage is written to a ledger from what the providers report, and shown under Account, Usage.

Settings, all in `.env` and all optional on your own machine:

| Setting | What it does |
|---|---|
| `VC_MASTER_KEY` | Encrypts saved keys. 32 random bytes, URL-safe base64: `python -m voice_call.vault` prints one. Set it on a real server and keep it out of the data folder. Without it a key file is made in `data/`. |
| `SIGNUP_CODE` | If set, making an account needs this invite code. |
| `FREE_ALLOWANCE_USD` | Monthly allowance per account on our keys, in estimated dollars (default 1.00). Prices are in `settings.PRICES`: check them. The administrator can change any one account's. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | Sends confirmation and reset emails. Without `SMTP_HOST` emails are printed in the console and addresses are not confirmed. |
| `PUBLIC_URL` | The address people reach the app at, used in email links. |
| `COOKIE_SECURE=1` | Marks the session cookie Secure. Set it behind HTTPS (or have the proxy send `X-Forwarded-Proto: https`). |
| `ALLOW_PRIVATE_DB=1` | Lets non-administrators connect to databases on private networks. Off by default. |

Put the app behind HTTPS before real people use it.

## Changing the UI

The pages are React + Tailwind CSS in `frontend/`. You need Node.js 20 or newer, but only to change them:

```bash
cd frontend
npm install          # once
npm run dev          # http://localhost:5173, reloads as you edit; keep `python -m voice_call` running for /api
npm run build        # writes the finished UI into ../web, which the Python server sends
```

Commit `web/` after building, so the app still runs with Python alone. Colours and fonts are the design
tokens at the top of `frontend/src/index.css`.

## The pages

Tabs in the bar across the top switch between them (on phones, a tab bar along the bottom), and the top
bar holds the actions for the page you're on.
Everything is laid out for phones as well.

**Set up** (`/`) — everything a business decides:

| | |
|---|---|
| Your business | name, assistant's name, why it is calling, who it calls from, when it says it's an AI, language, how long a call may run |
| Personality | tone, how much it says, formality |
| Voice and speech | the voice (with **Hear it** to try it), speed, other languages it may switch to |
| What it may say | the only facts it shares; asked anything else it says a colleague will follow up |
| Rules | what it must never do or say. Boundaries go here too: topics to avoid, angry callers, handing over to a person |
| How the call runs | how often it re-asks an unclear answer, how many silences before it hangs up, how long it waits after you stop talking, the read-back at the end, whether it can be interrupted |
| Questions | what to ask, the answer type, a plain-English rule for an acceptable answer, and *only ask if* an earlier answer was one of a few values |

Everything left at its default behaves exactly as before. Whether a conditional question is asked is decided
by code, not the AI.

**Suggest questions** asks the AI for questions that suit your purpose. They land in the list as ordinary rows,
so you can edit, reorder or delete them. They are *added* to what is already there, so asking twice gives you
two sets.

**Reset** empties every field, for setting a business up from scratch. It asks once before it does it, and
says so rather than acting if the form is already empty. Nothing is written until you press Save, so the
setup already on disk — and any call you start meanwhile — is untouched by it.

One section shows at a time: pick it from the list beside it (a row of chips on phones), or step through
them with the buttons underneath. Questions are a list of rows; click one to edit it. Unsaved changes are
flagged in the top bar, and they survive a look at another page.

**Test call** (`/call`) — a conversation, not a walkie-talkie:

- **Hands free.** It listens while you speak, works out when you have finished, and replies. There is no
  button to hold and nothing to type: a call is spoken, so the microphone is the only way in.
- **Interrupt whenever you like.** Talk over it and it stops mid-sentence.
- **Answers appear as they are saved**, with the words they came from underneath. Unanswered ones show
  "waiting", "asking again (2)" or "given up on".
- **The decision log** shows what the code did: saved, not saved, changed, gave up, step changes, model switches.
- **Timings per turn**: heard, thought, spoke.
- *End call* and *Say nothing* stand in for things a customer does: hanging up, and a turn where nobody
  spoke. Untick *Speak out loud* to test the logic without spending speech requests.
- **Leave the page mid-call** and the call carries on; its tab is marked with a live dot.

**Call history** (`/history`) — every finished call, newest first, with its outcome, length and summary.
Open one to see the answers it saved.

## Why it feels quick

One request per turn. The recording goes up; the reply text comes straight back and the speech **streams in the
same response**, so the first words play while the rest is still being made.

```
you stop talking
   → the browser sends what it recorded        one request
   → the server writes it down, thinks, replies
   → audio streams back, sentence by sentence   first words in about half a second
```

Speech is made a sentence at a time, and lines said on every call (the greeting, the goodbyes) are made once and
replayed. Echo cancellation comes from the browser, so interrupting works on speakers as well as headphones.

## How a call works

The steps are **greet → ask → confirm → finish**. A call ends when the customer confirms the read-back (or answers the last question, with the read-back off), wants to
stop, stays quiet too many times in a row, or runs past your time limit. Every call is saved to `data/calls/<id>.json` with the
answers, what the customer actually said, anything changed mid-call, the transcript and a summary.

**The AI proposes; code decides.** `keep_answers()` and `next_step()` in `voice_call/engine.py` are the only
places a value is stored or a call is ended.

## The files

```
voice_call/
  settings.py     models, limits, paths
  gemini.py       typed requests, retries, model fallback
  models.py       BusinessSetup · Question · Call
  prompts.py      everything the AI is told
  engine.py       think · keep_answers · next_step · one turn
  speech.py       speech in, and streamed speech out
  suggestions.py  questions from a purpose
  storage.py      the setup, and finished calls
  server.py       the browser UI
frontend/          the browser UI: React + Tailwind, built with Vite
  src/components/  layout (rail, tab bar) · drafts · studio · voices · call · history · ui (buttons, fields, cards)
  src/lib/         callSession (a call's turns and interruptions) · setupForm · vad · audio · api
  public/vendor/   Silero model and ONNX Runtime
web/               the built UI the server sends (from `npm run build`; don't edit by hand)
config/flows/          your flows (setups), saved as you edit them
data/calls/            one file per call
```

## Speaking and hearing

ElevenLabs does both. Gemini does the thinking only. Put the key in your `.env`, beside the Gemini one:

```
ELEVENLABS_API_KEY=...
```

Choose the voice and the models in `settings.py`:

```python
ELEVEN_VOICE = "21m00Tcm4TlvDq8ikWAM"       # any voice id from your ElevenLabs library
ELEVEN_SPEAK_MODEL = "eleven_flash_v2_5"    # the low-latency one: first audio in well under a second
ELEVEN_HEAR_MODEL = "scribe_v1"
```

If ElevenLabs refuses a request — a rejected key, no credit, too many at once — the reply is still on screen
and the call carries on without a voice, with the reason in the log.

## Knowing when the customer has finished

The browser decides that with [Silero VAD](https://github.com/snakers4/silero-vad): a small neural network
that judges each 32 ms frame and says how likely it is to contain a human voice. That is a different
question from "is this loud", which is why a fan, a television or traffic no longer hold a turn open — they
are loud, but none of them is a voice. Only speech is sent to be transcribed.

It runs entirely in the browser, on the CPU, in well under a millisecond per frame. Nothing is sent anywhere
to make the decision.

The model and its runtime live in `frontend/public/vendor/` (copied into `web/vendor/` by the build) rather
than being fetched from a CDN, so starting a call
needs nothing from the internet:

| file | what it is |
| --- | --- |
| `silero_vad_v5.onnx` | the voice detector itself (2.2 MB), chosen by `model: "v5"` |
| `silero_vad_legacy.onnx` | the wrapper's own default model, kept so a missing option can't break startup |
| `bundle.min.js`, `vad.worklet.bundle.min.js` | `@ricky0123/vad-web` 0.0.31, the browser wrapper |
| `ort.wasm.min.js`, `ort-wasm-simd-threaded.*` | ONNX Runtime 1.22.0, which runs the model |

To fetch them again, take those names from
`https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/` and
`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/`.

The runtime's version must match the one built into `bundle.min.js` (vad-web 0.0.31 carries 1.22.0).
With a mismatch the model fails to start with `t.getValue is not a function`, and every call quietly falls
back to the loudness test. The decision log says which one a call is using.

Thresholds are in `frontend/src/lib/vad.js`: `positiveSpeechThreshold` is how sure the model must be before a turn
starts, and `redemptionMs` how long a silence must last before the turn is sent. If the model can't be
loaded, the call falls back to the old loudness test and says so.

## How long it thinks

Thinking tokens are made *before* the first word of a reply, so on a call they are not cleverness — they are
silence the customer sits through. A turn is one judgement and one short sentence against a system prompt that
already spells out how to judge an answer, so it asks for the least the model offers. Work with nobody waiting
on it — the summary, and suggesting questions on the setup page — can afford more.

```python
THINKING_ON_A_TURN = "MINIMAL"   # what the customer waits for
THINKING_OFF_CALL  = "LOW"       # the summary, and the setup page
```

If a model won't accept a level it says so, and the call drops to one that works rather than failing. Raise
`THINKING_ON_A_TURN` to `"LOW"` if answers start being judged carelessly.

## Nothing is pre-written

Every word the assistant says is written by the AI in the moment: the opening line, the questions, the
read-back, the goodbye. There are no fixed greetings or sign-offs to fall out of step with the conversation.

## Notes

- **Free tier**: 500 Gemini requests per model per day. A turn costs one, plus one to open the call and one to
  summarise it. If a model runs out, the next in `settings.py` is used and the call log says so. Speaking and
  hearing are ElevenLabs and don't touch that allowance.
- Untick **Speak out loud** to test the logic without spending speech requests.
- Chrome or Edge give the best microphone behaviour; Safari needs a click before it will play audio.
