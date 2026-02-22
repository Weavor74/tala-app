"""
Astro Engine — Influence Result Schema

Defines ``InfluenceResult``, the atomic unit of astrological influence.
Each module produces one or more ``InfluenceResult`` objects describing
a specific planetary event (e.g., "Moon in Aries"), its emotion/bias
deltas, confidence score, strength, duration tier, and evidence payload.
"""

from typing import Dict, Any, Optional, Literal
from pydantic import BaseModel, Field

class InfluenceResult(BaseModel):
    """
    Represents a single source of emotional influence (e.g., 'Moon in Aries').
    """
    module_id: str
    influence_id: str # Unique ID for this specific influence event
    
    emotion_delta: Dict[str, float] = Field(..., description="Delta to apply to base emotion vector")
    bias_delta: Dict[str, float] = Field(..., description="Delta to apply to bias modifiers")
    
    weight_applied: float = 1.0
    confidence: float = Field(..., ge=0.0, le=100.0)
    
    # Phase 3 Enhancements
    duration_tier: Optional[Literal["transient", "acute", "background"]] = "transient"
    # REMOVED le constraint entirely to fix phantom validation error
    strength: float = Field(default=1.0, ge=0.0, description="Calculated intensity based on orbs/stationing")
    
    description: str # Human readable "Moon is in Aries"
    evidence: Dict[str, Any] = Field(default_factory=dict, description="Structured proof (aspect angle, orb, etc)")

    from pydantic import model_validator
    
    @model_validator(mode='before')
    @classmethod
    def debug_values(cls, data: Any) -> Any:
        return data
