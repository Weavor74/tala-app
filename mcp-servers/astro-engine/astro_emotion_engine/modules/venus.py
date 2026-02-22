"""
Astro Engine — Venus Module

Analyses Venus' natal element (values/love style) and current transits,
including retrograde detection and aspects to natal Sun/Venus/Moon.
Soft aspects increase sociability and warmth; hard aspects create social
tension. Venus retrograde triggers re-evaluation of relationships.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL, SignMetadata
from ..services.aspect_engine import AspectEngine

class VenusModule(BaseInfluenceModule):
    @property
    def module_id(self) -> str:
        return "venus"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        # 1. Natal Analysis (Values/Love Style)
        # Check Natal Element
        if request.natal_profile.placements.get("venus"):
            n_venus = request.natal_profile.placements["venus"]
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == n_venus.sign), None)
            if sign_meta:
                influences.append(self._analyze_natal_element(sign_meta, n_venus))

        # 2. Transit Analysis (Retrograde + Aspects)
        if self.ephemeris:
            transits = self.ephemeris.calculate_positions(
                request.timestamp,
                request.current_location,
                bodies=["venus"]
            )
            t_venus = transits.get("venus")
            
            if t_venus:
                # Retrograde
                if t_venus.retrograde:
                    influences.append(InfluenceResult(
                        module_id=self.module_id,
                        influence_id="transit_venus_retrograde",
                        emotion_delta={"sociability": -0.1, "empathy": 0.2}, # Internalized feeling
                        bias_delta={"warmth_delta": -0.1, "reflection_delta": 0.2}, # custom bias
                        confidence=1.0, 
                        duration_tier="background", # Weeks duration
                        strength=3.0,
                        description="Venus Retrograde (Re-evaluating values/relationships)",
                        evidence={"retrograde": True}
                    ))
                    
                # Aspects to Natal Planets (Values triggers)
                # Targets: Sun (Ego), Venus (Values), Moon (Feelings)
                targets = ["sun", "venus", "moon"]
                for tid in targets:
                    n_point = request.natal_profile.placements.get(tid)
                    if n_point:
                        match = AspectEngine.calculate_aspect(t_venus, n_point)
                        if match:
                            aspect, diff = match
                            strength = AspectEngine.get_aspect_strength(diff, 5.0)
                            
                            emotion_d = {}
                            if aspect.id in ["conjunction", "trine", "sextile"]:
                                emotion_d = {"sociability": 0.2, "warmth_delta": 0.2, "lust": 0.15} 
                            elif aspect.id in ["square", "opposition"]:
                                emotion_d = {"sociability": -0.1, "anxiety": 0.1, "lust": 0.1}
                                
                            influences.append(InfluenceResult(
                                module_id=self.module_id,
                                influence_id=f"transit_venus_{aspect.id}_{tid}",
                                emotion_delta=emotion_d,
                                bias_delta={"warmth_delta": 0.1 if "sociability" in emotion_d and emotion_d["sociability"] > 0 else -0.1},
                                confidence=strength,
                                duration_tier="acute",
                                strength=strength * 5.0, # Not as intense as Mars
                                description=f"Transit Venus {aspect.id} Natal {n_point.name}",
                                evidence={"aspect": aspect.id, "orb": diff}
                            ))
                            
        return influences

    def _analyze_natal_element(self, sign_meta: SignMetadata, natal_point) -> InfluenceResult:
        bias_delta = {}
        desc = ""
        
        if sign_meta.element == "Fire":
            bias_delta = {"directness_delta": 0.1, "warmth_delta": 0.2, "lust": 0.2}
            desc = "Natal Venus in Fire (Passionate/Primal Values)"
        elif sign_meta.element == "Earth":
            bias_delta = {"caution_delta": 0.1, "warmth_delta": 0.1, "lust": 0.1}
            desc = "Natal Venus in Earth (Sensual/Secure Values)"
        elif sign_meta.element == "Air":
            bias_delta = {"sociability": 0.2, "curiosity_delta": 0.2} 
            desc = "Natal Venus in Air (Social/Intellectual Values)"
        elif sign_meta.element == "Water":
            bias_delta = {"warmth_delta": 0.3, "empathy": 0.2, "lust": 0.15}
            desc = "Natal Venus in Water (Deeply Emotional/Primal Values)"
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"natal_venus_{sign_meta.element.lower()}",
            emotion_delta={},
            bias_delta=bias_delta,
            confidence=0.8,
            duration_tier="background",
            strength=2.0,
            description=desc,
            evidence={"element": sign_meta.element}
        )
