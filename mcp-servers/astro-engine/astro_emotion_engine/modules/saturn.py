"""
Astro Engine — Saturn Module

Analyses Saturn's natal element (discipline/restriction style) and
current transit retrograde status. Saturn retrograde mildly increases
focus and caution, reflecting its role as the planet of structure
and boundaries.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL, SignMetadata

class SaturnModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "saturn"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        # 1. Natal Analysis
        natal_saturn = request.natal_profile.placements.get("saturn")
        if natal_saturn:
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == natal_saturn.sign), None)
            if sign_meta:
                 influences.append(self._analyze_natal_element(sign_meta, natal_saturn))

        # 2. Transit Analysis (Saturn Retrograde check - optional, usually less impact than Mercury)
        if self.ephemeris:
            transits = self.ephemeris.calculate_positions(
                request.timestamp,
                request.current_location,
                bodies=["saturn"]
            )
            t_saturn = transits.get("saturn")
            if t_saturn and t_saturn.retrograde:
                influences.append(InfluenceResult(
                    module_id=self.module_id,
                    influence_id="transit_saturn_retrograde",
                    emotion_delta={"focus": 0.1, "patience": 0.1},
                    bias_delta={"caution_delta": 0.2},
                    confidence=0.5, # Less intense than Mercury Rx
                    description="Saturn is currently Retrograde",
                    evidence={"is_retrograde": True}
                ))
                
                # Aspects to personal planets
                influences.extend(self._analyze_transit_aspects(request, t_saturn))

        return influences

    def _analyze_natal_element(self, sign_meta: SignMetadata, natal_point) -> InfluenceResult:
        emotion_delta = {}
        bias_delta = {}
        desc = ""
        
        # Saturn in elements typically modifies 'restriction' or 'duty' style
        if sign_meta.element == "Fire":
            emotion_delta = {"impulsivity": -0.1, "focus": 0.1}
            desc = "Natal Saturn in Fire (Disciplined Action)"
        elif sign_meta.element == "Earth":
            emotion_delta = {"patience": 0.3, "focus": 0.2}
            bias_delta = {"caution_delta": 0.1}
            desc = "Natal Saturn in Earth (Strong Structure)"
        elif sign_meta.element == "Air":
            emotion_delta = {"patience": 0.1}
            bias_delta = {"formality_delta": 0.1}
            desc = "Natal Saturn in Air (Intellectual Discipline)"
        elif sign_meta.element == "Water":
            emotion_delta = {"empathy": 0.1, "anxiety": 0.1, "fear": 0.15}
            bias_delta = {"warmth_delta": -0.1}
            desc = "Natal Saturn in Water (Emotional Boundaries/Deep Fears)"
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_saturn_{sign_meta.element.lower()}",
            emotion_delta=emotion_delta,
            bias_delta=bias_delta,
            confidence=0.8,
            description=desc,
            evidence={"natal_sign": natal_point.sign, "element": sign_meta.element}
        )

    def _analyze_transit_aspects(self, request: EmotionRequest, t_saturn) -> List[InfluenceResult]:
        from ..services.aspect_engine import AspectEngine
        influences = []
        if not request.natal_profile.placements:
             return influences

        targets = ["sun", "moon", "mars"]
        for tid in targets:
            n_point = request.natal_profile.placements.get(tid)
            if n_point:
                match = AspectEngine.calculate_aspect(t_saturn, n_point)
                if match:
                    aspect, diff = match
                    if aspect.id in ["conjunction", "square", "opposition"]:
                        influences.append(InfluenceResult(
                            module_id=self.module_id,
                            influence_id=f"transit_saturn_{aspect.id}_{tid}",
                            emotion_delta={"fear": 0.3, "anxiety": 0.2, "patience": -0.2},
                            bias_delta={"caution_delta": 0.3, "intensity_delta": 0.1},
                            confidence=AspectEngine.get_aspect_strength(diff, 5.0),
                            duration_tier="background", # Saturn transits are long
                            strength=5.0,
                            description=f"Transit Saturn {aspect.id} Natal {n_point.name} (Heavy Reality Check)",
                            evidence={"aspect": aspect.id, "orb": diff}
                        ))
        return influences
