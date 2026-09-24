"""A voice assistant that calls customers, asks a business's questions, and saves the answers.

    voice_call.settings     models, limits, paths
    voice_call.gemini       typed requests, retries, model fallback
    voice_call.models       BusinessSetup, Question, Call
    voice_call.prompts      everything the AI is told
    voice_call.engine       think · keep_answers · next_step · one turn
    voice_call.speech       speech in and out
    voice_call.storage      the setup, and finished calls
    voice_call.server       the browser UI
"""
from .models import BusinessSetup, Call, Question

__all__ = ["BusinessSetup", "Call", "Question"]
