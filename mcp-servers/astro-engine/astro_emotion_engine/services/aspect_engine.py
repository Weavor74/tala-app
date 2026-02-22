"""
Astro Engine — Aspect Engine

Static utility for aspect calculations between two ``ChartPoint`` objects.
Determines whether two points form a recognized aspect (conjunction, sextile,
square, trine, opposition, quincunx, etc.) within their allowed orbs, and
returns the aspect type + exact orb distance.
"""

from typing import List, Optional, Tuple
from ..schemas.natal import ChartPoint
from ..schemas.domain import AspectMetadata
from ..config import CANONICAL_DOMAIN_MODEL

class AspectEngine:
    @staticmethod
    def calculate_aspect(
        point_a: ChartPoint, 
        point_b: ChartPoint, 
        domain: Optional[object] = None # can inject domain model for overrides
    ) -> Optional[Tuple[AspectMetadata, float]]:
        """
        Checks if two points are in aspect.
        Returns (AspectMetadata, exact_orb).
        """
        angle = abs(point_a.longitude - point_b.longitude) % 360
        if angle > 180:
            angle = 360 - angle
            
        aspects = CANONICAL_DOMAIN_MODEL.aspects
        best_match = None
        min_orb_diff = 999.0
        
        for aspect in aspects:
            # Determine allowed orb
            base_orb = CANONICAL_DOMAIN_MODEL.default_orbs.get(aspect.id, 5.0)
            
            # Simple multiplier logic
            m1 = CANONICAL_DOMAIN_MODEL.body_orb_multipliers.get(point_a.id, 1.0)
            m2 = CANONICAL_DOMAIN_MODEL.body_orb_multipliers.get(point_b.id, 1.0)
            
            limit = base_orb * ((m1 + m2) / 2.0)
            
            diff = abs(angle - aspect.angle_degrees)
            
            if diff <= limit:
                # Found a match. Is it the tightest? (Rarely overlap, but possible)
                if diff < min_orb_diff:
                    min_orb_diff = diff
                    best_match = (aspect, diff)
                    
        return best_match
    
    @staticmethod
    def get_aspect_strength(orb: float, limit: float) -> float:
        """
        Returns 0.0 to 1.0 (or higher for exact).
        """
        if limit == 0: return 0.0
        if orb > limit: return 0.0
        return 1.0 - (orb / limit)
