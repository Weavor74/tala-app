"""
Astro Engine — Ephemeris Provider (Abstract)

Defines the ``EphemerisProvider`` ABC that all ephemeris backends must implement.
Two methods are required:
  - ``calculate_positions`` — Compute planetary longitudes for a given DateTime.
  - ``calculate_houses``    — Compute house cusps for a given DateTime + location.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Dict, List, Optional
from ..schemas.natal import ChartPoint, House, GeoLocation

class EphemerisProvider(ABC):
    """
    Abstract interface for astrological calculations.
    """
    
    @abstractmethod
    def calculate_positions(
        self, 
        dt: datetime, 
        location: Optional[GeoLocation] = None,
        bodies: List[str] = None
    ) -> Dict[str, ChartPoint]:
        """
        Calculate planetary positions for a given time.
        If location is None, geocentric positions are returned (usually fine for planets, not for houses/Angles).
        """
        pass

    @abstractmethod
    def calculate_houses(
        self, 
        dt: datetime, 
        location: GeoLocation, 
        house_system: str = "P" # P = Placidus
    ) -> List[House]:
        """
        Calculate house cusps. Location is required.
        """
        pass
