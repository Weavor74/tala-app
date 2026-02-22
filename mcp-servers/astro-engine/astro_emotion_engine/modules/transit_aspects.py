"""
Astro Engine — Transit Aspects Module

General-purpose transit-to-natal aspect calculator. Iterates over all
transiting bodies × all natal placements, checks angular separation
against the canonical orb table, and emits influences for every match.
Hard aspects (square/opposition) produce tension; soft aspects
(trine/sextile) produce flow. Confidence decays linearly with orb.
"""

from typing import List, Dict, Tuple
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from ..ephemeris.provider import EphemerisProvider
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL

class TransitAspectsModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "transit_aspects"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        if not self.ephemeris:
            return []
            
        transits = self.ephemeris.calculate_positions(
            request.timestamp, 
            request.current_location
        )
        
        natal_placements = request.natal_profile.placements
        
        influences = []
        
        # Check Aspects
        for t_id, t_point in transits.items():
            if t_id not in ["sun", "moon", "mercury", "venus", "mars", "saturn", "uranus", "neptune", "pluto", "chiron"]:
                continue # Limit transiting bodies for MVP
                
            for n_id, n_point in natal_placements.items():
                
                # Calculate separation
                angle = abs(t_point.longitude - n_point.longitude)
                angle = angle % 360
                if angle > 180:
                    angle = 360 - angle
                    
                # Check against aspects
                match = self._check_aspect(angle, t_id, n_id)
                if match:
                    aspect_def, orb = match
                    influences.append(self._create_influence(
                        t_point, n_point, aspect_def, angle, orb
                    ))
                    
        return influences

    def _check_aspect(self, angle: float, body1: str, body2: str) -> getattr(tuple, "opts", None):
        # Retrieve orbs from config
        # Simplified orb logic: Base Orb * Multiplier
        
        for aspect in CANONICAL_DOMAIN_MODEL.aspects:
            base_orb = CANONICAL_DOMAIN_MODEL.default_orbs.get(aspect.id, 5.0)
            
            # Apply multipliers (taking the max of the two bodies is a common rule, or both)
            m1 = CANONICAL_DOMAIN_MODEL.body_orb_multipliers.get(body1, 1.0)
            m2 = CANONICAL_DOMAIN_MODEL.body_orb_multipliers.get(body2, 1.0)
            avg_multiplier = (m1 + m2) / 2 # Simple average
            
            orb_limit = base_orb * avg_multiplier
            
            if abs(angle - aspect.angle_degrees) <= orb_limit:
                return aspect, abs(angle - aspect.angle_degrees)
        
        return None

    def _create_influence(self, t_point, n_point, aspect, angle, orb) -> InfluenceResult:
        # Determine effects based on aspect nature
        # Hard aspects (Square, Opposition) -> Tension, Energy
        # Soft aspects (Trine, Sextile) -> Flow, Ease
        # Conjunction -> Variable (Intense)
        
        emotion_delta = {}
        bias_delta = {}
        
        if aspect.id in ["square", "opposition"]:
            emotion_delta = {"anxiety": 0.1, "impulsivity": 0.1, "patience": -0.1}
            bias_delta = {"caution_delta": 0.1}
        elif aspect.id in ["trine", "sextile"]:
            emotion_delta = {"calm": 0.1, "confidence": 0.1}
            bias_delta = {"warmth_delta": 0.1}
        elif aspect.id == "conjunction":
            emotion_delta = {"focus": 0.2, "assertiveness": 0.1}
        
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"transit_{t_point.id}_{aspect.id}_natal_{n_point.id}",
            emotion_delta=emotion_delta,
            bias_delta=bias_delta,
            confidence=1.0 - (orb / 10.0), # Decaying confidence with orb
            description=f"Transit {t_point.name} {aspect.id} Natal {n_point.name} ({orb:.1f}° orb)",
            evidence={
                "transit": t_point.id, "natal": n_point.id, 
                "aspect": aspect.id, "angle": angle, "orb": orb
            }
        )
