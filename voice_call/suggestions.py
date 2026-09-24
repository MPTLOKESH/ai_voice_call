"""Asking the AI for questions that suit a business's purpose."""
from __future__ import annotations

from pydantic import BaseModel

from . import prompts
from .gemini import ask_ai
from .models import BusinessSetup, Question


class Suggestions(BaseModel):
    questions: list[Question]


def suggest_questions(setup: BusinessSetup) -> list[Question]:
    prompt = prompts.SUGGEST_QUESTIONS_PROMPT.format(
        business_name=setup.business_name, purpose=setup.purpose, language=setup.language,
        business_info="; ".join(setup.business_info) or "none")
    return ask_ai(Suggestions, prompt, temperature=0.4).questions
