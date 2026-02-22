"""
Astro Engine — Domain Model Export

Exports the canonical astrological domain model (signs, houses, bodies,
aspects, orbs, dignities) to JSON for external consumption or debugging.
"""

import json
from enum import Enum
from typing import Dict, Any, Literal
from astro_emotion_engine.config import CANONICAL_DOMAIN_MODEL

def export_domain_model_dict() -> Dict[str, Any]:
    """
    Returns the domain model as a dictionary.
    """
    return CANONICAL_DOMAIN_MODEL.model_dump()

def save_domain_model(path: str, format: Literal["json"] = "json") -> None:
    """
    Saves the domain model to a file.
    """
    data = export_domain_model_dict()
    
    if format == "json":
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)
    else:
        raise ValueError(f"Unsupported format: {format}")
