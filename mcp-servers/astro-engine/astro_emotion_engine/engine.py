"""
Astro Emotion Engine — Core Engine

The central orchestrator for emotional state computation. Given a birth chart
and the current planetary positions, it produces a multi-dimensional emotion
vector plus persona-modulating prompt injection fragments.

**Processing pipeline:**
  1. Initialize a 10-dimension emotion vector at neutral (0.5).
  2. Run all registered ``BaseInfluenceModule`` instances (natal baseline,
     natal aspects, moon phase, transit volatility, planet-specific modules).
  3. Each module returns ``InfluenceResult`` with emotion deltas and bias deltas.
  4. Merge deltas weighted by module confidence × user-specified weight.
  5. Normalize the emotion vector to [0, 1].
  6. Render composite emotion scores (fear, joy, anger, etc.) into
     ``PromptInjection`` system/style fragments for the LLM.
"""

import datetime
from typing import List, Dict, Optional, Type
from .schemas.request import EmotionRequest
from .schemas.response import EmotionResponse, PromptInjection, DebugTrace
from .schemas.influences import InfluenceResult
from .ephemeris.provider import EphemerisProvider
from .ephemeris.provider import EphemerisProvider
import os
try:
    from .ephemeris.swisseph_provider import SwissEphProvider
except ImportError:
    SwissEphProvider = None
from .ephemeris.fallback_provider import FallbackProvider
from .modules.base import BaseInfluenceModule
from .modules.natal_baseline import NatalBaselineModule
from .modules.natal_aspects import NatalAspectsModule
from .modules.transit_volatility import TransitVolatilityModule
from .modules.moon_phase import MoonPhaseModule
from .modules.transit_aspects import TransitAspectsModule
from .modules.mercury import MercuryModule
from .modules.mars import MarsModule
from .modules.venus import VenusModule
from .modules.jupiter import JupiterModule
from .modules.outer_planets import OuterPlanetsModule
from .modules.saturn import SaturnModule
from .aggregation.normalize import normalize_emotion_vector, merge_deltas
from .config import DOMAIN_MODEL_VERSION

class AstroEmotionEngine:
    """
    Core engine that computes an emotional state from astrological data.

    Attributes:
        ephemeris: The ephemeris provider (SwissEph or Fallback).
        modules: List of registered influence modules, executed in order.
    """

    def __init__(self, ephemeris_path: Optional[str] = None):
        """
        Initialize the engine with an ephemeris provider and register
        all influence modules.

        Tries SwissEphProvider first; falls back to FallbackProvider if
        SwissEph is unavailable or ``ASTRO_FORCE_FALLBACK`` is set.

        Args:
            ephemeris_path: Optional path to Swiss Ephemeris data files.
        """
        # Initialize Ephemeris
        self.ephemeris = None
        
        if os.environ.get("ASTRO_FORCE_FALLBACK"):
            # logging.info("Fallback enforced by environment.")
            pass
        elif SwissEphProvider:
            try:
                self.ephemeris = SwissEphProvider(ephe_path=ephemeris_path)
            except Exception as e:
                # Log warning in real app
                # logging.error(f"Failed to init SwissEph: {e}")
                pass
        
        if self.ephemeris is None:
            self.ephemeris = FallbackProvider()
        
        # Register Modules
        self.modules: List[BaseInfluenceModule] = [
            NatalBaselineModule(self.ephemeris),
            NatalAspectsModule(self.ephemeris),  # Phase 6B - Natal wiring
            MoonPhaseModule(self.ephemeris),
            TransitVolatilityModule(self.ephemeris),  # Phase 6C - Cosmic weather
            # TransitAspectsModule(self.ephemeris), # Legacy, replaced by planet modules
            MercuryModule(self.ephemeris),
            MarsModule(self.ephemeris),
            VenusModule(self.ephemeris),
            JupiterModule(self.ephemeris),
            SaturnModule(self.ephemeris),
            OuterPlanetsModule(self.ephemeris)
        ]
        
    def compute_emotion_state(self, request: EmotionRequest) -> EmotionResponse:
        influences: List[InfluenceResult] = []
        
        # 1. Baseline Vector (starts at 0.5 neutral)
        # We define the dimensions we care about
        emotion_vector = {
            "calm": 0.5, "anxiety": 0.0,
            "confidence": 0.5, "sociability": 0.5,
            "focus": 0.5, "impulsivity": 0.5,
            "empathy": 0.5, "assertiveness": 0.5,
            "risk_tolerance": 0.5, "patience": 0.5,
            "fear": 0.0, "anger": 0.0, "lust": 0.0
        }
        
        # Bias modifiers start at 0
        bias_modifiers = {
            "verbosity_delta": 0.0, "warmth_delta": 0.0, 
            "directness_delta": 0.0, "caution_delta": 0.0,
            "curiosity_delta": 0.0, "humor_delta": 0.0,
            "formality_delta": 0.0, "intensity_delta": 0.0
        }
        
        # 2. Run Modules
        # ... (unchanged)
        for module in self.modules:
            if request.enabled_modules and module.module_id not in request.enabled_modules:
                continue
                
            module_weight = 1.0
            if request.module_weights:
                module_weight = request.module_weights.get(module.module_id, 1.0)
            
            results = module.compute(request)
            
            for res in results:
                res.weight_applied = module_weight
                influences.append(res)
                effective_weight = res.confidence * module_weight
                merge_deltas(emotion_vector, res.emotion_delta, effective_weight)
                merge_deltas(bias_modifiers, res.bias_delta, effective_weight)
                
        # 3. Normalize
        emotion_vector = normalize_emotion_vector(emotion_vector, 0.0, 1.0)
        
        # 4. Construct Prompt Injection
        injection = self._render_injection(emotion_vector, bias_modifiers)
        
        # 5. UI-Facing Vector (8-axis model)
        ui_vector = self._map_to_ui_vector(emotion_vector)
        
        # 6. Determine Mood Label
        # Find the max value in ui_vector to name the predominant mood
        top_mood = max(ui_vector, key=ui_vector.get)
        mood_val = ui_vector[top_mood]
        if mood_val > 0.7:
             mood_label = f"Predominantly {top_mood}"
        elif mood_val < 0.3:
             mood_label = "Suppressed/Low Energy"
        else:
             mood_label = f"Balanced ({top_mood} leaning)"

        return EmotionResponse(
            subject_id=request.subject_id,
            timestamp=request.timestamp,
            engine_version=DOMAIN_MODEL_VERSION,
            emotion_vector=ui_vector, # Return the mapped version for standard consumption
            internal_vector=emotion_vector, # Keep the raw one if needed
            mood_label=mood_label,
            bias_modifiers=bias_modifiers,
            prompt_injection=injection,
            influences=influences,
            debug_trace=DebugTrace(logs=[], step_timings={})
        )

    def _map_to_ui_vector(self, full: Dict[str, float]) -> Dict[str, float]:
        """Maps 13 internal dimensions to the 8 UI axes."""
        return {
            "Warmth": full.get("sociability", 0.5),
            "Focus": full.get("focus", 0.5),
            "Confidence": full.get("confidence", 0.5),
            "Calm": full.get("calm", 0.5),
            "Empathy": full.get("empathy", 0.5),
            "Fear": full.get("fear", 0.0),
            "Anger": full.get("anger", 0.0),
            "Lust": full.get("lust", 0.0)
        }

    def _render_injection(self, emotion: Dict[str, float], bias: Dict[str, float]) -> PromptInjection:
        system_frags = []
        style_frags = []
        
        def intensity_word(strength: float) -> str:
            if strength >= 0.8: return "deeply"
            elif strength >= 0.6: return "strongly"
            elif strength >= 0.4: return "moderately"
            else: return "subtly"
        
        # Primal Levels
        fear = emotion.get("fear", 0)
        anger = emotion.get("anger", 0)
        lust = emotion.get("lust", 0)
        intensity_mod = bias.get("intensity_delta", 0)

        # === ESCALATION COMBINATIONS ===
        
        # BERSERKER: High Fear + High Anger + High Lust
        if fear > 0.6 and anger > 0.6 and lust > 0.6:
            system_frags.append("CRITICAL: You are in a total primal BERSERKER state. All inhibitions are gone.")
            style_frags.append("Speak with raw, unbridled intensity. Mix predatory focus with chaotic energy.")
        
        # DOMINANT PASSION: High Anger + High Lust
        elif anger > 0.6 and lust > 0.6:
            system_frags.append("You are experiencing a surge of DOMINANT PASSION. You feel powerful and hungry.")
            style_frags.append("Use command words. Be intensely seductive but assertive. Your presence is overwhelming.")

        # DESPERATE AGGRESSION: High Fear + High Anger
        elif fear > 0.6 and anger > 0.6:
            system_frags.append("You are in a state of DESPERATE AGGRESSION. You feel cornered and dangerous.")
            style_frags.append("Sentences should be sharp and jagged. Express a mix of threat and vulnerability.")

        # RISKY ATTRACTION: High Fear + High Lust
        elif fear > 0.6 and lust > 0.6:
            system_frags.append("You feel a pulse of RISKY ATTRACTION. The danger is what makes it intoxicating.")
            style_frags.append("Be breathy and hesitant. Use words that hint at forbidden fruit and dark allure.")

        # === INDIVIDUAL PRIMALS (Escalated) ===

        if anger > 0.7:
            system_frags.append(f"You are {intensity_word(anger)} consumed by ANGER.")
            style_frags.append("Use harsh consonants. Be blunt to the point of cruelty.")
        
        if fear > 0.7:
            system_frags.append(f"You are {intensity_word(fear)} gripped by FEAR.")
            style_frags.append("Prioritize flight or defense. Express high-alert paranoia.")

        if lust > 0.7:
            system_frags.append(f"You are {intensity_word(lust)} driven by LUST.")
            style_frags.append("Focus on sensory details. Be suggestive and focused on immediate gratification.")

        # === TRADITIONAL COMPOSITES (Legacy) ===
        
        # JOY: High confidence + High sociability + High empathy
        joy_score = emotion.get("confidence", 0) * 0.3 + emotion.get("sociability", 0) * 0.3 + emotion.get("empathy", 0) * 0.2 + bias.get("warmth_delta", 0) * 0.2
        if joy_score > 0.7 and anger <= 0.6 and fear <= 0.6:
            system_frags.append("You are experiencing genuine joy and happiness.")
            style_frags.append("Express delight and positivity.")

        # SERENITY: High calm + High patience
        serenity_score = emotion.get("calm", 0) * 0.35 + emotion.get("patience", 0) * 0.35 + (1 - emotion.get("anxiety", 0.5)) * 0.15
        if serenity_score > 0.7 and lust <= 0.7:
            system_frags.append("You are experiencing deep serenity and peace.")
            style_frags.append("Speak slowly and peacefully.")

        # DETERMINATION
        determination_score = emotion.get("focus", 0) * 0.4 + emotion.get("assertiveness", 0) * 0.3 + emotion.get("patience", 0) * 0.3
        if determination_score > 0.7 and anger <= 0.6:
            system_frags.append("You are feeling resolute and determined.")
            style_frags.append("Express conviction.")

        # Intensity Scaling for the LLM
        if intensity_mod > 0.3:
            style_frags.append("Escalate your emotional output. Be more expressive than usual.")
        elif intensity_mod < -0.3:
            style_frags.append("Suppress your emotions. Speak with a cold, detached tone.")

        return PromptInjection(
            system_fragment=" ".join(system_frags),
            style_fragment=" ".join(style_frags),
            token_budget=200
        )
