"""Asking the AI for questions that suit a business's purpose."""
from __future__ import annotations

from pydantic import BaseModel

from . import prompts
from .gemini import ask_ai
from .models import BusinessSetup, Question


class Suggestions(BaseModel):
    questions: list[Question]


class Rewrites(BaseModel):
    options: list[str]


def reword(setup: BusinessSetup, text: str, kind: str = "ask", count: int = 3) -> list[str]:
    """Other ways to put one line, for a business to pick from. Anything that repeats the original is dropped."""
    text = text.strip()
    if not text:
        return []
    prompt = prompts.REWORD_PROMPT.format(
        business_name=setup.business_name, language=setup.language, text=text, purpose=setup.purpose or "not said",
        kind=" as a question" if kind == "ask" else "", count=count, words=18 if kind == "ask" else 30)
    seen, found = {_same(text)}, []
    for option in ask_ai(Rewrites, prompt, temperature=0.8).options:
        option = option.strip()
        if option and _same(option) not in seen:
            seen.add(_same(option))
            found.append(option)
    return found[:count]


def _same(text: str) -> str:
    return " ".join("".join(c for c in text.lower() if c.isalnum() or c == " ").split())


def suggest_questions(setup: BusinessSetup) -> list[Question]:
    """New questions only: the AI is told what is already asked, and anything that still repeats it is dropped."""
    prompt = prompts.SUGGEST_QUESTIONS_PROMPT.format(
        business_name=setup.business_name, purpose=setup.purpose, language=setup.language,
        business_info="; ".join(setup.business_info) or "none",
        already="; ".join(f"{q.save_as} ({q.ask})" for q in setup.questions if q.kind == "ask") or "none")
    taken_names = {q.save_as for q in setup.questions}
    taken_words = {_same(q.ask) for q in setup.questions}
    fresh = []
    for question in ask_ai(Suggestions, prompt, temperature=0.4).questions:
        if question.save_as in taken_names or _same(question.ask) in taken_words:
            continue
        taken_names.add(question.save_as)
        taken_words.add(_same(question.ask))
        fresh.append(question)
    return fresh
