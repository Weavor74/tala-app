"""
Astro Engine — Natal Aspects Module

Analyses permanent natal-to-natal aspects that define emotional wiring:
  - Moon–Saturn  — Emotional restraint / maturity
  - Moon–Venus   — Warmth / affection capacity
  - Moon–Mars    — Emotional reactivity / drive
  - Sun–Moon     — Conscious / unconscious alignment
  - Venus–Mars   — Attraction / drive integration
  - Mercury–Saturn — Mental discipline / caution

All influences are ``duration_tier="background"`` (lifetime patterns).
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..services.aspect_engine import AspectEngine

class NatalAspectsModule(BaseInfluenceModule):
    """
    Phase 6B: Natal-to-natal aspects (baseline emotional wiring).
    
    These are permanent aspects within the birth chart that define
    how different parts of the personality interact.
    """
    
    @property
    def module_id(self) -> str:
        return "natal_aspects"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        if not request.natal_profile or not request.natal_profile.placements:
            return influences
        
        placements = request.natal_profile.placements
        
        # Check major emotional wiring aspects
        aspects_to_check = [
            ("moon", "saturn", self._moon_saturn),
            ("moon", "venus", self._moon_venus),
            ("moon", "mars", self._moon_mars),
            ("sun", "moon", self._sun_moon),
            ("venus", "mars", self._venus_mars),
            ("mercury", "saturn", self._mercury_saturn),
        ]
        
        for planet_a, planet_b, handler in aspects_to_check:
            if planet_a in placements and planet_b in placements:
                aspect_result = AspectEngine.calculate_aspect(placements[planet_a], placements[planet_b])
                if aspect_result:
                    aspect_meta, orb = aspect_result
                    influences.append(handler(aspect_meta, orb))
        
        return influences
    
    def _moon_saturn(self, aspect_meta, orb) -> InfluenceResult:
        """Moon-Saturn: Emotional restraint, maturity"""
        aspect_name = aspect_meta.id
        
        if aspect_name in ["conjunction", "square", "opposition"]:
            emotion_d = {"patience": 0.25, "calm": 0.15}
            bias_d = {"caution_delta": 0.3, "formality_delta": 0.2}
            desc = f"Natal Moon {aspect_name} Saturn (Emotional restraint/maturity)"
            strength = 4.0
        else:
            emotion_d = {"patience": 0.3, "calm": 0.25}
            bias_d = {"caution_delta": 0.15}
            desc = f"Natal Moon {aspect_name} Saturn (Emotional stability/wisdom)"
            strength = 3.0
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_moon_saturn_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.9,
            duration_tier="background",
            strength=strength,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb}
        )
    
    def _moon_venus(self, aspect_meta, orb) -> InfluenceResult:
        """Moon-Venus: Emotional warmth, ease of affection"""
        aspect_name = aspect_meta.id
        if aspect_name in ["conjunction", "trine", "sextile"]:
            emotion_d = {"empathy": 0.25}
            bias_d = {"warmth_delta": 0.3}
            desc = f"Natal Moon {aspect_name} Venus (Ease of affection/warmth)"
            strength = 3.5
        else:
            emotion_d = {"empathy": 0.15}
            bias_d = {"warmth_delta": 0.15}
            desc = f"Natal Moon {aspect_name} Venus (Conflicted affection)"
            strength = 2.5
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_moon_venus_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.85,
            duration_tier="background",
            strength=strength,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb}
        )
    
    def _moon_mars(self, aspect_meta, orb) -> InfluenceResult:
        """Moon-Mars: Emotional reactivity, drive"""
        aspect_name = aspect_meta.id
        if aspect_name in ["conjunction", "square", "opposition"]:
            emotion_d = {"impulsivity": 0.3, "assertiveness": 0.2}
            bias_d = {"directness_delta": 0.2}
            desc = f"Natal Moon {aspect_name} Mars (Emotional reactivity/passion)"
            strength = 4.0
        else:
            emotion_d = {"assertiveness": 0.2}
            bias_d = {"directness_delta": 0.15}
            desc = f"Natal Moon {aspect_name} Mars (Balanced emotional drive)"
            strength = 3.0
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_moon_mars_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.85,
            duration_tier="background",
            strength=strength,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb}
        )
    
    def _sun_moon(self, aspect_meta, orb) -> InfluenceResult:
        """Sun-Moon: Conscious/unconscious alignment"""
        aspect_name = aspect_meta.id
        if aspect_name in ["conjunction", "trine", "sextile"]:
            emotion_d = {"confidence": 0.2, "calm": 0.2}
            bias_d = {}
            desc = f"Natal Sun {aspect_name} Moon (Inner alignment)"
            strength = 3.5
        else:
            emotion_d = {"anxiety": 0.15}
            bias_d = {"caution_delta": 0.1}
            desc = f"Natal Sun {aspect_name} Moon (Inner tension/growth)"
            strength = 3.0
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_sun_moon_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.9,
            duration_tier="background",
            strength=strength,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb}
        )
    
    def _venus_mars(self, aspect_meta, orb) -> InfluenceResult:
        """Venus-Mars: Attraction/drive integration"""
        aspect_name = aspect_meta.id
        if aspect_name in ["conjunction", "trine", "sextile"]:
            emotion_d = {"assertiveness": 0.2}
            bias_d = {"warmth_delta": 0.2, "directness_delta": 0.15}
            desc = f"Natal Venus {aspect_name} Mars (Integrated attraction/drive)"
            strength = 3.0
        else:
            emotion_d = {"impulsivity": 0.2}
            bias_d = {"directness_delta": 0.2}
            desc = f"Natal Venus {aspect_name} Mars (Desire tension)"
            strength = 2.5
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_venus_mars_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.8,
            duration_tier="background",
            strength=strength,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb}
        )
    
    def _mercury_saturn(self, aspect_meta, orb) -> InfluenceResult:
        """Mercury-Saturn: Mental discipline, focus"""
        aspect_name = aspect_meta.id
        if aspect_name in ["conjunction", "square", "opposition"]:
            emotion_d = {"focus": 0.3, "patience": 0.2}
            bias_d = {"caution_delta": 0.25, "formality_delta": 0.15}
            desc = f"Natal Mercury {aspect_name} Saturn (Mental discipline/caution)"
            strength = 3.5
        else:
            emotion_d = {"focus": 0.25, "patience": 0.15}
            bias_d = {"caution_delta": 0.15}
            desc = f"Natal Mercury {aspect_name} Saturn (Structured thinking)"
            strength = 2.5
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_mercury_saturn_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.8,
            duration_tier="background",
            strength=strength,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb}
        )
