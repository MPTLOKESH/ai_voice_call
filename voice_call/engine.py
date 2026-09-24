"""The call itself: one AI call per turn, then plain code decides what is kept and where the call goes.

The AI proposes; `keep_answers` and `next_step` are the only places a value is stored or a call is ended.
"""
from __future__ import annotations

import time
from datetime import date

from . import prompts, settings
from .gemini import ask_ai
from .models import Answer, BusinessSetup, Call, Question, Summary, Turn


def speaking(setup: BusinessSetup) -> str:
    """The first lines of "How to speak": language, length and formality."""
    others = [language for language in setup.other_languages if language.strip()]
    return "\n".join([
        prompts.LANGUAGE_SWITCH.format(language=setup.language, others=" or ".join(others)) if others
        else prompts.LANGUAGE_ONLY.format(language=setup.language),
        prompts.REPLY_LENGTHS[setup.reply_length], prompts.FORMALITY[setup.formality]])


def describe(q: Question) -> str:
    extras = [q.type + (": " + " / ".join(q.options) if q.options else "")]
    if not q.required:
        extras.append("optional")
    if q.only_if:
        extras.append(f"only if {q.only_if} is {' or '.join(q.only_if_is)}")
    return f'- {q.save_as} ({", ".join(extras)}): "{q.ask}"' + (f" Rule: {q.rule}" if q.rule else "")


def background(call: Call) -> str:
    """The system prompt: who the assistant is, the business, the rules and the questions."""
    setup = call.setup
    return prompts.ASSISTANT_BACKGROUND.format(
        assistant=setup.assistant_name, business=setup.business_name, purpose=setup.purpose,
        calling_from=f", from {setup.calling_from.strip()}" if setup.calling_from.strip() else "",
        customer=", ".join(f"{k}: {v}" for k, v in call.customer.items()) or "nothing known",
        info="\n".join(f"- {i}" for i in setup.business_info) or "- (none)",
        rules="\n".join(f"- {r}" for r in setup.rules) or "- (none)",
        questions="\n".join(describe(q) for q in setup.questions),
        tone=prompts.TONES[setup.tone], speaking=speaking(setup),
        disclosure=prompts.DISCLOSURE[setup.ai_disclosure])


HOW_MANY = {1: "once", 2: "twice"}


def final_question(call: Call) -> Question | None:
    """The question the call ends on, when there is no read-back to end on instead."""
    left = call.still_to_come()
    return left[0] if not call.setup.confirm_at_end and len(left) == 1 and call.step != "confirm" else None


def task_now(call: Call) -> str:
    """What the assistant should be doing on this turn."""
    if call.step == "confirm" or not call.unanswered():
        return prompts.STEP_TASKS["confirm"]

    last = prompts.LAST_QUESTION if final_question(call) else ""
    question = call.unanswered()[0]
    # `failed` is the count code keeps of answers it refused. The model has no memory between turns and
    # only sees the last few lines, so without being told it cannot tell a first ask from a third — and it
    # asks in the same words every time, at the one moment the customer is already struggling to be
    # understood. Telling it is what makes "ask it differently" something it can actually do.
    tries = call.failed.get(question.save_as, 0)
    if not tries:
        return prompts.STEP_TASKS["ask"].format(question=question.ask) + last
    return prompts.STEP_TASKS["ask_again"].format(
        question=question.ask, tries=HOW_MANY.get(tries, f"{tries} times")) + last


def think(call: Call, message: str, task: str) -> Turn:
    """The one AI call: what they said, what it means, and what to say back."""
    prompt = prompts.TURN_JOB.format(
        today=date.today(), answers=call.answers_text(),
        missing=", ".join(q.save_as for q in call.unanswered()) or "nothing",
        recent=call.recent(), message=message, task=task)
    return ask_ai(Turn, prompt, system=background(call), temperature=0.4,
                  thinking=settings.THINKING_ON_A_TURN)


def keep_answers(call: Call, turn: Turn):
    """Save only what is valid. An answer given later replaces an earlier one."""
    for answer in turn.answers:
        question = call.setup.question(answer.save_as)
        if question is None:
            continue
        value, valid = answer.value.strip(), answer.valid
        if not value:
            continue          # nothing was actually said about it: not an answer, and not a failed try
        if valid and question.type == "choice":
            match = next((o for o in question.options if o.lower() == value.lower()), None)
            value, valid = match or value, match is not None
        if valid and value:
            previous = call.answers.get(question.save_as, {}).get("value")
            if previous is not None and previous != value:
                call.changes.append({"question": question.save_as, "from": previous, "to": value})
                call.note(f"{question.save_as} changed from {previous} to {value}")
            else:
                call.note(f"saved {question.save_as} = {value}")
            call.answers[question.save_as] = {"value": value, "said": call.last_said()}
            call.skipped.discard(question.save_as)
            call.failed.pop(question.save_as, None)          # a clear answer wipes earlier failed tries
        else:
            call.failed[question.save_as] = call.failed.get(question.save_as, 0) + 1
            call.note(f"not saved {question.save_as} = {answer.value!r}: {answer.problem or 'unclear'}")
            tries = call.setup.tries_per_question
            if call.failed[question.save_as] >= tries:
                call.skipped.add(question.save_as)
                call.note(f"giving up on {question.save_as} after {tries} {'try' if tries == 1 else 'tries'}")


def next_step(call: Call, intent: str) -> tuple[str, str | None]:
    """Where the call goes next, and the outcome if it should end."""
    done = "completed" if not call.missing_required() else "incomplete"
    if intent == "wants_to_stop":
        return "finish", "incomplete"
    if call.step == "confirm" and intent == "confirms":
        return "finish", done
    if call.unanswered():
        return "ask", None
    return ("confirm", None) if call.setup.confirm_at_end else ("finish", done)


def opening(call: Call) -> str:
    """The first thing said. Written by the AI like everything else, so the call opens in its own voice."""
    prompt = prompts.OPENING_JOB.format(
        today=date.today(), name=prompts.OPENING_NAME if call.customer.get("name") else "",
        ai=prompts.OPENING_AI if call.setup.ai_disclosure == "at_start" else "")
    return ask_ai(Turn, prompt, system=background(call), temperature=0.6,
                  thinking=settings.THINKING_ON_A_TURN).reply


def start(setup: BusinessSetup, customer: dict | None = None) -> tuple[Call, str]:
    """Begin a call. Returns the call and the opening line."""
    call = Call(setup, dict(customer or {}))
    greeting = opening(call)
    call.add("assistant", greeting)
    call.note("call started")
    return call, greeting


def reply_to(call: Call, message: str) -> dict:
    """One turn: what they said goes in, what the assistant says comes back.

    Returns {"say": text, "ended": bool, "think_ms": int}.
    """
    if call.outcome:
        return {"say": "", "ended": True, "think_ms": 0}

    if not message.strip():                                   # nobody spoke
        call.silences += 1
        call.note(f"silence {call.silences}")
        if call.silences >= call.setup.silences_before_ending:
            call.outcome, call.end_reason = "incomplete", "no answer"
            call.note(f"no answer {HOW_MANY.get(call.silences, f'{call.silences} times')}: "
                      "ending without a goodbye")
            return {"say": "", "ended": True, "think_ms": 0}
        began = time.monotonic()
        turn = think(call, "(they said nothing)", prompts.STEP_TASKS["silence"])
        call.add("assistant", turn.reply)
        return {"say": turn.reply, "ended": False, "think_ms": int((time.monotonic() - began) * 1000)}

    call.silences = 0
    call.add("customer", message)

    out_of_time = call.seconds() > call.setup.max_minutes * 60
    too_many = len(call.transcript) >= settings.MAX_REPLIES * 2
    began = time.monotonic()
    final = final_question(call)                              # asked with "say goodbye once it's answered"
    turn = think(call, message, prompts.STEP_TASKS["stop"] if out_of_time or too_many else task_now(call))
    think_ms = int((time.monotonic() - began) * 1000)

    keep_answers(call, turn)

    # A few stray words are usually a mis-hearing, not someone asking to end the call. Ending on that is
    # far worse than asking again, so only a real sentence may stop a call.
    intent = turn.intent
    if intent == "wants_to_stop" and len(message.split()) < 3:
        call.note(f"ignoring 'wants to stop' from {message!r}: too short to be sure")
        intent = "answering"
    if out_of_time or too_many:
        intent = "wants_to_stop"
    step, outcome = next_step(call, intent)
    if step != call.step:
        call.note(f"step: {call.step} -> {step}")
        call.step = step

    if outcome:
        call.outcome = outcome
        early = intent == "wants_to_stop"
        call.end_reason = ("took too long" if out_of_time else "went on too long" if too_many else
                           turn.intent if early or call.setup.confirm_at_end else "all asked")
        call.note(f"finishing: {outcome} ({call.end_reason})")
        say = turn.reply                                      # the AI says its own goodbye
        if not early and not call.setup.confirm_at_end and (final is None or final.save_as not in call.answers):
            # The reply was written to ask something, not to end on: the last answer came early, or the
            # last question was given up on. It needs a goodbye of its own.
            began = time.monotonic()
            say = think(call, message, prompts.STEP_TASKS["goodbye"]).reply
            think_ms += int((time.monotonic() - began) * 1000)
            call.note("wrote a goodbye: the reply was not one")
        call.add("assistant", say)
        return {"say": say, "ended": True, "think_ms": think_ms}

    call.add("assistant", turn.reply)
    return {"say": turn.reply, "ended": False, "think_ms": think_ms}


def summarise(call: Call) -> Summary:
    """One AI call after the customer has hung up, where slowness costs nothing."""
    conversation = "\n".join(f"{'Assistant' if t['speaker'] == 'assistant' else 'Customer'}: {t['text']}"
                             for t in call.transcript)
    prompt = prompts.SUMMARY_PROMPT.format(
        business=call.setup.business_name, language=call.setup.language, outcome=call.outcome,
        answers=call.answers_text(), conversation=conversation)
    # Nobody is on the line by now, so this one may think as long as it likes.
    return ask_ai(Summary, prompt, temperature=0, thinking=settings.THINKING_OFF_CALL)
