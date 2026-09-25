# How Voice Call works

This walks through what happens from the moment you set the assistant up to the moment a call is saved:
what each piece does, what it's built with, and why it was built that way.

- [The big picture](#the-big-picture)
- [What we use, and why](#what-we-use-and-why)
- [Where things live](#where-things-live)
- [1. Setting the assistant up](#1-setting-the-assistant-up)
- [2. Starting a call](#2-starting-a-call)
- [3. One turn of the conversation](#3-one-turn-of-the-conversation)
- [4. Interruptions](#4-interruptions)
- [5. The rules code enforces](#5-the-rules-code-enforces)
- [6. Keeping to the time limit](#6-keeping-to-the-time-limit)
- [7. How a call ends, and what is saved](#7-how-a-call-ends-and-what-is-saved)
- [8. The prompts: what the AI is told, and when](#8-the-prompts-what-the-ai-is-told-and-when)
- [9. When something goes wrong](#9-when-something-goes-wrong)
- [Where to change things](#where-to-change-things)

---

## The big picture

```
 BROWSER                                   SERVER (Python)                       SERVICES
 ───────                                   ───────────────                       ────────
 Setup page ──── save / suggest ─────────► server.py ── storage.py ──► config/business.json
                                                     └─ suggestions.py ─────────► Gemini

 Call page
   microphone
     │
   Silero VAD  "is that a voice? have they finished?"
     │
   16 kHz WAV ─── POST /api/call/turn ───► server.py
                                             │ speech → text ──────────────────► ElevenLabs Scribe
                                             │
                                           engine.py
                                             │ one request: judge + reply ──────► Gemini
                                             │ code decides what is kept and what happens next
                                             │
                                             │ text → speech, a sentence at a time ► ElevenLabs Flash
   speaker ◄── reply text, then audio ───────┘
   (Web Audio)       (same response)

 At the end:  storage.py ──► data/calls/<id>.json     summary ──► Gemini
```

The idea throughout: **the AI proposes, code decides.** Gemini listens to what the customer said and
suggests answers, an intent and a reply. Plain Python then decides what is actually saved, which question
comes next, and whether the call ends. That keeps the call predictable, however the model behaves.

---

## What we use, and why

| Piece | Used for | Why this and not something else |
|---|---|---|
| **Python standard library** (`http.server`) | The web server | Nothing extra to install or run. One call is one person talking, so a small threaded server is plenty. |
| **Gemini** (`google-genai`) | All the thinking: judging answers, writing every reply, the opening line, the summary, suggested questions | Fast "flash-lite" models are cheap enough for one request per turn. It can be made to answer in a fixed JSON shape, so the code never has to pick apart free text. The free tier allows 500 requests per model per day, and the code moves to the next model when one runs out. |
| **Pydantic** | The shapes of everything: `BusinessSetup`, `Question`, `Turn`, `Summary` | Checks the setup when it's saved. The same classes also become the JSON schema Gemini must fill, so the model's reply arrives already checked. |
| **ElevenLabs Flash** (`eleven_flash_v2_5`) | Speaking | Built for low delay: the first audio arrives well under a second after the text is sent. It streams raw audio the browser can play as it arrives, and handles Hindi, Tamil and other languages. |
| **ElevenLabs Scribe** (`scribe_v1`) | Hearing (speech to text) | Accurate across many languages, including Indian ones. Told not to write sounds like "(music)" into the text, so noise isn't mistaken for words. |
| **Silero VAD** (runs in the browser) | Deciding when someone is speaking, and when they have finished | It asks "is this a *voice*?", not "is this *loud*?", so fans, TVs and traffic don't hold a turn open. It runs on the caller's own computer in under a millisecond per frame, so no audio is sent anywhere just to decide that. |
| **ONNX Runtime Web** | Runs the Silero model in the browser | The standard way to run a small neural network in a web page. Bundled in `web/vendor/` so a call needs nothing from the internet. |
| **Web Audio API** | Playing the reply and recording the microphone | Built into every browser. Its echo cancellation stops the assistant's own voice being heard as the customer, which is what lets you interrupt on speakers, not just headphones. |
| **Plain JavaScript modules** | The pages | No build step: edit a file, reload the page. |
| **python-dotenv** | Reading the API keys from `.env` | Keeps keys out of the code and out of git. |

---

## Where things live

```
voice_call/
  __main__.py     `python -m voice_call`: starts the server
  settings.py     models, limits, timings, paths: the numbers you tune
  models.py       BusinessSetup · Question · Call (the state of one call) · Turn · Summary
  prompts.py      every word the AI is told
  engine.py       one turn of a call: think → keep_answers → next_step
  gemini.py       talking to Gemini: JSON replies, retries, switching models
  elevenlabs.py   talking to ElevenLabs: streaming speech, transcription, voice list
  voices.py       speaking and hearing as the rest of the code uses them; caches repeated lines
  speech.py       splitting a reply into pieces so the first words play sooner
  suggestions.py  "Suggest questions" on the setup page
  storage.py      reading and writing the setup and finished calls
  server.py       the HTTP server: pages, API, streamed replies
web/
  index.html · styles.css
  js/app.js       starts the page
  js/setup.js     the setup form
  js/call.js      the call: turns, interruptions, the live view
  js/vad.js       Silero voice detection
  js/audio.js     the player, and the older loudness-based detector used as a fallback
  js/api.js       every request to the server
  vendor/         Silero model and ONNX Runtime, bundled
config/business.json   your setup (written by Save, not in git)
data/calls/            one JSON file per finished call (not in git)
```

---

## 1. Setting the assistant up

On the setup page a business fills in who it is, why it's calling, its tone, voice, rules, the facts the
assistant may share, and the questions to ask.

- **Save** sends the form to `POST /api/setup`. Pydantic checks it (for example, speed must be between
  0.7 and 1.2), and it is written to `config/business.json`.
- **Suggest questions** sends the purpose to `POST /api/suggest`. Gemini returns 3–5 questions in the
  `Question` shape, and they're added to the list as ordinary, editable rows.
- **Hear it** sends a sample line to `POST /api/hear` and plays it in the chosen voice and speed.

Before a call starts, the setup is checked by plain rules (`check_setup` in `server.py`): at least one
question, a purpose, no two questions saved under the same name, choices with at least two options, and a
conditional question only depending on one *above* it, so two questions can never wait on each other.

---

## 2. Starting a call

1. You press **Start**. The browser opens the microphone and loads Silero.
2. `POST /api/call/start`. The server builds a `Call` object: the setup, the customer's details, and empty
   answers. It lives in memory for the length of the call.
3. `engine.start()` asks Gemini for the opening line: greet them, say who is calling and for whom, and ask
   if now is a good time. Nothing else yet.
4. The server replies in two parts on one connection:
   - **one line of JSON**: the text to say plus the call's state (answers, step, log);
   - **raw audio** straight after it, streamed as ElevenLabs produces it.
5. The browser shows the text the moment it arrives and plays the audio as it streams in.

---

## 3. One turn of the conversation

This is the heart of it. Every time the customer speaks, exactly this happens:

```
 ① browser   Silero hears a voice start… then enough silence to call it finished
 ② browser   the speech is packed into a 16 kHz WAV and sent to POST /api/call/turn
 ③ server    Scribe turns it into text
 ④ server    no words in it (just noise)? → ignored; the assistant carries on as if nothing happened
 ⑤ engine    time check: nearly out of time? drop optional questions (see §6)
 ⑥ engine    ONE Gemini request →  { answers: [...], intent: "...", reply: "..." }
 ⑦ engine    keep_answers(): code decides which answers are really saved
 ⑧ engine    next_step(): code decides: ask the next question, read back, or finish
 ⑨ server    reply text sent at once; speech streamed behind it, sentence by sentence
 ⑩ browser   plays the audio, and listens again as soon as the text lands
```

**① Knowing they've finished.** Silero scores every 32 ms of audio for "chance this is a voice". A turn
starts above 35% and ends after a stretch of silence, 450 ms by default (the *wait after speech* setting).
During the read-back the wait is shorter (300 ms), because a "yes" doesn't need a long pause. Nothing may
run forever: after 10 seconds of continuous speech, the turn is sent as it stands.

**⑥ One request per turn.** Gemini gets two things:
- the **system prompt** (`ASSISTANT_BACKGROUND`): who the assistant is, the business, the facts it may
  share, its rules, the questions, and how to judge an answer;
- the **turn prompt** (`TURN_JOB`): today's date, what's saved, what's still needed, the last few lines of
  conversation, what the customer just said, and **the task for this turn**, which code chose (see §8).

It answers in the fixed `Turn` shape. The model is told to "think" as little as possible
(`THINKING_ON_A_TURN = "MINIMAL"`), because on a phone call thinking time is silence the customer sits
through.

**⑨ Why it feels quick.**
- **One request carries everything.** Hearing, thinking and speaking all happen inside a single request
  from the browser, with no extra round trips.
- **Text first, then audio.** The reply text is sent the instant it exists, and audio follows in the same
  response.
- **The first piece is short.** A reply is split into sentences, and a long first sentence is cut at a
  comma or a word break before 40 characters, so the customer hears the first words sooner.
- **Repeated lines are cached.** Anything said once is kept (up to 40 lines per server run), so it plays
  instantly the next time.

---

## 4. Interruptions

The customer can talk over the assistant at any time (unless the business turned it off).

1. While the assistant is speaking, the microphone stays on. Echo cancellation removes the assistant's own
   voice from it.
2. If Silero hears **at least 0.4 s of real voice** (an average of 60% or more) while audio is playing, it's
   an interruption. A cough or a door isn't enough.
3. The browser **stops the audio at once** and cancels the request that was still streaming, so the server
   stops making speech nobody will hear. The cut-off reply is faded in the transcript with "— cut off".
4. When the customer finishes, their words go to the server **marked as an interruption**
   (`X-Interrupted: 1`).
5. The server flags the assistant's last line as cut off, so the model knows the customer may not have
   heard the end of it.
6. The model is told to **deal with what they said first**:
   - they **answered**: save it and carry on as normal;
   - they **asked something**: answer from the facts it may share, or say a colleague will follow up;
   - they **commented or complained**: respond to that.

   In the last two cases it asks nothing else in that reply, keeps to its usual length, and follows its
   rules. The next question waits for the following turn.

Without step 4 the server believed the whole reply had been heard. With only "ask the next question" as its
task, the model moved straight on, and the customer felt ignored.

---

## 5. The rules code enforces

The model suggests; these are decided in Python (`engine.py`, `models.py`) and can't be talked around:

| Rule | Where |
|---|---|
| An answer is saved only if the model marked it valid. | `keep_answers` |
| A "choice" answer must exactly match one of the listed options, or it isn't saved. | `keep_answers` |
| A changed answer replaces the old one, and the change is recorded. | `keep_answers` |
| An unclear answer counts as a try. After *tries per question* (3 by default) the question is dropped. | `keep_answers` |
| When asking again, the model is told how many times it has already tried, so it rephrases instead of repeating itself. | `task_now` |
| A conditional question ("only ask if on_time is no") is asked only when the earlier answer matches. | `Call.applies` |
| "I want to stop" from fewer than 3 words is ignored: a couple of stray words are more likely a mis-hearing. | `reply_to` |
| Silent turns in a row (2 by default) end the call. | `reply_to` |
| A safety net: after about 20 exchanges the call wraps up, whatever happens. | `MAX_REPLIES` |
| The call ends only when code says so (`next_step`, the silence rule, or the time limit), never just because the model wrote a goodbye. | `reply_to`, `next_step` |

The steps are always **greet → ask → confirm (read-back) → finish**. The read-back can be turned off, in
which case the assistant says goodbye straight after the last answer.

---

## 6. Keeping to the time limit

Each business sets a maximum call length (4 minutes by default).

- **Hurrying.** In the last third of the time, or the last 30 seconds, whichever is longer, the call
  hurries: optional questions are dropped, the read-back is skipped (unless it has already started), and
  the model is told how many seconds are left.
- **Saying goodbye in time.** With less than about one exchange left (10 seconds), the next reply is a
  goodbye. Anything still missing is left for "a colleague will follow up".
- **When the line goes quiet.** The server only sees the clock when a turn arrives, so the browser keeps
  its own timer too. If time runs out while nobody is speaking, it sends a silent turn and the server says
  goodbye.

---

## 7. How a call ends, and what is saved

A call ends when:
- the customer confirms the read-back;
- they answer the last question (read-back off);
- they want to stop;
- they stay silent too many times;
- or time runs out.

1. The goodbye is written by the AI like every other line, and spoken.
2. The call is saved to `data/calls/<id>.json` **before** the goodbye is streamed, so the file is there even
   if the browser closes.
3. After the customer has hung up, a summary is written (one more Gemini request; nobody is waiting now, so
   it may think longer) and the file is saved again with it.

What each file contains:

| Field | What it is |
|---|---|
| `answers` | the saved value for each question |
| `in_their_words` | what the customer actually said for each |
| `not_answered` | required questions that weren't answered |
| `not_needed` | conditional questions that didn't apply |
| `changed_during_call` | answers the customer revised |
| `outcome`, `end_reason` | `completed` / `incomplete`, and why it ended |
| `transcript` | the whole conversation; lines the customer talked over are marked `cut_off` |
| `decisions` | the log of what the code did and when |
| `summary` | the staff note |

The server keeps the last 20 finished calls in memory as well, so the page can still show them.

---

## 8. The prompts: what the AI is told, and when

Everything is in `voice_call/prompts.py`. The Python code never writes wording itself; it only picks which
piece to use.

| Prompt | Sent when |
|---|---|
| `ASSISTANT_BACKGROUND` | the system prompt on every request during a call |
| `TONES`, `REPLY_LENGTHS`, `FORMALITY`, `DISCLOSURE`, `LANGUAGE_*` | pieces of the system prompt, chosen by the setup |
| `OPENING_JOB` | the first line of the call |
| `TURN_JOB` | every turn, with one task from below filled in |
| `STEP_TASKS["ask"]` | asking a question for the first time |
| `STEP_TASKS["ask_again"]` | asking again after an unclear answer |
| `STEP_TASKS["confirm"]` | the read-back |
| `STEP_TASKS["silence"]` | nobody spoke |
| `STEP_TASKS["goodbye"]` | everything is collected but the reply wasn't a goodbye |
| `STEP_TASKS["time_up"]` | out of time |
| `LAST_QUESTION` | added when this is the final question and no read-back follows |
| `HURRY` | added near the time limit |
| `INTERRUPTED` | wraps the task when the customer talked over the last reply |
| `SUMMARY_PROMPT` | the staff note after the call |
| `SUGGEST_QUESTIONS_PROMPT` | "Suggest questions" on the setup page |

**Every word is written in the moment.** Nothing the assistant says is pre-written, not even the greeting
or the goodbye, so it never sounds out of step with the conversation.

---

## 9. When something goes wrong

| Problem | What happens |
|---|---|
| A Gemini model runs out of its daily quota | Switches to the next model in `AI_MODELS` and notes it in the call log. |
| Gemini is busy or errors briefly | Retries up to 3 more times, 2 seconds apart. |
| A model refuses the "think less" setting | Falls back to a level it accepts, remembers that, and carries on. |
| A Gemini request hangs | Gives up after 20 seconds, rather than leaving the call stuck. |
| ElevenLabs fails (bad key, no credit, too busy) | The reply is still on screen and the call carries on without a voice. The reason goes in the log. |
| The account can't use 24 kHz audio | Tries lower quality and converts it, so the browser always gets the same format. |
| Only noise was recorded | Ignored. The assistant finishes what it was saying. |
| Two turns arrive at once (talking over a reply that's still thinking) | Handled one at a time per call, so answers never get mixed up. |
| Silero can't load | Falls back to the older loudness-based detector, and says so. |
| The summary fails | The call is still saved, without it. |

---

## Where to change things

| To change… | Edit |
|---|---|
| What the assistant says, or how it judges answers | `voice_call/prompts.py` |
| Which Gemini models are used, and in what order | `AI_MODELS` in `settings.py` |
| How long the model thinks | `THINKING_ON_A_TURN`, `THINKING_OFF_CALL` in `settings.py` |
| The default voice, or the speech models | `ELEVEN_*` in `settings.py` |
| When hurrying starts, and how much a goodbye needs | `HURRY_SHARE`, `HURRY_SECONDS`, `SECONDS_PER_EXCHANGE` in `settings.py` |
| How much conversation the model sees | `RECENT_TURNS` in `settings.py` |
| How sensitive voice detection and interrupting are | `TUNING`, `INTERRUPT_AFTER`, `INTERRUPT_CHANCE` in `web/js/vad.js` |
| What is saved for each call | `save_call` in `storage.py` |
| The rules for saving answers or ending a call | `keep_answers`, `next_step` in `engine.py` |
