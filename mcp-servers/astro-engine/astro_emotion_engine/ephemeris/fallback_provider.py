"""
Astro Engine — Fallback Ephemeris Provider

A simple deterministic provider that returns pseudo-random planetary positions
based on timestamp hashing. Used when Swiss Ephemeris (``swisseph``) is
unavailable or when ``ASTRO_FORCE_FALLBACK`` is set. Suitable for testing
and development but NOT for accurate astrological calculations.
"""

import datetime
from typing import Dict, List, Optional
from .provider import EphemerisProvider
from ..schemas.natal import ChartPoint, House, GeoLocation

class FallbackProvider(EphemerisProvider):
    """
    A simplified fallback provider that returns dummy or low-precision positions.
    Useful for testing or when Swiss Ephemeris is unavailable.
    """
    
    def calculate_positions(
        self, 
        dt: datetime.datetime, 
        location: Optional[GeoLocation] = None,
        bodies: List[str] = None
    ) -> Dict[str, ChartPoint]:
        # Return dummy positions for testing
        # In a real fallback, this might implement analytical low-precision algorithms.
        
        results = {}
        bodies = bodies or ["sun", "moon", "mars", "venus", "mercury", "jupiter", "saturn"]
        
        # Consistent dummy values based on time (simple hash) to allow deterministic testing
        seed = dt.timestamp()
        
        for i, body in enumerate(bodies):
            # Generate a pseudo-random longitude 0-360
            lon = (seed / 1000.0 + i * 30) % 360
            
            # Sign
            signs = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                 "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"]
            sign_idx = int(lon // 30) % 12
            
            results[body] = ChartPoint(
                id=body,
                name=body.capitalize(),
                sign=signs[sign_idx],
                longitude=lon,
                house=(i % 12) + 1,
                retrograde=False,
                speed=1.0
            )
            
        return results

    def calculate_houses(
        self, 
        dt: datetime.datetime, 
        location: GeoLocation, 
        house_system: str = "P"
    ) -> List[House]:
        # Return Equal houses starting at 0 for simplicity
        houses = []
        signs = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                 "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"]
        
        start_lon = 0.0 # Ascendant 0 Aries
        for i in range(12):
            cusp = (start_lon + i * 30) % 360
            sign_idx = int(cusp // 30) % 12
            houses.append(House(
                number=i + 1,
                sign=signs[sign_idx],
                cup_longitude=cusp
            ))
        return houses
