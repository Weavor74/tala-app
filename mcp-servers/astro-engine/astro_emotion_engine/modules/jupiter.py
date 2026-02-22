"""
Astro Engine — Jupiter Module

Analyses Jupiter's natal element (growth style) and current transits.
Soft aspects boost confidence and optimism; hard aspects trigger
over-expansion and risk-taking. Jupiter retrograde signals a period
of internalised growth and reflection.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL, SignMetadata
from ..services.aspect_engine import AspectEngine

class JupiterModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "jupiter"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        # 1. Natal Analysis
        n_jupiter = request.natal_profile.placements.get("jupiter")
        if n_jupiter:
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == n_jupiter.sign), None)
            if sign_meta:
                 influences.append(self._analyze_natal_element(sign_meta, n_jupiter))

        # 2. Transit Analysis
        if self.ephemeris:
            transits = self.ephemeris.calculate_positions(
                request.timestamp,
                request.current_location,
                bodies=["jupiter"]
            )
            t_jupiter = transits.get("jupiter")
            
            if t_jupiter and request.natal_profile.placements:
                
                # Jupiter Retrograde (Internal Growth)
                if t_jupiter.retrograde:
                    influences.append(InfluenceResult(
                        module_id=self.module_id,
                        influence_id="transit_jupiter_retrograde",
                        emotion_delta={"patience": 0.1, "reflection_delta": 0.2}, # Internal expansion
                        bias_delta={},
                        confidence=1.0,
                        duration_tier="background",
                        strength=2.0,
                        description="Jupiter Retrograde (Internalizing Growth)",
                        evidence={"retrograde": True}
                    ))

                # Aspects to Sun/Moon/Jupiter (Expansion triggers)
                targets = ["sun", "moon", "jupiter"]
                for tid in targets:
                    n_point = request.natal_profile.placements.get(tid)
                    if n_point:
                        match = AspectEngine.calculate_aspect(t_jupiter, n_point)
                        if match:
                            aspect, diff = match
                            strength = AspectEngine.get_aspect_strength(diff, 6.0) # Larger orb for Jupiter
                            
                            emotion_d = {}
                            if aspect.id in ["conjunction", "trine", "sextile"]:
                                emotion_d = {"confidence": 0.3, "optimism_delta": 0.3, "risk_tolerance": 0.2}
                            elif aspect.id in ["square", "opposition"]:
                                emotion_d = {"impulsivity": 0.2, "risk_tolerance": 0.3} # Over-expansion
                                
                            influences.append(InfluenceResult(
                                module_id=self.module_id,
                                influence_id=f"transit_jupiter_{aspect.id}_{tid}",
                                emotion_delta=emotion_d,
                                bias_delta={}, 
                                confidence=strength,
                                duration_tier="acute" if diff < 1.0 else "background", # Acute if exact
                                strength=strength * 6.0,
                                description=f"Transit Jupiter {aspect.id} Natal {n_point.name}",
                                evidence={"aspect": aspect.id, "orb": diff}
                            ))
        
        return influences

    def _analyze_natal_element(self, sign_meta: SignMetadata, natal_point) -> InfluenceResult:
        emotion_delta = {}
        desc = ""
        
        if sign_meta.element == "Fire":
            emotion_delta = {"confidence": 0.2, "risk_tolerance": 0.2}
            desc = "Natal Jupiter in Fire (Bold Growth)"
        elif sign_meta.element == "Earth":
            emotion_delta = {"patience": 0.1, "focus": 0.1}
            desc = "Natal Jupiter in Earth (Tangible Growth)"
        elif sign_meta.element == "Air":
            emotion_delta = {"sociability": 0.2, "curiosity_delta": 0.2}
            desc = "Natal Jupiter in Air (Intellectual Expansion)"
        elif sign_meta.element == "Water":
            emotion_delta = {"empathy": 0.2, "intuition_delta": 0.2}
            desc = "Natal Jupiter in Water (Emotional/Spiritual Growth)"
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_jupiter_{sign_meta.element.lower()}",
            emotion_delta=emotion_delta,
            bias_delta={},
            confidence=0.8,
            duration_tier="background",
            strength=2.0,
            description=desc,
            evidence={"element": sign_meta.element}
        )
