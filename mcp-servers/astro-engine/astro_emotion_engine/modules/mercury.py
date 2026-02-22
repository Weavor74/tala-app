"""
Astro Engine — Mercury Module

Analyses Mercury's natal element (communication style) and current transit
status (retrograde detection). Mercury retrograde increases caution and
patience while reducing focus, reflecting the classic "communication
disruption" archetype.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL, SignMetadata
from ..services.house_engine import HouseEngine

class MercuryModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "mercury"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        # 1. Natal Analysis
        natal_mercury = request.natal_profile.placements.get("mercury")
        if natal_mercury:
            # Element Analysis
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == natal_mercury.sign), None)
            if sign_meta:
                 influences.append(self._analyze_natal_element(sign_meta, natal_mercury))
            
            # House Analysis (New Phase 3)
            # Check which house Natal Mercury is in (using profile data usually, but we can verify)
            # For now, just trust the placement object if it has house data
            pass 

        # 2. Transit Analysis (Retrograde + House)
        if self.ephemeris:
            transits = self.ephemeris.calculate_positions(
                request.timestamp,
                request.current_location,
                bodies=["mercury"]
            )
            
            t_mercury = transits.get("mercury")
            if t_mercury:
                # Retrograde Check
                if t_mercury.retrograde:
                    influences.append(InfluenceResult(
                        module_id=self.module_id,
                        influence_id="transit_mercury_retrograde",
                        emotion_delta={"patience": 0.2, "focus": -0.1, "anxiety": 0.1},
                        bias_delta={"caution_delta": 0.3, "verbosity_delta": -0.1},
                        confidence=1.0,
                        duration_tier="acute",
                        strength=1.5,
                        description="Mercury is currently Retrograde",
                        evidence={"speed": t_mercury.speed, "is_retrograde": True}
                    ))
                
                # House Transit Check
                # If we have house data in request (requires location)
                if request.natal_profile.houses:
                    house_num, dist = HouseEngine.get_house_for_longitude(t_mercury.longitude, request.natal_profile.houses)
                    # We could emit a "Mercury in X House" signal here
                    # But maybe that belongs in a generic House Module?
                    # The prompt asked for "House Module" separately.
                    # However, specific planet-in-house logic (Mercury in 3rd vs Mars in 3rd) is domain specific.
                    # Let's keep it simple for now and leave generic house transits to the House Module.
                    pass
                
        return influences

    def _analyze_natal_element(self, sign_meta: SignMetadata, natal_point) -> InfluenceResult:
        # Baseline communication style based on element
        emotion_delta = {}
        bias_delta = {}
        desc = ""
        
        if sign_meta.element == "Fire":
            bias_delta = {"directness_delta": 0.2, "verbosity_delta": 0.1}
            desc = "Natal Mercury in Fire (Direct, Spontaneous)"
        elif sign_meta.element == "Earth":
            bias_delta = {"caution_delta": 0.1, "formality_delta": 0.1}
            desc = "Natal Mercury in Earth (Practical, Methodical)"
        elif sign_meta.element == "Air":
            bias_delta = {"curiosity_delta": 0.2, "verbosity_delta": 0.2}
            desc = "Natal Mercury in Air (Curious, Talkative)"
        elif sign_meta.element == "Water":
            emotion_delta = {"empathy": 0.1}
            bias_delta = {"warmth_delta": 0.1, "directness_delta": -0.1}
            desc = "Natal Mercury in Water (Intuitive, Reflective)"
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_mercury_{sign_meta.element.lower()}",
            emotion_delta=emotion_delta,
            bias_delta=bias_delta,
            confidence=0.8, # Static baseline
            description=desc,
            evidence={"natal_sign": natal_point.sign, "element": sign_meta.element}
        )
