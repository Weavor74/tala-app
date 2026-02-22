# astro_emotion_engine/ephemeris/ — Planetary Position Providers

Abstraction layer for computing planetary positions at a given date/time. The primary provider uses Swiss Ephemeris (`pyswisseph`); a fallback provider uses simplified calculations.

---

## Files

| File | Size | Description |
|---|---|---|
| `swisseph_provider.py` | 7 KB | **Swiss Ephemeris Provider.** High-precision planetary position calculations using the `pyswisseph` library. Returns ecliptic longitude, latitude, and speed for all classical and modern planets. |
| `fallback_provider.py` | 2 KB | **Fallback Provider.** Simplified approximation for planetary positions when `pyswisseph` is unavailable. Uses basic orbital period calculations. |
| `provider.py` | 1 KB | **Provider Interface.** Abstract base class defining the `get_planet_position(planet, datetime)` contract. |
| `__init__.py` | — | Package initializer. |
