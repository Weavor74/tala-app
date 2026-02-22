"""
Astro Engine — Chart Factory

Constructs ``NatalProfile`` charts from raw date + place strings. Pipeline:
  1. Parse ISO date string via ``dateutil``.
  2. Geocode the place name via ``OfflineGeocoder``.
  3. Calculate planetary positions via the ephemeris provider.
  4. Calculate house cusps.
  5. Cache the result for 24 hours via ``ChartCache``.
"""

from datetime import datetime
from typing import Optional
from dateutil import parser
from ..ephemeris.provider import EphemerisProvider
# Standard import dance for Swisseph/Fallback
try:
    from ..ephemeris.swisseph_provider import SwissEphProvider
except ImportError:
    SwissEphProvider = None
from ..ephemeris.fallback_provider import FallbackProvider

from ..schemas.natal import NatalProfile, House
from ..services.house_engine import HouseEngine
from ..services.geocoder import OfflineGeocoder
from ..services.chart_cache import ChartCache
import os

class ChartFactory:
    def __init__(self, ephemeris_path: Optional[str] = None, enable_cache: bool = True):
        # Initialize Ephemeris (Reusing logic from Engine, maybe should be shared singleton)
        self.ephemeris = None
        if os.environ.get("ASTRO_FORCE_FALLBACK"):
             pass
        elif SwissEphProvider:
            try:
                self.ephemeris = SwissEphProvider(ephe_path=ephemeris_path)
            except Exception:
                pass
        
        if self.ephemeris is None:
            self.ephemeris = FallbackProvider()
        
        # Phase 6A: Initialize cache
        self.cache = ChartCache() if enable_cache else None

    def create_chart(self, date_str: str, place_name: str) -> NatalProfile:
        # Phase 6A: Check cache first
        if self.cache:
            cached = self.cache.get(date_str, place_name)
            if cached:
                return cached
        
        # 1. Parse Date
        try:
            dt = parser.parse(date_str)
            if dt.tzinfo is None:
                dt = dt.astimezone() # Assume local system time if not specified? Or UTC? 
                # Ideally user supplies offset, or geocoder implies TZ. MVP = Simplistic.
        except Exception as e:
            raise ValueError(f"Invalid date format: {e}")

        # 2. Geocode
        location = OfflineGeocoder.geocode(place_name)

        # 3. Calculate Positions
        # We need all bodies + angles
        bodies = [
            "sun", "moon", "mercury", "venus", "mars", 
            "jupiter", "saturn", "uranus", "neptune", "pluto",
            "north_node", "asc", "mc"
        ]
        
        placements = self.ephemeris.calculate_positions(dt, location, bodies=bodies)

        # 4. Calculate Houses
        # Ephemeris provider has a calc_houses method, let's use it
        houses = self.ephemeris.calculate_houses(dt, location, house_system="P")

        # 5. Build Profile
        profile = NatalProfile(
            subject_id="generated_subject",
            birth_timestamp=dt,
            birth_location=location,
            placements=placements,
            houses=houses,
            settings={"house_system": "Placidus", "zodiac": "Tropical"}
        )
        
        # Phase 6A: Cache the result
        if self.cache:
            self.cache.put(date_str, place_name, profile)
        
        return profile
