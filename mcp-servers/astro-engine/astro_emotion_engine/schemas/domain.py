"""
Astro Engine — Domain Model Schemas

Pydantic models that define the canonical astrological domain:
  - ``HouseMetadata``  — House number, name, keywords, themes, polarity.
  - ``SignMetadata``    — Zodiac sign with element, modality, polarity.
  - ``BodyMetadata``   — Celestial body (planet, luminary, angle, node).
  - ``Dignities``      — Essential dignities (domicile, detriment, exaltation, fall).
  - ``AspectMetadata`` — Aspect type with angle, category, and keyword descriptors.
  - ``DomainModel``    — Top-level container assembled by ``config.py``.
"""

from typing import List, Optional, Dict, Literal
from pydantic import BaseModel

class HouseMetadata(BaseModel):
    house: int
    name: str
    keywords: List[str]
    themes: List[str]
    polarity_hint: Optional[str] = None

class SignMetadata(BaseModel):
    sign: str
    index: int
    element: Literal["Fire", "Earth", "Air", "Water"]
    modality: Literal["Cardinal", "Fixed", "Mutable"]
    polarity: Literal["Positive", "Negative"]
    keywords: List[str]

class BodyMetadata(BaseModel):
    id: str
    display_name: str
    type: Literal["planet", "luminary", "angle", "node", "point"]
    keywords: List[str]
    traditional: bool = False

class Dignities(BaseModel):
    domicile: List[str]
    detriment: List[str]
    exaltation: Optional[str] = None
    fall: Optional[str] = None

class AspectMetadata(BaseModel):
    id: str
    angle_degrees: int
    category: Literal["major", "minor"]
    polarity_hint: Optional[Literal["harmonious", "challenging", "neutral"]]
    keywords: List[str]

class DomainModel(BaseModel):
    domain_model_version: str
    houses: List[HouseMetadata]
    signs: List[SignMetadata]
    bodies: List[BodyMetadata]
    rulerships_traditional: Dict[str, str] # sign -> planet_id
    rulerships_modern: Dict[str, str] # sign -> planet_id
    dignities: Dict[str, Dignities] # planet_id -> Dignities
    aspects: List[AspectMetadata]
    default_orbs: Dict[str, float] # aspect_id -> orb
    body_orb_multipliers: Dict[str, float] # body_id -> multiplier
