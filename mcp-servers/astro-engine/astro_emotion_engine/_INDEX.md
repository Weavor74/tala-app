# astro_emotion_engine/ — Core Package Source

Main Python package containing all the logic for astrological emotional state computation.

---

## Folders

| Folder | Description |
|---|---|
| `modules/` | **Planetary Modules.** One module per planet/aspect (Moon, Mercury, Venus, Mars, Jupiter, Saturn, outer planets) plus natal baselines, transit aspects, and transit volatility. 13 source files. |
| `services/` | **Core Services.** Chart factory, aspect engine, house engine, geocoder, chart cache, and profile manager. 7 source files. |
| `schemas/` | **Data Models.** Pydantic schemas defining domain objects (natal data, emotional state vectors, influences, API request/response). 6 source files. |
| `ephemeris/` | **Ephemeris Providers.** Abstraction for planetary position calculations — Swiss Ephemeris (primary) with a fallback provider. 4 source files. |
| `aggregation/` | **Score Aggregation.** Normalizes and combines individual planetary influence scores into a final emotional vector. 2 source files. |
| `cli/` | **Command Line Interface.** CLI tool for running calculations outside of MCP. 2 source files. |
| `export/` | **Export Utilities.** JSON schema export for documentation/tooling. 2 source files. |
| `__pycache__/` | Bytecode cache. _Generated._ |

---

## Files

| File | Size | Description |
|---|---|---|
| `engine.py` | 13 KB | **Core Engine.** `AstroEmotionEngine` class — the main calculation pipeline. Takes birth data + current time, runs all planetary modules, aggregates scores, and produces a final `EmotionalState` with style guide and system instructions. |
| `mcp_server.py` | 10 KB | **MCP Server Entry Point.** Registers all MCP tools: `get_emotional_state()`, `create_agent_profile()`, `list_agent_profiles()`, `get_agent_profile()`, `update_agent_profile()`, `delete_agent_profile()`, `get_current_state()`. Runs via `mcp.run(transport='stdio')`. |
| `config.py` | 8 KB | **Configuration.** Global config constants — zodiac signs, planet symbols, aspect orbs, house systems, default parameters. |
| `__init__.py` | 23 B | Package initializer. |
| `agent_profiles.json` | 2 B | Persistent storage for agent natal chart profiles (initially empty `{}`). |
