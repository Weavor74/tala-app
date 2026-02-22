"""
Astro Engine — Outer Planets Module (Uranus, Neptune, Pluto)

Handles the slow-moving generational planets. Key behaviours:
  - **Stationing detection** — When speed drops below threshold, emit
    an acute high-strength influence (intense pressure).
  - **Aspects to personal planets** — Major aspects to Sun/Moon/Mercury/
    Venus/Mars produce long-duration emotional effects unique to each body.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL, SignMetadata
from ..services.aspect_engine import AspectEngine

class OuterPlanetsModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "outer_planets"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        bodies = ["uranus", "neptune", "pluto"]
        
        # 1. Natal Analysis (Generational Elements - less personal but still relevant)
        # 2. Transit Analysis (The heavy lifting)
        
        if self.ephemeris:
            transits = self.ephemeris.calculate_positions(
                request.timestamp,
                request.current_location,
                bodies=bodies
            )
            
            for body in bodies:
                t_point = transits.get(body)
                if not t_point: continue
                
                # A. Retrograde/Stationing
                # Stationing is key for outers. 
                # If speed is very low (< 10% of avg?), trigger STATION.
                # Avg speeds (approx/day): Uranus 0.04, Neptune 0.02, Pluto 0.01
                # Simplified threshold logic: abs(speed) < threshold
                thresholds = {"uranus": 0.004, "neptune": 0.002, "pluto": 0.001}
                is_stationing = abs(t_point.speed) < thresholds.get(body, 0.001)
                
                if is_stationing:
                     influences.append(InfluenceResult(
                        module_id=self.module_id,
                        influence_id=f"transit_{body}_station",
                        emotion_delta={"anxiety": 0.1, "focus": 0.2}, # Intense pressure
                        bias_delta={"intensity_delta": 0.3},
                        confidence=1.0,
                        duration_tier="acute", # Stationing is a "moment" of intensity
                        strength=8.0,
                        description=f"Transit {body.capitalize()} Stationing (Intense Pressure)",
                        evidence={"speed": t_point.speed, "is_stationing": True}
                    ))
                
                # B. Aspects to Personal Planets (Sun/Moon/Merc/Ven/Mars)
                if request.natal_profile.placements:
                    targets = ["sun", "moon", "mercury", "venus", "mars"]
                    for tid in targets:
                        n_point = request.natal_profile.placements.get(tid)
                        if n_point:
                            match = AspectEngine.calculate_aspect(t_point, n_point)
                            if match:
                                aspect, diff = match
                                # Only care about Major aspects for Outers usually
                                if aspect.category == "major":
                                    # Strength logic
                                    # 1 degree orb is ACUTE/High Strength
                                    # 3 degree orb is BACKGROUND/Medium Strength
                                    
                                    tier = "acute" if diff < 1.0 else "background"
                                    strength_base = AspectEngine.get_aspect_strength(diff, 5.0) # 5 deg max for outers?
                                    
                                    # Flavors
                                    desc = f"Transit {body.capitalize()} {aspect.id} Natal {n_point.name}"
                                    em_delta = {}
                                    bias_delta = {}
                                    
                                    if body == "uranus":
                                        em_delta = {"impulsivity": 0.2, "anxiety": 0.2, "fear": 0.1}
                                        bias_delta = {"spontaneity_delta": 0.2}
                                    elif body == "neptune":
                                        em_delta = {"focus": -0.2, "empathy": 0.2, "fear": 0.1} # Confusion/Paranoia
                                        bias_delta = {"clarity_delta": -0.2}
                                    elif body == "pluto":
                                        em_delta = {"anxiety": 0.1, "focus": 0.3, "fear": 0.3} # Obsession/Fear
                                        bias_delta = {"intensity_delta": 0.4}
                                        
                                    influences.append(InfluenceResult(
                                        module_id=self.module_id,
                                        influence_id=f"transit_{body}_{aspect.id}_{tid}",
                                        emotion_delta=em_delta,
                                        bias_delta=bias_delta,
                                        confidence=strength_base,
                                        duration_tier=tier,
                                        strength=strength_base * (10.0 if tier=="acute" else 4.0),
                                        description=desc,
                                        evidence={"aspect": aspect.id, "orb": diff}
                                    ))

        return influences
