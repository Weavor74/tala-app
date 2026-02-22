"""
Astro Engine — Natal Baseline Module

Computes the static emotional baseline from the big three placements:
  - **Sun sign**  — Conscious identity, ego drive, element-based bias modifiers.
  - **Moon sign** — Emotional processing style, element + modality flavoring.
  - **Ascendant** — Interface with the world, presentation style.

These influences are ``duration_tier="background"`` and never change for a given chart.
"""

from typing import List
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from .base import BaseInfluenceModule
from ..config import CANONICAL_DOMAIN_MODEL, SignMetadata

class NatalBaselineModule(BaseInfluenceModule):
    """
    Phase 6B: Expanded to include Moon sign baseline.
    
    Sun = Conscious identity, ego drive
    Moon = Emotional nature, processing style
    """
    
    @property
    def module_id(self) -> str:
        return "natal_baseline"

    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        influences = []
        
        if not request.natal_profile or not request.natal_profile.placements:
            return influences
        
        # 1. Sun Sign Baseline (Original MVP)
        sun = request.natal_profile.placements.get("sun")
        if sun:
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == sun.sign), None)
            if sign_meta:
                influences.append(self._sun_baseline(sign_meta))
        
        # 2. Moon Sign Baseline (Phase 6B - Emotional Processing)
        moon = request.natal_profile.placements.get("moon")
        if moon:
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == moon.sign), None)
            if sign_meta:
                influences.append(self._moon_baseline(sign_meta, moon))
        
        # 3. ASC (Ascendant) Baseline (Phase 6B - Interface Style)
        asc = request.natal_profile.placements.get("asc")
        if asc:
            sign_meta = next((s for s in CANONICAL_DOMAIN_MODEL.signs if s.sign == asc.sign), None)
            if sign_meta:
                influences.append(self._asc_baseline(sign_meta, asc))
                
        return influences
    
    def _sun_baseline(self, sign_meta: SignMetadata) -> InfluenceResult:
        """Sun sign: Conscious identity and drive"""
        emotion_d = {}
        bias_d = {}
        
        if sign_meta.element == "Fire":
            emotion_d = {"confidence": 0.1, "assertiveness": 0.1}
            bias_d = {"directness_delta": 0.2, "warmth_delta": 0.1}
        elif sign_meta.element == "Earth":
            emotion_d = {"patience": 0.1, "focus": 0.1}
            bias_d = {"caution_delta": 0.2, "formality_delta": 0.1}
        elif sign_meta.element == "Air":
            emotion_d = {"sociability": 0.1, "focus": 0.05}
            bias_d = {"curiosity_delta": 0.2, "verbosity_delta": 0.1}
        elif sign_meta.element == "Water":
            emotion_d = {"empathy": 0.1, "patience": 0.05}
            bias_d = {"warmth_delta": 0.2}
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"sun_{sign_meta.element.lower()}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.8,
            duration_tier="background",
            strength=2.0,
            description=f"Sun in {sign_meta.element} ({sign_meta.sign})",
            evidence={"element": sign_meta.element, "sign": sign_meta.sign}
        )
    
    def _moon_baseline(self, sign_meta: SignMetadata, moon_point) -> InfluenceResult:
        """
        Moon sign: Emotional processing style and needs.
        This is the core emotional nature - how feelings are processed.
        """
        emotion_d = {}
        bias_d = {}
        desc = ""
        
        if sign_meta.element == "Fire":
            # Quick emotional reactions, passionate, needs expression
            emotion_d = {"impulsivity": 0.25, "assertiveness": 0.2, "confidence": 0.1}
            bias_d = {"directness_delta": 0.2}
            desc = "Moon in Fire (Reactive, passionate emotional nature)"
            
        elif sign_meta.element == "Earth":
            # Stable emotions, practical needs, slower processing
            emotion_d = {"patience": 0.3, "calm": 0.25, "focus": 0.1}
            bias_d = {"caution_delta": 0.15}
            desc = "Moon in Earth (Stable, grounded emotional nature)"
            
        elif sign_meta.element == "Air":
            # Intellectual processing, detached, needs communication
            emotion_d = {"focus": 0.2, "sociability": 0.25, "calm": 0.1}
            bias_d = {"verbosity_delta": 0.2, "curiosity_delta": 0.15}
            desc = "Moon in Air (Intellectual, communicative emotional style)"
            
        elif sign_meta.element == "Water":
            # Deep feelings, intuitive, empathic, sensitive
            emotion_d = {"empathy": 0.3, "patience": 0.2, "calm": 0.1}
            bias_d = {"warmth_delta": 0.2}
            desc = "Moon in Water (Deep, intuitive emotional sensitivity)"
        
        # Moon modality adds secondary flavor
        if sign_meta.modality == "Cardinal":
            emotion_d["assertiveness"] = emotion_d.get("assertiveness", 0) + 0.15
            emotion_d["confidence"] = emotion_d.get("confidence", 0) + 0.1
        elif sign_meta.modality == "Fixed":
            emotion_d["patience"] = emotion_d.get("patience", 0) + 0.15
            emotion_d["focus"] = emotion_d.get("focus", 0) + 0.1
        elif sign_meta.modality == "Mutable":
            emotion_d["sociability"] = emotion_d.get("sociability", 0) + 0.15
            bias_d["curiosity_delta"] = bias_d.get("curiosity_delta", 0) + 0.1
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"moon_{sign_meta.element.lower()}_{sign_meta.modality.lower()}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.9,  # Moon is primary emotional indicator
            duration_tier="background",
            strength=3.0,  # Higher than Sun for emotional baseline
            description=desc,
            evidence={"element": sign_meta.element, "modality": sign_meta.modality, "sign": sign_meta.sign}
        )
    
    def _asc_baseline(self, sign_meta: SignMetadata, asc_point) -> InfluenceResult:
        """
        Ascendant: Interface with the world, how you present yourself.
        This affects social interaction style and first impressions.
        """
        emotion_d = {}
        bias_d = {}
        desc = ""
        
        if sign_meta.element == "Fire":
            # Bold, direct presentation, energetic interface
            emotion_d = {"assertiveness": 0.25, "sociability": 0.2, "confidence": 0.15}
            bias_d = {"directness_delta": 0.25}
            desc = "ASC in Fire (Bold, energetic presentation)"
            
        elif sign_meta.element == "Earth":
            # Practical, steady presentation, reserved interface
            emotion_d = {"patience": 0.2, "calm": 0.2, "focus": 0.15}
            bias_d = {"formality_delta": 0.2, "caution_delta": 0.1}
            desc = "ASC in Earth (Practical, steady presentation)"
            
        elif sign_meta.element == "Air":
            # Communicative, friendly presentation, intellectual interface
            emotion_d = {"sociability": 0.3, "focus": 0.15, "confidence": 0.1}
            bias_d = {"verbosity_delta": 0.25, "curiosity_delta": 0.1}
            desc = "ASC in Air (Communicative, intellectual presentation)"
            
        elif sign_meta.element == "Water":
            # Sensitive, empathic presentation, intuitive interface
            emotion_d = {"empathy": 0.25, "sociability": 0.15, "patience": 0.1}
            bias_d = {"warmth_delta": 0.2}
            desc = "ASC in Water (Sensitive, empathic presentation)"
        
        # ASC modality affects approach style
        if sign_meta.modality == "Cardinal":
            # Initiating, proactive
            emotion_d["assertiveness"] = emotion_d.get("assertiveness", 0) + 0.2
            bias_d["directness_delta"] = bias_d.get("directness_delta", 0) + 0.1
        elif sign_meta.modality == "Fixed":
            # Steady, persistent
            emotion_d["patience"] = emotion_d.get("patience", 0) + 0.2
            emotion_d["focus"] = emotion_d.get("focus", 0) + 0.1
        elif sign_meta.modality == "Mutable":
            # Flexible, adaptable
            emotion_d["sociability"] = emotion_d.get("sociability", 0) + 0.15
            bias_d["curiosity_delta"] = bias_d.get("curiosity_delta", 0) + 0.1
            
        return InfluenceResult(
            module_id=self.module_id,
            influence_id=f"asc_{sign_meta.element.lower()}_{sign_meta.modality.lower()}",
            emotion_delta=emotion_d,
            bias_delta=bias_d,
            confidence=0.85,  # ASC is important for interaction style
            duration_tier="background",
            strength=2.5,  # Between Sun and Moon for baseline
            description=desc,
            evidence={"element": sign_meta.element, "modality": sign_meta.modality, "sign": sign_meta.sign}
        )
