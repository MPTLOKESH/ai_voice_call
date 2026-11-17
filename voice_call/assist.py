"""The studio's chat: someone says what they want the call to do, and the AI proposes the steps.

The AI answers, and when a change was asked for it hands back the whole new list of steps. When the person
plainly told it what to do (`direct`), the studio makes the change at once and offers Undo; when it only
offers ideas, or is unsure, the studio shows what would change and the person applies it or not. When asked to
see the call (`show`), the studio lists the steps itself from the flow as it is, so the list is never made up.
"""
from __future__ import annotations

import json
import re

from pydantic import BaseModel

from . import prompts
from .gemini import ask_ai
from .models import BusinessSetup, Question

MAX_STEPS = 40          # more than any call should have: a runaway answer is cut here
RECENT = 12             # how much of the conversation the AI is shown

# What the AI is shown of a step, and so what it may change. Where a step sits on the canvas is not its business.
SHOWN = ("kind", "save_as", "ask", "type", "options", "rule", "required", "only_if", "only_if_is", "handoff", "back_to", "times")


class Brief(BaseModel):
    text: str


class NextSteps(BaseModel):
    options: list[Question]


class Proposal(BaseModel):
    reply: str
    changed: bool
    purpose: str = ""                   # why the call is made, when it is clear from the chat
    restart: bool = False               # the whole call is replaced by a different one
    questions: list[Question]
    ideas: list[Question] = []          # steps offered to pick from, not applied
    direct: bool = False                # the person plainly asked for this change: it is made at once, with Undo
    show: str = ""                      # "all", "questions" or "messages": list the call's steps for them


def _name(text: str, taken: set[str]) -> str:
    """A saved name that can be one: letters, numbers and underscores, and not used already."""
    base = re.sub(r"[^a-z0-9_]+", "_", (text or "").strip().lower()).strip("_") or "step"
    if base[0].isdigit():
        base = f"step_{base}"
    name, at = base, 2
    while name in taken:
        name, at = f"{base}_{at}", at + 1
    return name


_LOOPS = re.compile(r"\b(loop\w*|go(es)? back|again|repeat\w*|retr(y|ies)|re-?ask\w*|back to|second try)\b", re.I)


def _wants_loops(text: str) -> bool:
    """Whether the person talked about asking again or going back: a go-back is never added on the AI's own."""
    return bool(_LOOPS.search(text or ""))


def _condition_holds(step: Question, asks: dict[str, Question]) -> bool:
    """Whether a step's condition can be met and is not always true: it waits on an earlier question that is a
    yes or no or a choice, for one or some of its answers (all of them would be no condition at all)."""
    parent = asks.get(step.only_if)
    answers = {a.strip().lower() for a in step.only_if_is if a.strip()}
    if parent is None or not answers:
        return False
    if parent.type == "yes_no":
        possible = {"yes", "no"}
    elif parent.type == "choice":
        possible = {o.strip().lower() for o in parent.options if o.strip()}
    else:
        return False                    # a free answer (text, a number, a date) cannot be matched to a word
    return answers <= possible and answers != possible


def _beside(steps: list[Question], before: dict[str, Question]) -> list[Question]:
    """A new step that waits on an earlier question sits right after that question and the other steps that wait on
    it, so the ways of an if and its else are next to each other (the canvas draws them side by side)."""
    out: list[Question] = []
    for step in steps:
        parent = next((i for i, other in enumerate(out) if other.save_as == step.only_if and other.kind == "ask"), None) if step.only_if else None
        if parent is not None and step.save_as not in before:
            at = parent + 1
            while at < len(out) and out[at].only_if == step.only_if:
                at += 1
            out.insert(at, step)
        else:
            out.append(step)
    return out


def tidy(found: list[Question], setup: BusinessSetup, restart: bool = False, earlier: list[Question] | None = None,
         loops_ok: bool = True) -> list[Question]:
    """The proposed steps, made safe to show: names that work, each kept step where it was on the canvas, and
    conditions and go-backs only where they make sense.

    A step the person already had keeps its condition as it was. One the AI wrote is checked: a condition that
    points at nothing, at an answer that cannot happen, or that is true whatever the answer, is dropped. A go-back
    needs a real question earlier to return to and a condition of its own, and is never added unasked
    (`loops_ok`), nor twice for the same thing. `earlier` are questions that come before all of these.
    """
    before = {} if restart else {q.save_as: q for q in setup.questions}
    taken: set[str] = set()
    steps = []
    asks: dict[str, Question] = {q.save_as: q for q in (earlier or []) if q.kind == "ask"}
    loops: set[tuple[str, str, tuple[str, ...]]] = set()
    for step in found[:MAX_STEPS]:
        name = step.save_as if step.save_as.isidentifier() and step.save_as not in taken else _name(step.save_as or step.ask, taken)
        taken.add(name)
        old = before.get(name)
        mine = old is not None and (old.only_if, old.only_if_is, old.back_to) == (step.only_if, step.only_if_is, step.back_to)
        if step.only_if and step.kind != "end" and not mine and not _condition_holds(step, asks):
            step = step.model_copy(update={"only_if": "", "only_if_is": []})
        if step.kind == "loop" and not mine:
            key = (step.back_to, step.only_if, tuple(a.lower() for a in step.only_if_is))
            if not loops_ok or step.back_to not in asks or not step.only_if or key in loops:
                continue                # a go-back that goes nowhere, waits on nothing, was not asked for, or repeats one
            loops.add(key)
        if old is None and _asks_who(setup.purpose, step):
            continue                    # a new question for what the call already knows: who they are
        if step.kind == "ask":
            asks[name] = step
        steps.append(step.model_copy(update={
            "save_as": name, "x": old.x if old else None, "y": old.y if old else None,
            "times": min(5, max(1, step.times)),
            "options": step.options if step.type == "choice" else [],
            "only_if_is": step.only_if_is if step.only_if else [],
            "back_to": step.back_to if step.kind == "loop" else "",
            "handoff": step.handoff if step.kind == "end" else False,
        }))
    return _beside(steps, before)


_SHOW = re.compile(r"\b(show|list|display|see|view|print|read out|what (are|is|do)|what \w+ (are|is|do|does)|what's|whats|give me|tell me)\b", re.I)
_MAKE = re.compile(r"\b(add|creat\w*|build\w*|generat\w*|new|make|write|remove|delete|change|reword)\b", re.I)
SHOWS = {"all", "questions", "messages"}
_BUILD = re.compile(r"\b(creat\w*|build\w*|mak\w+|new|start\w*|generat\w*|design\w*|set ?up|write|add|workflow|flow|script)\b", re.I)


_THE_CALL = re.compile(r"\b(flow|steps?|script|questions?|messages?|(whole|entire|full|complete) call)\b", re.I)


def show_wanted(text: str) -> str:
    """"all", "questions" or "messages" when the text asks to SEE the call ("show me the flow", "list the questions"),
    else "". A request to build or change something is not a look."""
    text = text or ""
    if not _SHOW.search(text) or _MAKE.search(text) or not _THE_CALL.search(text):
        return ""
    asks, says = re.search(r"\bquestions?\b", text, re.I), re.search(r"\b(messages?|say|says|tell|tells)\b", text, re.I)
    return "questions" if asks and not says else "messages" if says and not asks else "all"


_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
_HOW_MANY = re.compile(r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:more |new |other |extra |additional |different )*questions?\b", re.I)
MAX_IDEAS = 10          # as many ideas as they ask for, up to here
MIN_FULL = 6            # a "complete flow" has at least this many questions
_FULL = re.compile(r"\b(complete|full|entire|whole|proper|detailed|end[- ]to[- ]end)\b[^.?!]{0,30}\b(flow|call|script|workflow)\b"
                   r"|\b(flow|call|script|workflow)\b[^.?!]{0,20}\b(complete|full|entire|end[- ]to[- ]end)\b", re.I)


def _requested(text: str) -> int:
    """How many questions the person asked for ("add 4 more questions"), 0 when they gave no number."""
    found = _HOW_MANY.search(text or "")
    if not found:
        return 0
    word = found.group(1).lower()
    return max(0, min(MAX_IDEAS, int(word) if word.isdigit() else _NUMBERS[word]))


def _wants_steps(text: str) -> bool:
    """Whether the last message reads as a request to build or add something rather than a question."""
    text = text or ""
    if _SHOW.search(text) and not _MAKE.search(text):
        return False                    # "show me the flow" is a look, not a build
    return bool(_BUILD.search(text)) and not str(text).strip().endswith("?")


def assist(setup: BusinessSetup, messages: list[dict], refs: list[str]) -> dict:
    """One reply in the studio chat. Returns {"reply", "changed", "questions"}; `questions` is the whole
    proposed list when `changed`, else empty."""
    chat = [m for m in messages if str(m.get("text") or "").strip()][-RECENT:]
    if not chat:
        return {"reply": "", "changed": False, "questions": []}
    known = {q.save_as for q in setup.questions} | {"greeting", "finish"}
    prompt = prompts.ASSIST_PROMPT.format(
        business_name=setup.business_name, purpose=setup.purpose or "not said yet", language=setup.language,
        steps=json.dumps([{k: v for k, v in q.model_dump().items() if k in SHOWN} for q in setup.questions],
                         ensure_ascii=False, indent=1) if setup.questions else "[] (no steps yet)",
        finish_note="The finish also closes the call, so there is no need to mention it." if setup.show_close else "The finish was taken off the canvas: tell them to right-click the canvas and choose Add the finish.",
        refs=", ".join(r for r in refs if r in known) or "none",
        chat="\n".join(f"{'Assistant' if m.get('role') == 'assistant' else 'Person'}: {str(m['text']).strip()[:1500]}"
                       for m in chat))
    found = ask_ai(Proposal, prompt, temperature=0.3)
    wanted = _wants_steps(chat[-1].get("text", ""))
    if wanted and not found.questions and not found.ideas and found.show not in SHOWS:
        # It answered in words only ("I have started"). The person asked for steps, so ask once more, firmly.
        found = ask_ai(Proposal, prompt + "\n\nYour last answer had no steps in `questions`. Answer again: "
                       "set `changed` true and put the complete list of steps in `questions` now, based on what "
                       "the person said. Do not describe what you will do.", temperature=0.3)
    # "add 4 more questions" means four: when the answer has another number, it is asked once more, firmly.
    count = _requested(chat[-1].get("text", ""))
    if count and (found.changed or found.ideas):
        have = {q.save_as for q in setup.questions}
        got = lambda f: len([q for q in f.questions if q.kind == "ask" and q.save_as not in have]) if f.changed else len(f.ideas)
        if got(found) != count:
            again = ask_ai(Proposal, prompt + f"\n\nThey asked for exactly {count} new questions, and your answer has {got(found)}. "
                           f"Answer again with exactly {count} new questions, not counting any other step, and keep every "
                           "other step exactly as it is.", temperature=0.3)
            if got(again) == count:
                found = again
    # A complete flow is not two questions: when it is asked for and the answer is thin, it is asked once more.
    asked = lambda f: len([q for q in f.questions if q.kind == "ask"])
    if not count and _FULL.search(chat[-1].get("text", "")) and found.changed and asked(found) < MIN_FULL:
        fuller = ask_ai(Proposal, prompt + f"\n\nThey asked for the COMPLETE flow, and your answer has only {asked(found)} questions. "
                        f"Answer again with the whole flow: keep the questions already there and add everything else this call's "
                        f"purpose needs, so that it has at least {MIN_FULL} questions in a sensible order.", temperature=0.3)
        if fuller.changed and asked(fuller) > asked(found):
            found = fuller
    restart = bool(found.restart and found.changed)
    steps = tidy(found.questions, setup, restart, loops_ok=_wants_loops(" ".join(m.get("text", "") for m in chat if m.get("role") != "assistant"))) if found.changed else []
    # Ideas are only offered: named so they never clash with the steps there, or with each other.
    used = {q.save_as for q in (steps if restart else setup.questions + steps)}
    ideas = []
    for idea in tidy(found.ideas, setup.model_copy(update={"questions": []}), True, earlier=setup.questions, loops_ok=False)[:MAX_IDEAS]:
        name = _name(idea.save_as, used)
        used.add(name)
        ideas.append(idea.model_copy(update={"save_as": name}))
    # Asked to see the flow: the AI says so in `show`; when it only answered in words, the words asked for are enough.
    show = found.show if found.show in SHOWS else ("" if steps or ideas else show_wanted(chat[-1].get("text", "")))
    return {"reply": found.reply.strip(), "changed": bool(steps), "restart": restart,
            "direct": bool(steps),          # whatever changes the steps is made at once: Undo is on the answer
            "show": show, "purpose": found.purpose.strip()[:300] if found.changed else "",
            "questions": [q.model_dump() for q in steps], "ideas": [q.model_dump() for q in ideas]}


# What does not belong inside a call's steps: it closes by itself, and its greeting is already written.
_CLOSING = re.compile(r"\b(good ?bye|bye|have a (great|good|nice|wonderful|lovely)\b|take care|thank(s| you)\b[^.?!]{0,30}\b(time|calling|speaking|talking|help|joining)|talk (to you )?soon|see you|that is all|that's all|all for now)", re.I)
# A call to someone the business already knows (to confirm, remind, follow up...) never asks who they are.
_KNOWN_CALLER = re.compile(r"\b(confirm\w*|remind\w*|follow(ing)?[- ]?up|feedback|survey|renew\w*|re-?schedul\w*|verif\w*|check(ing)?[- ]?in|thank\w*|cancel\w*)\b", re.I)
_IDENTITY = re.compile(
    r"\bnames?\b|\bwhose\b|\b(booked|reserved|registered|made|placed) (under|by|in)\b|\bunder (what|which|whose)\b"
    r"|\bwho (made|booked|reserved|placed|am i|are you|is this|is speaking)\b|\bspeaking (with|to)\b"
    r"|\b(phone|mobile|cell|contact) (number|no)\b|\b(best|right|good) (number|way)\b|\b(reach|contact|call) you (on|at)\b|\be-?mail\b|\bmay i (know|have|get) (your|a)\b", re.I)


def _asks_who(purpose: str, step: Question) -> bool:
    """A question that asks the customer for what the call already has (name, number, email), in a call whose
    purpose is to confirm, remind or follow up with someone known."""
    return step.kind == "ask" and bool(_KNOWN_CALLER.search(purpose or "")) and bool(_IDENTITY.search(step.ask or ""))


_GREETING = re.compile(r"^\s*(hi|hello|hey|good (morning|afternoon|evening))\b|\bthis is \w+ (calling|from)\b", re.I)


def suggest_next(setup: BusinessSetup, after: str = "", count: int = 3) -> list[Question]:
    """A few different steps that could come straight after one step (`after` is its save_as; empty or
    "greeting" is the opening), for someone who is not sure what to ask next.

    Only what could really go there is handed back: a condition or a go-back may only point at a question
    at or before that place, and an end or a go-back with no condition is dropped.
    """
    if not setup.purpose.strip():
        return []                       # the call's purpose comes first
    steps = setup.questions
    at = next((i for i, q in enumerate(steps) if q.save_as == after), -1)
    above = {q.save_as for q in steps[:at + 1] if q.kind == "ask"}
    lines = [f"{n}. {q.kind} {q.save_as}: \"{q.ask}\"" + (f" [{q.type}]" if q.kind == "ask" else "")
             + (f" (only if {q.only_if} is {' or '.join(q.only_if_is)})" if q.only_if else "")
             for n, q in enumerate(steps, 1)]
    follows = steps[at + 1] if at + 1 < len(steps) else None
    if at >= 0:
        place = f"Right AFTER step {at + 1} ({steps[at].save_as})" + (
            f" and right BEFORE step {at + 2} ({follows.save_as}: \"{follows.ask}\")." if follows else ", at the end of the steps so far.")
    else:
        place = ("At the very START of the steps: straight after the greeting, before"
                 + (f" step 1 ({follows.save_as}: \"{follows.ask}\")." if follows else " any step.")
                 + " These are the first things the customer is asked once the greeting is over.")
    prompt = prompts.NEXT_STEP_PROMPT.format(
        business_name=setup.business_name, purpose=setup.purpose or "not said yet", language=setup.language,
        steps="\n".join(lines) or "(no steps yet)", count=count + 2, place=place)   # a couple over: some may be filtered out
    taken = {q.save_as for q in steps}
    said = {" ".join(q.ask.lower().split()) for q in steps}
    found = []
    for option in ask_ai(NextSteps, prompt, temperature=0.35).options:
        words = " ".join(option.ask.lower().split())
        if option.only_if and option.only_if not in above:
            option = option.model_copy(update={"only_if": "", "only_if_is": []})
        if option.kind in ("end", "loop") and not option.only_if:   # suggestions never end or go back on every call
            continue
        if option.kind == "loop" and option.back_to not in above:
            continue
        if option.kind in ("ask", "say") and (not words or words in said):
            continue
        if _CLOSING.search(option.ask or "") or (option.kind == "say" and _GREETING.search(option.ask or "")) or _asks_who(setup.purpose, option):
            continue                    # a sign-off, or a second hello, is never what comes next
        said.add(words)
        name = _name(option.save_as or option.ask, taken)
        taken.add(name)
        found.append(option.model_copy(update={
            "save_as": name, "x": None, "y": None, "times": min(5, max(1, option.times)),
            "options": option.options if option.type == "choice" else [],
            "back_to": option.back_to if option.kind == "loop" else "",
            "handoff": option.handoff if option.kind == "end" else False,
        }))
    return found[:count]


def rewrite_context(text: str) -> str:
    """The person's rough note about why the call is made, rewritten properly. Empty if there is nothing to go on."""
    text = text.strip()[:2000]
    if not text:
        return ""
    return ask_ai(Brief, prompts.CONTEXT_PROMPT.format(text=text), temperature=0.3).text.strip()
