"""
Astro Emotion Engine — Domain Configuration

Contains the full astrological domain model definition:
  - **Houses** (1-12): Keywords, themes, and polarity hints.
  - **Signs** (Aries → Pisces): Element, modality, polarity, keywords.
  - **Bodies** (Sun, Moon, planets, angles, nodes): Types and keywords.
  - **Rulerships** (traditional + modern): Sign → ruling body mappings.
  - **Dignities**: Domicile, detriment, exaltation, fall for each body.
  - **Aspects**: Conjunction through quincunx with orbs and categories.
  - **Orb multipliers**: Per-body orb scaling (luminaries wider, outers tighter).

All data is assembled into the ``CANONICAL_DOMAIN_MODEL`` singleton used
by the engine's modules and services.
"""

from .schemas.domain import (
    DomainModel, HouseMetadata, SignMetadata, BodyMetadata, 
    Dignities, AspectMetadata
)

DOMAIN_MODEL_VERSION = "0.1.0"

_HOUSES = [
    HouseMetadata(house=1, name="House 1", keywords=["self", "body", "presence", "approach"], themes=["identity", "first impression", "vitality"], polarity_hint="personal"),
    HouseMetadata(house=2, name="House 2", keywords=["money", "possessions", "skills", "worth"], themes=["security", "ownership", "priorities"]),
    HouseMetadata(house=3, name="House 3", keywords=["speech", "messaging", "siblings", "short travel"], themes=["information flow", "curiosity", "daily logistics"]),
    HouseMetadata(house=4, name="House 4", keywords=["home", "family", "private life", "foundation"], themes=["belonging", "safety", "origin"]),
    HouseMetadata(house=5, name="House 5", keywords=["romance", "play", "art", "performance"], themes=["self-expression", "joy", "risk-for-fun"]),
    HouseMetadata(house=6, name="House 6", keywords=["routine", "labor", "craft", "maintenance"], themes=["competence", "discipline", "wellness habits"]),
    HouseMetadata(house=7, name="House 7", keywords=["partner", "agreements", "rivals", "negotiation"], themes=["reciprocity", "commitment", "boundaries"]),
    HouseMetadata(house=8, name="House 8", keywords=["debt", "inheritance", "intimacy", "transformation"], themes=["trust", "power exchange", "renewal"]),
    HouseMetadata(house=9, name="House 9", keywords=["philosophy", "study", "travel", "meaning"], themes=["worldview", "exploration", "big-picture learning"]),
    HouseMetadata(house=10, name="House 10", keywords=["reputation", "status", "calling", "leadership"], themes=["visibility", "responsibility", "achievement"]),
    HouseMetadata(house=11, name="House 11", keywords=["friends", "groups", "causes", "patrons"], themes=["belonging in communities", "long goals"]),
    HouseMetadata(house=12, name="House 12", keywords=["solitude", "closure", "retreat", "hidden matters"], themes=["surrender", "subconscious patterns", "restoration"]),
]

_SIGNS = [
    SignMetadata(sign="Aries", index=0, element="Fire", modality="Cardinal", polarity="Positive", keywords=["initiate", "bold", "direct"]),
    SignMetadata(sign="Taurus", index=1, element="Earth", modality="Fixed", polarity="Negative", keywords=["steady", "secure", "sensual"]),
    SignMetadata(sign="Gemini", index=2, element="Air", modality="Mutable", polarity="Positive", keywords=["curious", "adaptable", "talkative"]),
    SignMetadata(sign="Cancer", index=3, element="Water", modality="Cardinal", polarity="Negative", keywords=["protective", "home", "feeling"]),
    SignMetadata(sign="Leo", index=4, element="Fire", modality="Fixed", polarity="Positive", keywords=["expressive", "proud", "perform"]),
    SignMetadata(sign="Virgo", index=5, element="Earth", modality="Mutable", polarity="Negative", keywords=["precise", "useful", "refine"]),
    SignMetadata(sign="Libra", index=6, element="Air", modality="Cardinal", polarity="Positive", keywords=["balance", "relate", "negotiate"]),
    SignMetadata(sign="Scorpio", index=7, element="Water", modality="Fixed", polarity="Negative", keywords=["intense", "loyal", "transform"]),
    SignMetadata(sign="Sagittarius", index=8, element="Fire", modality="Mutable", polarity="Positive", keywords=["explore", "meaning", "freedom"]),
    SignMetadata(sign="Capricorn", index=9, element="Earth", modality="Cardinal", polarity="Negative", keywords=["structure", "duty", "climb"]),
    SignMetadata(sign="Aquarius", index=10, element="Air", modality="Fixed", polarity="Positive", keywords=["independent", "systems", "community"]),
    SignMetadata(sign="Pisces", index=11, element="Water", modality="Mutable", polarity="Negative", keywords=["receptive", "dissolve", "dream"]),
]

_BODIES = [
    BodyMetadata(id="sun", display_name="Sun", type="luminary", keywords=["ego", "vitality", "purpose"]),
    BodyMetadata(id="moon", display_name="Moon", type="luminary", keywords=["emotions", "instincts", "needs"]),
    BodyMetadata(id="mercury", display_name="Mercury", type="planet", keywords=["thought", "communication", "logic"]),
    BodyMetadata(id="venus", display_name="Venus", type="planet", keywords=["love", "values", "attraction"]),
    BodyMetadata(id="mars", display_name="Mars", type="planet", keywords=["action", "desire", "aggression"]),
    BodyMetadata(id="jupiter", display_name="Jupiter", type="planet", keywords=["growth", "abundance", "wisdom"]),
    BodyMetadata(id="saturn", display_name="Saturn", type="planet", keywords=["structure", "restriction", "discipline"]),
    BodyMetadata(id="uranus", display_name="Uranus", type="planet", keywords=["innovation", "rebellion", "change"]),
    BodyMetadata(id="neptune", display_name="Neptune", type="planet", keywords=["imagination", "illusion", "spirituality"]),
    BodyMetadata(id="pluto", display_name="Pluto", type="planet", keywords=["power", "metamorphosis", "secrets"]),
    BodyMetadata(id="asc", display_name="Ascendant", type="angle", keywords=["persona", "interface", "appearance"]),
    BodyMetadata(id="mc", display_name="Midheaven", type="angle", keywords=["career", "public image", "legacy"]),
    BodyMetadata(id="north_node", display_name="North Node", type="node", keywords=["destiny", "growth", "challenge"]),
    BodyMetadata(id="south_node", display_name="South Node", type="node", keywords=["past", "comfort", "release"]),
]

_RULERSHIPS_TRADITIONAL = {
    "Aries": "mars", "Taurus": "venus", "Gemini": "mercury", "Cancer": "moon", 
    "Leo": "sun", "Virgo": "mercury", "Libra": "venus", "Scorpio": "mars", 
    "Sagittarius": "jupiter", "Capricorn": "saturn", "Aquarius": "saturn", "Pisces": "jupiter"
}

_RULERSHIPS_MODERN = {
    "Aries": "mars", "Taurus": "venus", "Gemini": "mercury", "Cancer": "moon", 
    "Leo": "sun", "Virgo": "mercury", "Libra": "venus", "Scorpio": "pluto", 
    "Sagittarius": "jupiter", "Capricorn": "saturn", "Aquarius": "uranus", "Pisces": "neptune"
}

_DIGNITIES = {
    "sun": Dignities(domicile=["Leo"], detriment=["Aquarius"], exaltation="Aries", fall="Libra"),
    "moon": Dignities(domicile=["Cancer"], detriment=["Capricorn"], exaltation="Taurus", fall="Scorpio"),
    "mercury": Dignities(domicile=["Gemini", "Virgo"], detriment=["Sagittarius", "Pisces"], exaltation="Virgo", fall="Pisces"),
    "venus": Dignities(domicile=["Taurus", "Libra"], detriment=["Scorpio", "Aries"], exaltation="Pisces", fall="Virgo"),
    "mars": Dignities(domicile=["Aries", "Scorpio"], detriment=["Libra", "Taurus"], exaltation="Capricorn", fall="Cancer"),
    "jupiter": Dignities(domicile=["Sagittarius", "Pisces"], detriment=["Gemini", "Virgo"], exaltation="Cancer", fall="Capricorn"),
    "saturn": Dignities(domicile=["Capricorn", "Aquarius"], detriment=["Cancer", "Leo"], exaltation="Libra", fall="Aries"),
}

_ASPECTS = [
    AspectMetadata(id="conjunction", angle_degrees=0, category="major", polarity_hint="neutral", keywords=["fusion", "intensity", "focus"]),
    AspectMetadata(id="opposition", angle_degrees=180, category="major", polarity_hint="challenging", keywords=["tension", "balance", "awareness"]),
    AspectMetadata(id="trine", angle_degrees=120, category="major", polarity_hint="harmonious", keywords=["flow", "ease", "talent"]),
    AspectMetadata(id="square", angle_degrees=90, category="major", polarity_hint="challenging", keywords=["action", "crisis", "building"]),
    AspectMetadata(id="sextile", angle_degrees=60, category="major", polarity_hint="harmonious", keywords=["opportunity", "cooperation", "ideas"]),
]

_DEFAULT_ORBS = {
    "conjunction": 8.0,
    "opposition": 8.0,
    "trine": 7.0,
    "square": 7.0,
    "sextile": 5.0
}

_BODY_ORB_MULTIPLIERS = {
    "sun": 1.2, "moon": 1.2, 
    "mercury": 1.0, "venus": 1.0, "mars": 1.0,
    "jupiter": 0.9, "saturn": 0.9,
    "uranus": 0.8, "neptune": 0.8, "pluto": 0.8,
    "asc": 1.1, "mc": 1.1, "north_node": 0.9, "south_node": 0.9
}

CANONICAL_DOMAIN_MODEL = DomainModel(
    domain_model_version=DOMAIN_MODEL_VERSION,
    houses=_HOUSES,
    signs=_SIGNS,
    bodies=_BODIES,
    rulerships_traditional=_RULERSHIPS_TRADITIONAL,
    rulerships_modern=_RULERSHIPS_MODERN,
    dignities=_DIGNITIES,
    aspects=_ASPECTS,
    default_orbs=_DEFAULT_ORBS,
    body_orb_multipliers=_BODY_ORB_MULTIPLIERS
)
