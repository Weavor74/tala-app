"""
Astro Engine — Emotion Response Schema

Output models from the emotion engine:
  - ``PromptInjection`` — System/style/safety fragments injected into the LLM prompt.
  - ``DebugTrace``      — Diagnostic logs and step-level timing data.
  - ``EmotionResponse`` — Complete result with emotion vector, bias modifiers,
    prompt injection, influence trail, and optional debug info.
"""

from datetime import datetime
from typing import Dict, List, Optional
from pydantic import BaseModel
from .influences import InfluenceResult

class PromptInjection(BaseModel):
    system_fragment: str
    style_fragment: str
    safety_fragment: Optional[str] = None
    token_budget: int = 100

class DebugTrace(BaseModel):
    logs: List[str]
    step_timings: Dict[str, float]

class EmotionResponse(BaseModel):
    subject_id: str
    timestamp: datetime
    engine_version: str
    
    emotion_vector: Dict[str, float]
    internal_vector: Optional[Dict[str, float]] = None
    mood_label: str = "Neutral"
    bias_modifiers: Dict[str, float]
    
    prompt_injection: PromptInjection
    
    influences: List[InfluenceResult]
    debug_trace: Optional[DebugTrace] = None
