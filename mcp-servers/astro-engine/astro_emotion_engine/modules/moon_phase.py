"""
Astro Engine — Moon Phase Module

Computes the current lunar phase (New, Waxing, Full, Waning) from the
Sun–Moon separation angle and emits a transient influence. For example,
Full Moon increases impulsivity and sociability, while New Moon promotes
focus and calm.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from ..ephemeris.provider import EphemerisProvider
from .base import BaseInfluenceModule

class MoonPhaseModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "moon_phase"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        if not self.ephemeris:
            return []
            
        # Calculate current positions (Transit)
        # We need Sun and Moon
        positions = self.ephemeris.calculate_positions(
            request.timestamp, 
            request.current_location,
            bodies=["sun", "moon"]
        )
        
        if "sun" not in positions or "moon" not in positions:
            return []
            
        sun_lon = positions["sun"].longitude
        moon_lon = positions["moon"].longitude
        
        # Calculate phase angle (0-360)
        phase_angle = (moon_lon - sun_lon) % 360
        
        # Determine phase name and effect
        # New Moon: 0-45 (approx)
        # Waxing: 45-135
        # Full: 135-225
        # Waning: 225-315
        # New: 315-360
        
        description = ""
        emotion_delta = {}
        bias_delta = {}
        
        if phase_angle < 45 or phase_angle >= 315:
            phase_name = "New Moon"
            emotion_delta = {"calm": 0.1, "focus": 0.1, "sociability": -0.1}
            bias_delta = {"caution_delta": 0.1}
        elif 45 <= phase_angle < 135:
            phase_name = "Waxing Moon"
            emotion_delta = {"assertiveness": 0.1, "impulsivity": 0.1}
        elif 135 <= phase_angle < 225:
            phase_name = "Full Moon"
            emotion_delta = {"anxiety": 0.1, "impulsivity": 0.2, "sociability": 0.2}
            bias_delta = {"directness_delta": 0.2}
        else: # 225 <= phase_angle < 315
            phase_name = "Waning Moon"
            emotion_delta = {"patience": 0.1, "calm": 0.1}
            bias_delta = {"reflection_delta": 0.1} # custom bias?
            
        return [InfluenceResult(
            module_id=self.module_id,
            influence_id="current_moon_phase",
            emotion_delta=emotion_delta,
            bias_delta=bias_delta,
            confidence=1.0,
            description=f"Current Moon Phase is {phase_name} ({int(phase_angle)}°)",
            evidence={"phase_angle": phase_angle, "phase_name": phase_name}
        )]
