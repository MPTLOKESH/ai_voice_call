"""The shapes everything else uses: the setup a business writes, and the state of one call."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field

from . import settings

AnswerType = Literal["text", "number", "date", "time", "yes_no", "choice"]
Tone = Literal["friendly", "warm", "professional", "energetic", "calm"]
ReplyLength = Literal["brief", "balanced", "chatty"]
Formality = Literal["casual", "neutral", "formal"]


class Question(BaseModel):
    save_as: str = Field(description="short snake_case name for the answer, e.g. party_size")
    ask: str = Field(description="the question as the assistant would say it, under 15 words")
    type: AnswerType = "text"
    rule: str = Field("", description="what makes an answer acceptable, in plain English")
    options: list[str] = Field(default_factory=list, description="allowed answers, only for type choice")
    required: bool = True
    # Asked only when an earlier question was answered with one of these values, e.g. only ask what went
    # wrong when on_time is "no". Code decides this, not the AI, so a skipped question is never asked.
    only_if: str = Field("", description="leave empty")
    only_if_is: list[str] = Field(default_factory=list, description="leave empty")


class BusinessSetup(BaseModel):
    """Everything a business decides. Saved as config/business.json and edited in the browser."""

    business_name: str = "Your business"
    assistant_name: str = "Assistant"
    purpose: str = ""
    calling_from: str = ""                        # e.g. "the customer care team"
    ai_disclosure: Literal["when_asked", "at_start"] = "when_asked"
    language: str = "English"
    business_info: list[str] = Field(default_factory=list)
    rules: list[str] = Field(default_factory=list)
    max_minutes: float = 4
    questions: list[Question] = Field(default_factory=list)

    # personality
    tone: Tone = "friendly"
    reply_length: ReplyLength = "balanced"
    formality: Formality = "neutral"

    # voice and speech
    voice_id: str = ""                            # empty: settings.ELEVEN_VOICE
    speaking_speed: float = Field(1.0, ge=0.7, le=1.2)
    other_languages: list[str] = Field(default_factory=list)

    # how the conversation runs
    tries_per_question: int = Field(settings.TRIES_PER_QUESTION, ge=1, le=5)
    silences_before_ending: int = Field(settings.SILENCES_BEFORE_ENDING, ge=1, le=5)
    confirm_at_end: bool = True
    allow_interruptions: bool = True
    wait_after_speech_ms: int = Field(450, ge=300, le=1500)

    def question(self, save_as: str) -> Question | None:
        return next((q for q in self.questions if q.save_as == save_as), None)


# ── what the AI returns for one turn ─────────────────────────────────────────

class Answer(BaseModel):
    save_as: str
    value: str
    valid: bool
    # Only filled in when the answer was refused, and most are not, so it is not required: the model
    # would otherwise write "problem": null for every answer on every turn, and each of those tokens is
    # made one at a time while the customer waits.
    problem: str = ""


class Turn(BaseModel):
    answers: list[Answer]
    intent: Literal["answering", "confirms", "wants_to_stop"]
    reply: str


class Summary(BaseModel):
    summary: str
    follow_up_needed: bool


# ── the state of one call ────────────────────────────────────────────────────

@dataclass
class Call:
    setup: BusinessSetup
    customer: dict
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    step: str = "ask"                            # ask -> confirm -> finish
    answers: dict = field(default_factory=dict)  # save_as -> {"value": ..., "said": their words}
    skipped: set = field(default_factory=set)
    failed: dict = field(default_factory=dict)
    changes: list = field(default_factory=list)  # answers revised later in the call
    transcript: list = field(default_factory=list)
    events: list = field(default_factory=list)   # what the manager decided, for the live view
    silences: int = 0
    hurry: bool = False                          # near the time limit: nothing optional, no read-back
    outcome: str | None = None
    end_reason: str | None = None
    summary: dict | None = None
    started: float = field(default_factory=time.monotonic)

    def applies(self, question: Question) -> bool | None:
        """Whether a question is wanted on this call: None until the answer it depends on is in."""
        if not question.only_if:
            return True
        parent = self.setup.question(question.only_if)
        if parent is None:
            return True
        given = self.answers.get(parent.save_as)
        if given is None:
            return False if parent.save_as in self.skipped or self.applies(parent) is False else None
        return given["value"].strip().lower() in {value.strip().lower() for value in question.only_if_is}

    def _open(self, question: Question) -> bool:
        return question.save_as not in self.answers and question.save_as not in self.skipped

    def unanswered(self) -> list[Question]:
        """What can be asked now."""
        return [q for q in self.setup.questions if self._open(q) and self.applies(q)]

    def still_to_come(self) -> list[Question]:
        """What may yet be asked: `unanswered`, plus questions waiting on an earlier answer."""
        return [q for q in self.setup.questions if self._open(q) and self.applies(q) is not False]

    def not_needed(self) -> list[Question]:
        return [q for q in self.setup.questions if q.save_as not in self.answers and self.applies(q) is False]

    def missing_required(self) -> list[Question]:
        return [q for q in self.setup.questions
                if q.required and q.save_as not in self.answers and self.applies(q) is not False]

    def add(self, speaker: str, text: str):
        self.transcript.append({"speaker": speaker, "text": text})

    def note(self, text: str):
        self.events.append({"at": round(self.seconds(), 1), "text": text})

    def last_said(self) -> str:
        return next((line["text"] for line in reversed(self.transcript) if line["speaker"] == "customer"), "")

    def last_asked(self) -> str:
        return next((line["text"] for line in reversed(self.transcript) if line["speaker"] == "assistant"), "")

    def recent(self, turns: int = settings.RECENT_TURNS) -> str:
        lines = [f"{'You' if t['speaker'] == 'assistant' else 'Customer'}: {t['text']}"
                 for t in self.transcript[-turns:]]
        return "\n".join(lines) or "(the call has just started)"

    def answers_text(self) -> str:
        return ", ".join(f"{k} = {a['value']}" for k, a in self.answers.items()) or "nothing"

    def seconds(self) -> float:
        return time.monotonic() - self.started

    def seconds_left(self) -> float:
        return self.setup.max_minutes * 60 - self.seconds()

    def snapshot(self) -> dict:
        """Everything the browser needs to draw the live view."""
        return {
            "id": self.id, "step": self.step, "outcome": self.outcome, "end_reason": self.end_reason,
            "answers": {k: a["value"] for k, a in self.answers.items()},
            "said": {k: a["said"] for k, a in self.answers.items()},
            "unanswered": [q.save_as for q in self.unanswered()],
            "missing_required": [q.save_as for q in self.missing_required()],
            "not_needed": [q.save_as for q in self.not_needed()],
            "skipped": sorted(self.skipped), "failed": dict(self.failed), "changes": self.changes,
            "transcript": self.transcript, "events": self.events, "seconds": round(self.seconds(), 1),
            "summary": self.summary,
        }
