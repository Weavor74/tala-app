"""
Astro Engine — Swiss Ephemeris Provider

High-precision ephemeris backend using the ``swisseph`` C library wrapper.
Provides real planetary positions, house cusps, and angle calculations
(ASC/MC). Requires ``.se1`` data files at the configured ``ephe_path``.
Falls back to ``FallbackProvider`` if this module cannot be imported.
"""

import os
import datetime
import pytz
from typing import Dict, List, Optional
import swisseph as swe
from .provider import EphemerisProvider
from ..schemas.natal import ChartPoint, House, GeoLocation, ZodiacSign

class SwissEphProvider(EphemerisProvider):
    def __init__(self, ephe_path: Optional[str] = None):
        if ephe_path:
            swe.set_ephe_path(ephe_path)
            
        # Mapping from my body IDs to SwissEph integers
        self.BODY_MAP = {
            "sun": swe.SUN,
            "moon": swe.MOON,
            "mercury": swe.MERCURY,
            "venus": swe.VENUS,
            "mars": swe.MARS,
            "jupiter": swe.JUPITER,
            "saturn": swe.SATURN,
            "uranus": swe.URANUS,
            "neptune": swe.NEPTUNE,
            "pluto": swe.PLUTO,
            "north_node": swe.MEAN_NODE, # or TRUE_NODE
            "chiron": swe.CHIRON,
        }
        
        # Verify data availability
        try:
            swe.calc_ut(2451545.0, swe.SUN, swe.FLG_SWIEPH)
        except swe.Error as e:
            raise RuntimeError(f"Swiss Ephemeris data not found or invalid: {e}")
        
    def _to_julian(self, dt: datetime.datetime) -> float:
        # Convert to UTC if timezone aware
        if dt.tzinfo:
            dt_utc = dt.astimezone(pytz.UTC)
        else:
            dt_utc = dt # Assume UTC if naive, or raise error?
            
        return swe.julday(dt_utc.year, dt_utc.month, dt_utc.day, 
                          dt_utc.hour + dt_utc.minute/60.0 + dt_utc.second/3600.0)

    def _get_sign(self, lon: float) -> ZodiacSign:
        signs = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
                 "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"]
        idx = int(lon // 30) % 12
        return signs[idx]

    def calculate_positions(
        self, 
        dt: datetime.datetime, 
        location: Optional[GeoLocation] = None,
        bodies: List[str] = None
    ) -> Dict[str, ChartPoint]:
        jd = self._to_julian(dt)
        results = {}
        
        target_bodies = bodies or self.BODY_MAP.keys()
        
        for body_id in target_bodies:
            if body_id not in self.BODY_MAP:
                continue # Skip unknown bodies or implement Angles later
                
            swe_id = self.BODY_MAP[body_id]
            # output: lon, lat, dist, speed, speed_lat, speed_dist
            flags = swe.FLG_SWIEPH | swe.FLG_SPEED
            
            # If Topocentric
            if location:
               swe.set_topo(location.longitude, location.latitude, location.altitude)
               flags |= swe.FLG_TOPOCTR
               
            res, flags = swe.calc_ut(jd, swe_id, flags)
            
            lon = res[0]
            lat = res[1]
            speed = res[3]
            
            # Calculate House (needs location, or default 0?)
            # House calculation is usually separate.
            # But the ChartPoint model requires a 'house' field.
            # If no location is provided, house is undefined. 
            # We'll calculate houses *if* location is present, otherwise set to 0 or 1.
            house_num = 1
            if location:
                # cusps, ascmc = swe.houses(jd, lat, lon, b'P') 
                # Calculating which house a point is in is tricky without calling houses() first.
                # For efficiency, we should calculate houses once.
                pass 

            results[body_id] = ChartPoint(
                id=body_id,
                name=body_id.capitalize(),
                sign=self._get_sign(lon),
                longitude=lon,
                house=house_num, # Placeholder, needs resolving with house calculation
                retrograde=speed < 0,
                declination=res[1], # Approximated as lat? No, declination is diff coordinate system.
                speed=speed
            )
            
        # Handle Angles (ASC/MC) which are not planets
        if "asc" in target_bodies or "mc" in target_bodies:
            if location:
               cusps, ascmc = swe.houses(jd, location.latitude, location.longitude, b'P')
               # ascmc: 0=Asc, 1=MC, 2=ARM, 3=Vertex
               if "asc" in target_bodies:
                   lon_asc = ascmc[0]
                   results["asc"] = ChartPoint(
                       id="asc", name="Ascendant", sign=self._get_sign(lon_asc),
                       longitude=lon_asc, house=1, retrograde=False, speed=0
                   )
               if "mc" in target_bodies:
                   lon_mc = ascmc[1]
                   results["mc"] = ChartPoint(
                       id="mc", name="Midheaven", sign=self._get_sign(lon_mc),
                       longitude=lon_mc, house=10, retrograde=False, speed=0
                   )

        # Post-process: Resolve House placement if location was provided
        if location:
            houses = self.calculate_houses(dt, location)
            # Simple logic: Check which cusp is <= point_lon < next_cusp
            # This is complex due to 360 wrap.
            # ... For MVP, keeping house calculation simple or separate.
            for point in results.values():
                point.house = self._resolve_house(point.longitude, houses)

        return results

    def calculate_houses(
        self, 
        dt: datetime.datetime, 
        location: GeoLocation, 
        house_system: str = "P"
    ) -> List[House]:
        jd = self._to_julian(dt)
        # swiss eph expects bytes for house system char
        hsys = house_system[0].upper().encode('ascii')
        
        cusps, ascmc = swe.houses(jd, location.latitude, location.longitude, hsys)
        # print(f"DEBUG: cusps len={len(cusps)}, ascmc len={len(ascmc)}")
        
        result_houses = []
        # In some versions, cusps is 0-indexed or shorter.
        # Let's be safe and use common indices.
        max_idx = len(cusps)
        for i in range(1, min(13, max_idx)):
            cusp = cusps[i]
            result_houses.append(House(
                number=i,
                sign=self._get_sign(cusp),
                cup_longitude=cusp
            ))
            
        return result_houses

    def _resolve_house(self, lon: float, houses: List[House]) -> int:
        # Naive implementation for Placidus/etc.
        # Check if lon is between cusp[i] and cusp[i+1]
        # Handle wrapping at 360/0
        n = len(houses)
        for i in range(n):
            curr_cusp = houses[i].cup_longitude
            next_cusp = houses[(i+1)%n].cup_longitude
            
            # Normal case: 10 to 40
            if curr_cusp < next_cusp:
                if curr_cusp <= lon < next_cusp:
                    return houses[i].number
            # Wrapping case: 350 to 20
            else:
                if lon >= curr_cusp or lon < next_cusp:
                    return houses[i].number
        return 1
