"""
Astro Engine — Base Influence Module (ABC)

Abstract base class for all influence modules. Each concrete module
(e.g., ``NatalBaselineModule``, ``MoonPhaseModule``) extends this class
and implements ``compute()`` to produce ``InfluenceResult`` instances.
"""

from abc import ABC, abstractmethod
from typing import List, Optional
from ..schemas.request import EmotionRequest
from ..schemas.influences import InfluenceResult
from ..ephemeris.provider import EphemerisProvider

class BaseInfluenceModule(ABC):
    def __init__(self, ephemeris: Optional[EphemerisProvider] = None):
        self.ephemeris = ephemeris

    @property
    @abstractmethod
    def module_id(self) -> str:
        pass

    @property
    def module_version(self) -> str:
        return "0.1.0"
        
    @abstractmethod
    def compute(self, request: EmotionRequest) -> List[InfluenceResult]:
        """
        Compute influences from this module based on the request.
        """
        pass
