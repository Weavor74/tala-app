# astro_emotion_engine/schemas/ — Data Models

Pydantic models and dataclasses defining the data structures used throughout the astro engine.

---

## Files

| File | Size | Description |
|---|---|---|
| `natal.py` | 2 KB | **Natal Data Schema.** Defines `NatalChart`, `NatalPlanet`, and `NatalHouse` models for representing a parsed birth chart. |
| `domain.py` | 2 KB | **Domain Objects.** Core domain types: `ZodiacSign`, `Planet`, `Aspect`, `HouseSystem` enumerations. |
| `influences.py` | 1 KB | **Influence Schema.** Defines `PlanetaryInfluence` model — the scored output from each planetary module. |
| `response.py` | 720 B | **Response Schema.** Defines the `EmotionalStateResponse` returned by the MCP tool — contains vector, style guide, mood label, and system instructions. |
| `request.py` | 685 B | **Request Schema.** Defines `EmotionalStateRequest` — input model with birth data and optional context prompt. |
| `__init__.py` | — | Package initializer. |
