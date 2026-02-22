"""
Astro Engine — Natal Chart Schemas

Core Pydantic models for representing a natal (birth) chart:
  - ``ChartPoint``    — A planetary position with sign, longitude, house, retrograde status.
  - ``AnalysisPoint`` — Extended ``ChartPoint`` with element/modality/dignity for analysis.
  - ``House``         — House cusp with sign and longitude.
  - ``GeoLocation``   — Lat/lon/altitude for birth location.
  - ``ChartSettings`` — Zodiac system (Tropical/Sidereal) and house system.
  - ``NatalProfile``  — Complete birth chart with all placements and houses.

Type aliases: ``ZodiacSign``, ``PlanetName``, ``HouseSystem``.
"""

from datetime import datetime
from typing import List, Optional, Literal, Dict
from pydantic import BaseModel, Field

# --- Enums & Literals ---

ZodiacSign = Literal[
    "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
    "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"
]

PlanetName = Literal[
    "Sun", "Moon", "Mercury", "Venus", "Mars", 
    "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto",
    "North Node", "South Node", "Chiron", "Lilith",
    "Ascendant", "Midheaven"
]

HouseSystem = Literal["Placidus", "Whole Sign", "Equal", "Regiomontanus"]

# --- Components ---

class ChartPoint(BaseModel):
    id: str  # lowercase identifier, e.g., 'sun', 'asc' 
    name: str # Display name
    sign: ZodiacSign
    longitude: float = Field(..., description="Absolute longitude 0-360")
    house: int = Field(..., ge=1, le=12)
    retrograde: bool = False
    declination: Optional[float] = None
    speed: Optional[float] = None

class AnalysisPoint(ChartPoint):
    """Extended point with derived data for analysis"""
    element: Literal["Fire", "Earth", "Air", "Water"]
    modality: Literal["Cardinal", "Fixed", "Mutable"]
    dignity: Optional[Literal["Domicile", "Exaltation", "Detriment", "Fall"]] = None

class House(BaseModel):
    number: int = Field(..., ge=1, le=12)
    sign: ZodiacSign
    cup_longitude: float  # Cusp longitude

class GeoLocation(BaseModel):
    latitude: float
    longitude: float
    altitude: float = 0.0
    place_name: Optional[str] = None

# --- Main Profile ---

class ChartSettings(BaseModel):
    zodiac_system: Literal["Tropical", "Sidereal"] = "Tropical"
    house_system: HouseSystem = "Placidus"
    ayanamsha: Optional[str] = None # For sidereal

class NatalProfile(BaseModel):
    """
    Represents the static baseline astrology of the character.
    """
    subject_id: str
    birth_timestamp: datetime
    birth_location: Optional[GeoLocation] = None
    
    settings: ChartSettings = Field(default_factory=ChartSettings)
    
    # Placements can be pre-calculated or computed on the fly if raw birth data is present
    placements: Dict[str, ChartPoint] = Field(default_factory=dict, description="Map of body_id -> ChartPoint")
    houses: List[House] = Field(default_factory=list)
    
    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }
