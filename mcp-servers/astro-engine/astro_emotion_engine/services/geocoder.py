"""
Astro Engine — Offline Geocoder

Simple offline geocoder that maps common city names to ``(lat, lon)``
coordinates. Contains a hardcoded lookup table of ~20 major cities
for MVP use. Falls back to ``(0.0, 0.0)`` for unknown locations.
"""

from typing import Tuple, Optional
from ..schemas.natal import GeoLocation

class OfflineGeocoder:
    """
    Simple offline geocoder for MVP.
    Maps common city names to (lat, lon).
    """
    
    # Simple dataset for major cities
    CITIES = {
        "london": (51.5074, -0.1278),
        "new york": (40.7128, -74.0060),
        "los angeles": (34.0522, -118.2437),
        "tokyo": (35.6762, 139.6503),
        "paris": (48.8566, 2.3522),
        "berlin": (52.5200, 13.4050),
        "mumbai": (19.0760, 72.8777),
        "sydney": (-33.8688, 151.2093),
        "moscow": (55.7558, 37.6173),
        "cairo": (30.0444, 31.2357),
        "beijing": (39.9042, 116.4074),
        "sao paulo": (-23.5505, -46.6333),
        "delhi": (28.6139, 77.2090),
        "istanbul": (41.0082, 28.9784),
        "san francisco": (37.7749, -122.4194),
        "chicago": (41.8781, -87.6298),
        "toronto": (43.6532, -79.3832),
        "singapore": (1.3521, 103.8198),
        "dubai": (25.2048, 55.2708),
        "default": (0.0, 0.0)
    }

    @staticmethod
    def geocode(place_name: str) -> GeoLocation:
        key = place_name.lower().strip()
        coords = OfflineGeocoder.CITIES.get(key)
        
        if not coords:
            # Fallback for MVP simplicity
            # In a real app, use a real geocoder or larger DB
            # logging.warning(f"Unknown city '{place_name}'. Using Default (0,0).")
            coords = (0.0, 0.0)
            
        return GeoLocation(
            latitude=coords[0],
            longitude=coords[1],
            place_name=place_name
        )
