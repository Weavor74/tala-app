# astro_emotion_engine/services/ — Core Services

Internal services used by the engine for chart computation, caching, and profile management.

---

## Files

| File | Size | Description |
|---|---|---|
| `profile_manager.py` | 8 KB | **Profile Manager.** CRUD operations for agent natal profiles stored in `agent_profiles.json`. Handles creation, retrieval, update, deletion, and validation of birth data. |
| `chart_factory.py` | 3 KB | **Chart Factory.** Creates natal and transit chart objects from birth data and timestamps. Coordinates the ephemeris provider and geocoder. |
| `house_engine.py` | 2 KB | **House Engine.** Calculates astrological house positions (Placidus, Whole Sign) for a given chart. |
| `aspect_engine.py` | 2 KB | **Aspect Engine.** Detects angular aspects (conjunction, sextile, square, trine, opposition) between two planetary positions within configured orbs. |
| `chart_cache.py` | 2 KB | **Chart Cache.** LRU cache for computed chart data to avoid redundant ephemeris calculations. |
| `geocoder.py` | 2 KB | **Geocoder.** Converts city names to latitude/longitude coordinates for chart calculation. Uses a built-in city database. |
| `__init__.py` | — | Package initializer. |
