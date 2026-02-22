"""
Astro Engine — Transit Volatility Module

Analyses transit-to-transit aspects (cosmic weather) that affect everyone
equally — the "mood of the day." Focus on fast-moving mutual aspects:
  - Moon–Mars  — Energy spikes / irritability.
  - Moon–Venus — Harmony / softness.
  - Venus–Mars — Attraction / desire energy.
  - Mercury–Mars — Mental agitation or sharpness.

All influences are ``duration_tier="transient"`` (hours to days).
"""

from typing import List
from datetime import datetime
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..services.aspect_engine import AspectEngine

class TransitVolatilityModule(BaseInfluenceModule):
    """
    Phase 6C: Transit-to-transit aspects (cosmic weather).
    
    These are current aspects between transiting planets themselves,
    not related to the natal chart. They represent general energy
    that affects everyone equally - the "mood of the day."
    
    Focus on fast-moving aspects that create short-term volatility:
    - Moon aspects (hours duration)
    - Mercury/Venus/Mars mutual aspects (days duration)
    
    Example: Moon conjunct Mars = extra energy/irritability for everyone today
    """
    
    @property
    def module_id(self) -> str:
        return "transit_volatility"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        if not self.ephemeris:
            return influences
        
        # Calculate current positions
        current_time = request.timestamp
        location = request.natal_profile.birth_location if request.natal_profile else None
        
        # Get fast-moving bodies for volatility
        bodies = ["moon", "mercury", "venus", "mars"]
        positions = self.ephemeris.calculate_positions(current_time, location, bodies=bodies)
        
        # Check high-impact transit-to-transit aspects
        
        # 1. Moon-Mars: Energy spikes, irritability
        if "moon" in positions and "mars" in positions:
            aspect_result = AspectEngine.calculate_aspect(positions["moon"], positions["mars"])
            if aspect_result:
                aspect_meta, orb = aspect_result
                if orb < 3.0:  # Tight orb for transit-to-transit
                    influences.append(self._moon_mars_transit(aspect_meta, orb))
        
        # 2. Moon-Venus: Softness, harmony
        if "moon" in positions and "venus" in positions:
            aspect_result = AspectEngine.calculate_aspect(positions["moon"], positions["venus"])
            if aspect_result:
                aspect_meta, orb = aspect_result
                if orb < 3.0:
                    influences.append(self._moon_venus_transit(aspect_meta, orb))
        
        # 3. Venus-Mars: Attraction/desire energy
        if "venus" in positions and "mars" in positions:
            aspect_result = AspectEngine.calculate_aspect(positions["venus"], positions["mars"])
            if aspect_result:
                aspect_meta, orb = aspect_result
                if orb < 2.0:  # Even tighter for slower planets
                    influences.append(self._venus_mars_transit(aspect_meta, orb))
        
        # 4. Mercury-Mars: Mental agitation or focus
        if "mercury" in positions and "mars" in positions:
            aspect_result = AspectEngine.calculate_aspect(positions["mercury"], positions["mars"])
            if aspect_result:
                aspect_meta, orb = aspect_result
                if orb < 2.0:
                    influences.append(self._mercury_mars_transit(aspect_meta, orb))
        
        return influences
    
    def _moon_mars_transit(self, aspect_meta, orb) -> InfluenceResult:
        """Transit Moon-Mars: Energy spikes, potential irritability"""
        aspect_name = aspect_meta.id
        
        if aspect_name in ["conjunction", "square"]:
            emotion_d = {"impulsivity": 0.15, "assertiveness": 0.15}
            desc = f"Transit Moon {aspect_name} Mars (Energetic/reactive day)"
        else:
            emotion_d = {"assertiveness": 0.1}
            desc = f"Transit Moon {aspect_name} Mars (Energized day)"
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"transit_moon_mars_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta={},
            confidence=0.6,  # Lower than natal - general energy
            duration_tier="transient",  # Hours
            strength=1.5,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb, "type": "transit-to-transit"}
        )
    
    def _moon_venus_transit(self, aspect_meta, orb) -> InfluenceResult:
        """Transit Moon-Venus: Harmony, softness"""
        aspect_name = aspect_meta.id
        
        emotion_d = {"empathy": 0.1}
        bias_d = {"warmth_delta": 0.15}
        desc = f"Transit Moon {aspect_name} Venus (Harmonious/soft day)"
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"transit_moon_venus_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.6,
            duration_tier="transient",
            strength=1.5,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb, "type": "transit-to-transit"}
        )
    
    def _venus_mars_transit(self, aspect_meta, orb) -> InfluenceResult:
        """Transit Venus-Mars: Attraction/desire energy"""
        aspect_name = aspect_meta.id
        
        if aspect_name == "conjunction":
            emotion_d = {"assertiveness": 0.2, "sociability": 0.15}
            desc = f"Transit Venus-Mars conjunction (High attraction/desire energy)"
            strength = 2.0
        else:
            emotion_d = {"assertiveness": 0.1, "sociability": 0.1}
            desc = f"Transit Venus {aspect_name} Mars (Attraction energy)"
            strength = 1.5
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"transit_venus_mars_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta={},
            confidence=0.5,  # General energy for everyone
            duration_tier="transient",
            strength=strength,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb, "type": "transit-to-transit"}
        )
    
    def _mercury_mars_transit(self, aspect_meta, orb) -> InfluenceResult:
        """Transit Mercury-Mars: Mental energy/agitation"""
        aspect_name = aspect_meta.id
        
        if aspect_name in ["conjunction", "square"]:
            emotion_d = {"focus": 0.15, "impulsivity": 0.1}
            desc = f"Transit Mercury {aspect_name} Mars (Sharp/quick thinking)"
        else:
            emotion_d = {"focus": 0.15}
            desc = f"Transit Mercury {aspect_name} Mars (Mental energy)"
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"transit_mercury_mars_{aspect_name}",
            emotion_delta=emotion_d,
            bias_delta={},
            confidence=0.5,
            duration_tier="transient",
            strength=1.5,
            description=desc,
            evidence={"aspect": aspect_name, "orb": orb, "type": "transit-to-transit"}
        )
