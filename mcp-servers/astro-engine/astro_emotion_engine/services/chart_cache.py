"""
Astro Engine — Chart Cache

In-memory TTL cache for computed ``NatalProfile`` charts. The cache key
is an MD5 hash of ``birth_date|birth_place`` and entries expire after
24 hours by default. Avoids redundant ephemeris re-calculation for the
same birth data.
"""

from typing import Dict, Optional
from datetime import datetime, timedelta
import hashlib
from ..schemas.natal import NatalProfile

class ChartCache:
    """
    Simple in-memory cache for natal charts.
    
    Caches generated charts to avoid recalculation.
    Key = hash(birth_date, birth_place)
    TTL = 24 hours (charts don't change, but may want to refresh for updates)
    """
    
    def __init__(self, ttl_hours: int = 24):
        self._cache: Dict[str, tuple[NatalProfile, datetime]] = {}
        self._ttl = timedelta(hours=ttl_hours)
    
    def _generate_key(self, birth_date: str, birth_place: str) -> str:
        """Generate cache key from birth date + place"""
        combined = f"{birth_date}|{birth_place}".lower()
        return hashlib.md5(combined.encode()).hexdigest()
    
    def get(self, birth_date: str, birth_place: str) -> Optional[NatalProfile]:
        """Get cached chart if exists and not expired"""
        key = self._generate_key(birth_date, birth_place)
        
        if key in self._cache:
            profile, timestamp = self._cache[key]
            
            # Check if expired
            if datetime.now() - timestamp < self._ttl:
                return profile
            else:
                # Expired, remove
                del self._cache[key]
        
        return None
    
    def put(self, birth_date: str, birth_place: str, profile: NatalProfile):
        """Cache a chart"""
        key = self._generate_key(birth_date, birth_place)
        self._cache[key] = (profile, datetime.now())
    
    def clear(self):
        """Clear all cached charts"""
        self._cache.clear()
    
    def stats(self) -> Dict[str, int]:
        """Get cache statistics"""
        return {
            "size": len(self._cache),
            "ttl_hours": int(self._ttl.total_seconds() / 3600)
        }
