"""
Astro Engine — House Engine

Static utility for house calculations:
  - ``get_house_for_longitude`` — Determine which house a longitude falls in.
  - ``get_angularity_score``    — Score proximity to angular cusps (1/4/7/10).
"""

from typing import List, Tuple, Optional
from ..schemas.natal import NatalProfile, House, ChartPoint

class HouseEngine:
    @staticmethod
    def get_house_for_longitude(longitude: float, houses: List[House]) -> Tuple[int, float]:
        """
        Determines which house a given longitude falls into.
        Returns (house_number, distance_to_cusp).
        
        Handles wrapping 360/0.
        """
        # Ensure houses are sorted by number
        sorted_houses = sorted(houses, key=lambda h: h.number)
        
        n = len(sorted_houses)
        for i in range(n):
            curr_house = sorted_houses[i]
            next_house = sorted_houses[(i + 1) % n]
            
            c1 = curr_house.cup_longitude
            c2 = next_house.cup_longitude
            
            # Normal case: 10 to 40
            if c1 < c2:
                if c1 <= longitude < c2:
                    dist = longitude - c1
                    return curr_house.number, dist
            # Wrap case: 350 to 20
            else:
                if longitude >= c1 or longitude < c2:
                    # distance logic for wrap
                    if longitude >= c1:
                        dist = longitude - c1
                    else:
                        dist = (360 - c1) + longitude
                    return curr_house.number, dist
                    
        # Should not reach here if houses cover 360
        return 1, 0.0

    @staticmethod
    def get_angularity_score(longitude: float, houses: List[House]) -> float:
        """
        Returns a score (0.0 to 1.0) representing angularity.
        1.0 = Exactly on ASC/MC/DSC/IC angles (cusps 1, 10, 7, 4).
        Decays with distance.
        """
        # Identify angular cusps
        angles = {1, 4, 7, 10}
        
        house_num, dist = HouseEngine.get_house_for_longitude(longitude, houses)
        
        # Check proximity to current house start (cusp)
        if house_num in angles:
            # Within 10 degrees of angle
            if dist < 10.0:
                return 1.0 - (dist / 10.0)
                
        # Also check proximity to NEXT house cusp if it's an angle?
        # Typically planets "near end of 12th" are considered conjunct ASC.
        # This requires checking distance to next cusp.
        
        return 0.0
