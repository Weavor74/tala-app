"""
Astro Engine — Mars Module

Analyses Mars' natal element (drive style) and current transit aspects
to natal Sun, Mars, and Ascendant. Hard aspects (conjunction, square,
opposition) produce impulsivity and assertiveness spikes, reflecting
Mars' role as the planet of action and conflict.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL, SignMetadata
from ..services.aspect_engine import AspectEngine

class MarsModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "mars"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        # 1. Natal Analysis
        natal_mars = request.natal_profile.placements.get("mars")
        if natal_mars:
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == natal_mars.sign), None)
            if sign_meta:
                 influences.append(self._analyze_natal_element(sign_meta, natal_mars))

        # 2. Transit Analysis (Mars Aspects)
        if self.ephemeris:
            transits = self.ephemeris.calculate_positions(
                request.timestamp,
                request.current_location,
                bodies=["mars"]
            )
            t_mars = transits.get("mars")
            
            if t_mars and request.natal_profile.placements:
                # Check for Aspect to Natal Sun (Energy) or Natal Mars (Drive)
                targets = ["sun", "mars", "asc"]
                for tid in targets:
                    n_point = request.natal_profile.placements.get(tid)
                    if n_point:
                        match = AspectEngine.calculate_aspect(t_mars, n_point)
                        if match:
                            aspect, diff = match
                            # Filter for hard aspects for Mars impact
                            if aspect.id in ["conjunction", "square", "opposition"]:
                                influences.append(InfluenceResult(
                                    module_id=self.module_id,
                                    influence_id=f"transit_mars_{aspect.id}_{tid}",
                                    emotion_delta={
                                        "impulsivity": 0.3, 
                                        "assertiveness": 0.2, 
                                        "anger": 0.3 if aspect.id != "conjunction" else 0.1,
                                        "lust": 0.2 if tid in ["venus", "sun"] else 0.0
                                    },
                                    bias_delta={"directness_delta": 0.3},
                                    confidence=AspectEngine.get_aspect_strength(diff, 5.0), # Simplification
                                    duration_tier="acute",
                                    strength=AspectEngine.get_aspect_strength(diff, 5.0) * 10,
                                    description=f"Transit Mars {aspect.id} Natal {n_point.name}",
                                    evidence={"aspect": aspect.id, "orb": diff}
                                ))
        
        return influences

    def _analyze_natal_element(self, sign_meta: SignMetadata, natal_point) -> InfluenceResult:
        emotion_delta = {}
        bias_delta = {}
        desc = ""
        
        if sign_meta.element == "Fire":
            emotion_delta = {"impulsivity": 0.2, "risk_tolerance": 0.2, "assertiveness": 0.2, "lust": 0.1}
            desc = "Natal Mars in Fire (High Drive/Passion)"
        elif sign_meta.element == "Earth":
            emotion_delta = {"patience": 0.1, "focus": 0.2, "assertiveness": 0.1}
            desc = "Natal Mars in Earth (Steady Drive)"
        elif sign_meta.element == "Air":
            emotion_delta = {"sociability": 0.1}
            bias_delta = {"directness_delta": 0.1}
            desc = "Natal Mars in Air (Intellectual Drive)"
        elif sign_meta.element == "Water":
            emotion_delta = {"empathy": 0.1, "impulsivity": 0.1} # Emotional driven
            desc = "Natal Mars in Water (Emotional Drive)"
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_mars_{sign_meta.element.lower()}",
            emotion_delta=emotion_delta,
            bias_delta=bias_delta,
            confidence=0.8,
            description=desc,
            evidence={"natal_sign": natal_point.sign, "element": sign_meta.element}
        )
