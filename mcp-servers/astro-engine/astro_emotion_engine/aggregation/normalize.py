"""
Astro Engine — Emotion Vector Normalization

Utility functions for the aggregation stage:
  - ``clamp``                    — Constrain a scalar to [min, max].
  - ``normalize_emotion_vector`` — Clamp all emotion dimensions to [0, 1].
  - ``merge_deltas``             — Apply weighted delta dict onto a base vector in-place.
"""

from typing import Dict

def clamp(val: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(val, max_val))

def normalize_emotion_vector(
    vector: Dict[str, float], 
    min_val: float = 0.0, 
    max_val: float = 1.0
) -> Dict[str, float]:
    """
    Normalizes vector values. 
    A simple approach: Clamp to [0,1].
    
    If inputs are additive deltas, we assume they start from a baseline (0.5?) or accumulate.
    The prompt says '0..1 normalized'.
    
    We'll assume the engine starts with a default baseline (e.g. 0.5) and adds deltas.
    Then we specific clamp.
    """
    return {k: clamp(v, min_val, max_val) for k, v in vector.items()}

def merge_deltas(
    base: Dict[str, float], 
    deltas: Dict[str, float], 
    weight: float = 1.0
) -> Dict[str, float]:
    """
    Destructively updates base by adding delta * weight.
    """
    for k, v in deltas.items():
        if k not in base:
            base[k] = 0.5 # Default start if unknown trait
        base[k] += v * weight
    return base
