"""
Astro Engine — Emotion Request Schema

Defines ``EmotionRequest``, the input payload for the emotion engine.
Contains subject identity, timestamp, natal profile, optional module
weights/overrides, and context hints for the computation pipeline.
"""

from datetime import datetime
from typing import Optional, List, Dict
from pydantic import BaseModel, Field
from .natal import NatalProfile, GeoLocation

class EmotionRequest(BaseModel):
    engine_version: str = "0.1.0"
    subject_id: str
    timestamp: datetime = Field(..., description="Timezone aware runtime timestamp")
    
    natal_profile: NatalProfile
    
    current_location: Optional[GeoLocation] = None
    
    # Configuration Overrides
    enabled_modules: Optional[List[str]] = None
    module_weights: Optional[Dict[str, float]] = None
    
    # Context
    context_hints: Optional[Dict[str, str]] = None
    random_seed: Optional[int] = None
